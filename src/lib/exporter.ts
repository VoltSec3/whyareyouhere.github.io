import type JSZip from "jszip";
import { toast } from "sonner";

import { CATEGORIES, type PackMeta, type StoredSound } from "./types";

export type PackInput = {
  meta: PackMeta;
  sounds: StoredSound[];
  noise: { wav: ArrayBuffer; duration: number } | null;
};

export const PACK_SUFFIX = "CutItQuik";

/** `<Creator>-CutItQuik` — creator falls back to the pack title when left blank. */
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

export async function buildPack(input: PackInput): Promise<JSZip> {
  // Loaded on demand: the zip library is only needed when exporting, so keeping
  // it out of the entry chunk roughly a third off the initial download.
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const grouped = groupByCategory(input.sounds);

  zip.file("readme.txt", buildReadme(input.meta));

  if (input.noise?.wav?.byteLength) {
    zip.file("noise.wav", input.noise.wav);
  }

  for (const category of CATEGORIES) {
    const folder = zip.folder(category.id);
    if (!folder) continue;
    const bucket = grouped.get(category.id) ?? [];
    bucket.forEach((sound, index) => {
      folder.file(`${index + 1}.wav`, sound.wav);
    });
  }

  return zip;
}

export async function exportPack(input: PackInput): Promise<{ fileName: string; size: number }> {
  if (input.sounds.length === 0) {
    throw new Error("Save at least one click or release before exporting.");
  }

  const zip = await buildPack(input);
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const fileName = packFileName(input.meta);
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

export function notifyExported(fileName: string, size: number) {
  toast.success("Clickpack exported", {
    description: `${fileName} · ${(size / 1024).toFixed(0)} KB`,
  });
}

export function notifyExportFailed(message: string) {
  toast.error("Export failed", { description: message });
}
