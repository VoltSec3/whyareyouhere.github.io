import type JSZip from "jszip";

import { buildNoiseShape, denoiseSamples, type DenoiseMethod, type NoiseShape } from "./audio/denoise";
import { decodeWav, encodeWav } from "./audio/wav";
import { MENU_CATEGORIES, type MenuSoundId, type StoredMenuSound } from "./menusounds";
import {
  zcbLayout,
  zcbRootName,
  zcbTierFolder,
  ZCB_MENU_ROOT,
  type ZcbLayoutId,
} from "./zcb";
import { CATEGORIES, type PackMeta, type StoredSound } from "./types";

export type DenoiseConfig = {
  method: DenoiseMethod;
};

/**
 * `generic` writes a flat folder tree that any loader can walk. `zcb` writes the
 * slot-per-player tree that ZCB Live for Geode expects.
 */
export type ExportTarget = "generic" | "zcb";

export type ExportProgress = {
  /** 0..1 across the whole export. */
  value: number;
  /** Coarse phase, e.g. "Denoising". */
  step: string;
  /** What is happening right now. */
  detail: string;
};

export type OnExportProgress = (progress: ExportProgress) => void;

export type PackInput = {
  meta: PackMeta;
  sounds: StoredSound[];
  /**
   * Menu sounds, written to their own folder outside the slot tree. Optional, and
   * independent of `sounds`: a pack can ship menu sounds with no gameplay tiers
   * and the other way round.
   */
  menuSounds?: StoredMenuSound[];
  noise: { wav: ArrayBuffer; duration: number } | null;
  /** Omit or null to export the clips untouched. */
  denoise?: DenoiseConfig | null;
  /** Defaults to `generic`. */
  target?: ExportTarget;
  /** Only read when `target` is `zcb`. */
  zcbLayout?: ZcbLayoutId;
};

export type BuildOptions = {
  onProgress?: OnExportProgress;
};

export const PACK_SUFFIX = "CutItQuik";

/** Progress weighting: denoising dominates, zipping is cheap. */
const DENOISE_START = 0.02;
const DENOISE_SPAN = 0.68;
const PACK_START = 0.72;
const PACK_SPAN = 0.06;
const ZIP_START = 0.78;

/** `<Creator>-CutItQuik` - creator falls back to the pack title when left blank. */
export function packFileName(meta: PackMeta, target: ExportTarget = "generic"): string {
  if (target === "zcb") {
    // Named after the folder the zip expands into, so the install step is
    // obvious: unzip, and the result is already the name ZCB will show.
    return `${zcbRootName(meta.title)}-ZCB.zip`;
  }
  const raw = (meta.creator.trim() || meta.title.trim() || "untitled")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${raw || "untitled"}-${PACK_SUFFIX}.zip`;
}

export function buildReadme(meta: PackMeta): string {
  const title = meta.title.trim() || "Untitled Clickpack";
  const description = meta.description.trim();
  return description ? `${title}\n\n${description}\n` : `${title}\n`;
}

/** The readme a ZCB pack ships with, including how to actually install it. */
export function buildZcbReadme(
  meta: PackMeta,
  layoutId: ZcbLayoutId,
  menuCounts?: Record<string, number>,
): string {
  const layout = zcbLayout(layoutId);
  const title = meta.title.trim() || "Untitled Clickpack";
  const description = meta.description.trim();
  const slots = layout.slots.join(", ");
  const menuTotal = Object.values(menuCounts ?? {}).reduce((sum, n) => sum + n, 0);

  return [
    title,
    "",
    description,
    "",
    "Built with CutItQuik for ZCB Live.",
    "",
    "Install",
    "  1. Unzip this archive.",
    "  2. Move the resulting folder into the .zcb/clickpacks folder next to your",
    "     Geometry Dash executable.",
    "  3. In ZCB Live, open Clickpack > Select clickpack and pick it from the list.",
    "",
    `Layout: ${layout.label} (${slots})`,
    "Format: 48 kHz, mono, 16-bit PCM WAV. No manifest is needed; ZCB reads the",
    "folder name as the pack name.",
    menuTotal > 0
      ? [
          "",
          `Menu sounds: ${MENU_CATEGORIES.filter((c) => (menuCounts?.[c.id] ?? 0) > 0)
            .map((c) => `${c.label} x${menuCounts![c.id]}`)
            .join(", ")}`,
          "  In ZCB, open Audio and turn Menu sounds on. The toggle is greyed out",
          "  when the pack has none, so a missing folder shows up there rather than",
          "  as silence.",
          "  Escape plays from anywhere, menu clicks only outside a level, and typing",
          "  only while you are typing. Typing sounds overlap instead of cutting",
          "  each other off, so a fast typist hears a chord rather than one click.",
        ].join("\n")
      : "",
    "",
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");
}

function groupByCategory(sounds: StoredSound[]) {
  const grouped = new Map<string, StoredSound[]>();
  for (const category of CATEGORIES) grouped.set(category.id, []);
  for (const sound of sounds) {
    const bucket = grouped.get(sound.category);
    if (bucket) bucket.push(sound);
  }
  for (const bucket of grouped.values()) {
    bucket.sort((a, b) => a.createdAt - b.createdAt);
  }
  return grouped;
}

/**
 * The noise file is profiled once, not per clip: it can be 60 s long, and every
 * clip would otherwise repeat the same FFT pass.
 */
async function prepareNoiseShape(
  input: PackInput,
  onProgress?: OnExportProgress,
): Promise<NoiseShape | null> {
  if (input.denoise?.method !== "spectral") return null;
  if (!input.noise?.wav?.byteLength) return null;

  onProgress?.({ value: 0.01, step: "Preparing", detail: "analysing the noise file" });
  const decoded = decodeWav(input.noise.wav);
  if (!decoded) return null;
  return buildNoiseShape(decoded.samples);
}

async function denoiseClips(
  input: PackInput,
  noiseShape: NoiseShape | null,
  onProgress?: OnExportProgress,
): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>();
  const method = input.denoise!.method;
  const total = input.sounds.length;

  for (let index = 0; index < total; index++) {
    const sound = input.sounds[index]!;
    const position = `${index + 1} of ${total}`;
    const report = (fraction: number) =>
      onProgress?.({
        value: DENOISE_START + DENOISE_SPAN * ((index + fraction) / total),
        step: "Denoising",
        detail: `${sound.name} · ${position}`,
      });

    report(0);
    const decoded = decodeWav(sound.wav);
    if (!decoded) {
      // Unreadable clip: ship it as-is rather than dropping it from the pack.
      result.set(sound.id, new Uint8Array(sound.wav));
      continue;
    }

    const clean = await denoiseSamples(decoded.samples, {
      method,
      noiseShape,
      sampleRate: decoded.sampleRate,
      // The clip was peak-normalised on the way into the library, so the noise
      // file has to be compared against the pre-normalisation level.
      storedGain: sound.gain,
      onProgress: report,
    });
    result.set(sound.id, encodeWav(clean, decoded.sampleRate));
  }

  return result;
}

export async function buildPack(input: PackInput, options: BuildOptions = {}): Promise<JSZip> {
  const { onProgress } = options;
  const target: ExportTarget = input.target ?? "generic";

  // Loaded on demand: the zip library is only needed when exporting, so keeping
  // it out of the entry chunk roughly a third off the initial download.
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const grouped = groupByCategory(input.sounds);

  const noiseShape = await prepareNoiseShape(input, onProgress);
  const cleaned = input.denoise ? await denoiseClips(input, noiseShape, onProgress) : null;

  // ZCB names the pack after its root folder and expects a slot per player, so
  // everything moves down one level. The generic target stays flat.
  const layout = target === "zcb" ? zcbLayout(input.zcbLayout ?? "all") : null;
  const root = layout ? zcbRootName(input.meta.title) : "";
  const prefix = layout ? `${root}/` : "";
  const slots = layout ? layout.slots : [null];

  onProgress?.({
    value: PACK_START,
    step: "Packing",
    detail: layout ? `writing ${root}/readme.txt` : "writing readme.txt",
  });
  zip.file(
    `${prefix}readme.txt`,
    layout
      ? buildZcbReadme(input.meta, layout.id, menuCounts(input.menuSounds))
      : buildReadme(input.meta),
  );

  if (input.noise?.wav?.byteLength) {
    zip.file(`${prefix}noise.wav`, input.noise.wav);
  }

  const written: { path: string; detail: string }[] = [];
  for (const slot of slots) {
    for (const category of CATEGORIES) {
      const path = slot ? `${root}/${slot}/${zcbTierFolder(category.id)}` : category.id;
      const folder = zip.folder(path);
      if (!folder) continue;
      const bucket = grouped.get(category.id) ?? [];
      bucket.forEach((sound, index) => {
        const entry = `${index + 1}.wav`;
        const bytes = cleaned?.get(sound.id) ?? new Uint8Array(sound.wav);
        folder.file(entry, bytes);
        written.push({ path: `${path}/${entry}`, detail: `adding ${path}/${entry}` });
      });
    }
  }

  // Menu sounds are written untouched, even when the gameplay tiers are being
  // denoised. The denoiser protects a click body in its first 15 ms and then
  // gates hard against the noise profile, which is tuned for a normalised click
  // against room tone. A menu sound is normalised as a whole category rather
  // than per clip, so its level is already relative to its neighbours and the
  // same gate would either leave it alone or eat its tail. The recorder cuts to
  // the quiet after the attack already, so there is not much room tone to remove.
  const menuPath = `${prefix}${ZCB_MENU_ROOT}`;
  for (const category of MENU_CATEGORIES) {
    const bucket = (input.menuSounds ?? [])
      .filter((sound) => sound.category === category.id)
      .sort((a, b) => a.createdAt - b.createdAt);
    if (bucket.length === 0) continue;
    const folder = zip.folder(`${menuPath}/${category.folder}`);
    if (!folder) continue;
    bucket.forEach((sound, index) => {
      const entry = `${index + 1}.wav`;
      folder.file(entry, new Uint8Array(sound.wav));
      written.push({
        path: `${menuPath}/${category.folder}/${entry}`,
        detail: `adding ${menuPath}/${category.folder}/${entry}`,
      });
    });
  }

  for (let i = 0; i < written.length; i++) {
    onProgress?.({
      value: PACK_START + PACK_SPAN * ((i + 1) / Math.max(1, written.length)),
      step: "Packing",
      detail: written[i]!.detail,
    });
  }

  return zip;
}

export async function exportPack(
  input: PackInput,
  options: BuildOptions = {},
): Promise<{ fileName: string; size: number }> {
  // Either half is enough on its own. A pack of pure menu sounds is a real thing
  // someone might want, and a gameplay tier with nothing in `menusounds` is the
  // common case.
  if (input.sounds.length === 0 && (input.menuSounds?.length ?? 0) === 0) {
    throw new Error("Save at least one clip, or record some menu sounds, before exporting.");
  }

  const { onProgress } = options;
  const target: ExportTarget = input.target ?? "generic";
  const zip = await buildPack(input, options);
  const fileName = packFileName(input.meta, target);

  onProgress?.({ value: ZIP_START, step: "Compressing", detail: "deflating entries" });
  const blob = await zip.generateAsync(
    {
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    },
    (meta) => {
      onProgress?.({
        value: ZIP_START + (1 - ZIP_START) * (meta.percent / 100),
        step: "Compressing",
        detail: `${Math.round(meta.percent)}% of the archive`,
      });
    },
  );

  onProgress?.({ value: 1, step: "Finishing", detail: `saving ${fileName}` });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  return { fileName, size: blob.size };
}

export function exportSummary(input: PackInput) {
  const counts = CATEGORIES.map((category) => ({
    category,
    count: input.sounds.filter((sound) => sound.category === category.id).length,
  }));
  const target: ExportTarget = input.target ?? "generic";
  const layout = target === "zcb" ? zcbLayout(input.zcbLayout ?? "all") : null;
  return {
    counts,
    total: input.sounds.length,
    hasNoise: !!input.noise?.wav?.byteLength,
    target,
    layout,
    /** How many copies of the library the zip ends up holding. */
    slotCount: layout?.slots.length ?? 1,
    root: layout ? zcbRootName(input.meta.title) : null,
    menuSounds: menuCounts(input.menuSounds),
  };
}

function menuCounts(list?: readonly StoredMenuSound[]): Record<MenuSoundId, number> {
  const map = Object.fromEntries(MENU_CATEGORIES.map((c) => [c.id, 0])) as Record<
    MenuSoundId,
    number
  >;
  for (const sound of list ?? []) {
    if (sound.category in map) map[sound.category as MenuSoundId]++;
  }
  return map;
}
