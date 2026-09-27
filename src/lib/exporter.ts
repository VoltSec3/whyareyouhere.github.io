import type JSZip from "jszip";

import { buildNoiseShape, denoiseSamples, type DenoiseMethod, type NoiseShape } from "./audio/denoise";
import { decodeWav, encodeWav } from "./audio/wav";
import { CATEGORIES, type PackMeta, type StoredSound } from "./types";

export type DenoiseConfig = {
  method: DenoiseMethod;
};

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
  noise: { wav: ArrayBuffer; duration: number } | null;
  /** Omit or null to export the clips untouched. */
  denoise?: DenoiseConfig | null;
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
export function packFileName(meta: PackMeta): string {
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

  // Loaded on demand: the zip library is only needed when exporting, so keeping
  // it out of the entry chunk roughly a third off the initial download.
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const grouped = groupByCategory(input.sounds);

  const noiseShape = await prepareNoiseShape(input, onProgress);
  const cleaned = input.denoise ? await denoiseClips(input, noiseShape, onProgress) : null;

  onProgress?.({ value: PACK_START, step: "Packing", detail: "writing readme.txt" });
  zip.file("readme.txt", buildReadme(input.meta));

  if (input.noise?.wav?.byteLength) {
    zip.file("noise.wav", input.noise.wav);
  }

  const written: { path: string; detail: string }[] = [];
  for (const category of CATEGORIES) {
    const folder = zip.folder(category.id);
    if (!folder) continue;
    const bucket = grouped.get(category.id) ?? [];
    bucket.forEach((sound, index) => {
      const path = `${category.id}/${index + 1}.wav`;
      const bytes = cleaned?.get(sound.id) ?? new Uint8Array(sound.wav);
      folder.file(`${index + 1}.wav`, bytes);
      written.push({ path, detail: `adding ${path}` });
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
  if (input.sounds.length === 0) {
    throw new Error("Save at least one click or release before exporting.");
  }

  const { onProgress } = options;
  const zip = await buildPack(input, options);
  const fileName = packFileName(input.meta);

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
  return {
    counts,
    total: input.sounds.length,
    hasNoise: !!input.noise?.wav?.byteLength,
  };
}
