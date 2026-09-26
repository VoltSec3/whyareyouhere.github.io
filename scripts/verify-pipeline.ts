/* Headless verification of the cut + export pipeline against the SD1 reference. */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import { cutSegment, DEFAULT_CUT_OPTIONS, computePeaks } from "../src/lib/audio/process";
import { encodeWav, resample, TARGET_SAMPLE_RATE } from "../src/lib/audio/wav";
import { buildPack, buildReadme, packFileName } from "../src/lib/exporter";
import type { PackMeta, StoredSound } from "../src/lib/types";

const RATE = TARGET_SAMPLE_RATE;
const results: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

/* ---------- build a synthetic take: 8 clicks + room noise ---------- */
const duration = 6;
const take = new Float32Array(RATE * duration);
for (let i = 0; i < take.length; i++) take[i] = (Math.random() * 2 - 1) * 0.004; // room tone

const eventTimes = [0.5, 1.1, 1.85, 2.4, 3.05, 3.7, 4.3, 5.2];
for (const [index, t] of eventTimes.entries()) {
  const start = Math.round(t * RATE);
  // A realistic mechanical click: sharp transient plus a short body ring.
  const tau = 0.018 + index * 0.004;
  const amp = 0.12 + index * 0.07;
  for (let n = 0; n < RATE * 0.3; n++) {
    const env = Math.exp(-n / (RATE * tau));
    take[start + n] += Math.sin((2 * Math.PI * 2400 * n) / RATE) * env * amp;
    take[start + n] += (Math.random() * 2 - 1) * env * amp * 0.4;
  }
}

const peaks = computePeaks(take, 2000);
check("waveform peaks computed", peaks.length === 2000);

/* ---------- cutting ---------- */
const sounds: StoredSound[] = [];
const categories = [
  "microclicks",
  "microreleases",
  "softclicks",
  "softreleases",
  "clicks",
  "releases",
  "hardclicks",
  "hardreleases",
] as const;

eventTimes.forEach((t, index) => {
  const cut = cutSegment(take, RATE, t - 0.05, t + 0.35, {
    ...DEFAULT_CUT_OPTIONS,
    sampleRate: RATE,
  });
  if (!cut) {
    check(`cut ${index}`, false, "cutSegment returned null");
    return;
  }
  const wav = encodeWav(cut.samples, RATE);
  sounds.push({
    id: `s${index}`,
    category: categories[index % categories.length],
    name: `clip ${index}`,
    sourceStart: cut.start,
    sourceEnd: cut.end,
    duration: cut.samples.length / RATE,
    peak: cut.peakBefore,
    gain: cut.gain,
    createdAt: index,
    wav: wav.buffer as ArrayBuffer,
  });
});

// Two extra clips in one category so the numbering check has something to chew on.
for (const extra of [0.72, 1.42]) {
  const cut = cutSegment(take, RATE, extra - 0.05, extra + 0.35, {
    ...DEFAULT_CUT_OPTIONS,
    sampleRate: RATE,
  })!;
  sounds.push({
    id: `x${extra}`,
    category: "clicks",
    name: `extra ${extra}`,
    sourceStart: cut.start,
    sourceEnd: cut.end,
    duration: cut.samples.length / RATE,
    peak: cut.peakBefore,
    gain: cut.gain,
    createdAt: 100 + extra,
    wav: encodeWav(cut.samples, RATE).buffer as ArrayBuffer,
  });
}

check("every event produced a clip", sounds.length === eventTimes.length + 2);
check(
  "clips land in the 0.05s–1.2s window",
  sounds.every((s) => s.duration >= 0.05 && s.duration <= 1.2),
  sounds.map((s) => s.duration.toFixed(3)).join(" "),
);
check(
  "clips are click-length, not padded to the ceiling",
  sounds.every((s) => s.duration < 0.75),
  `longest ${Math.max(...sounds.map((s) => s.duration)).toFixed(3)}s`,
);

function peakOf(wav: ArrayBuffer) {
  const view = new DataView(wav);
  const dataSize = view.getUint32(40, true);
  let peak = 0;
  for (let o = 44; o < 44 + dataSize; o += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(o, true)) / 32768);
  }
  return peak;
}
const peaksOut = sounds.map((s) => peakOf(s.wav));
check(
  "clips normalised to a consistent peak",
  peaksOut.every((p) => p > 0.85 && p <= 0.93),
  peaksOut.map((p) => p.toFixed(3)).join(" "),
);
check(
  "fade-in / fade-out applied (edges are silent)",
  sounds.every((s) => {
    const view = new DataView(s.wav);
    return view.getInt16(44, true) === 0 && view.getInt16(view.getUint32(40, true) + 42, true) === 0;
  }),
);

/* ---------- WAV header parity with the SD1 reference ---------- */
const reference = fs.readFileSync(new URL("../SD1/clicks/1.wav", import.meta.url));
const mine = Buffer.from(sounds[0].wav);
const headerOf = (buf: Buffer, offset = 0) => ({
  riff: buf.toString("ascii", offset, offset + 4),
  wave: buf.toString("ascii", offset + 8, offset + 12),
  fmt: buf.toString("ascii", offset + 12, offset + 16),
  fmtSize: buf.readUInt32LE(offset + 16),
  format: buf.readUInt16LE(offset + 20),
  channels: buf.readUInt16LE(offset + 22),
  sampleRate: buf.readUInt32LE(offset + 24),
  byteRate: buf.readUInt32LE(offset + 28),
  blockAlign: buf.readUInt16LE(offset + 32),
  bits: buf.readUInt16LE(offset + 34),
  data: buf.toString("ascii", offset + 36, offset + 40),
});
const ref = headerOf(reference);
const got = headerOf(mine);
check(
  "WAV header identical to SD1 reference",
  JSON.stringify(ref) === JSON.stringify(got),
  `ref ${JSON.stringify(ref)} vs ours ${JSON.stringify(got)}`,
);
check(
  "48 kHz / mono / 16-bit PCM",
  got.sampleRate === 48000 && got.channels === 1 && got.bits === 16 && got.format === 1,
);
check(
  "clip length in the same ballpark as SD1 (28988 bytes)",
  mine.length > 8000 && mine.length < 120000,
  `${mine.length} bytes, ${(mine.length / (2 * 48000)).toFixed(3)}s`,
);

/* ---------- resampler sanity ---------- */
const up = resample(take.subarray(0, 4800), 24000, RATE);
check("resample 24k -> 48k doubles length", up.length === 9600, `${up.length}`);

/* ---------- readme + file naming ---------- */
const meta: PackMeta = {
  title: "Sawyer's Soft Desk Pack",
  description: "Recorded on a wooden desk in a quiet room.",
  creator: "SawyerSayo",
};
check("file name format", packFileName(meta) === "SawyerSayo-CutItQuik.zip", packFileName(meta));
check(
  "file name falls back to the title",
  packFileName({ ...meta, creator: "" }) === "Sawyer's-Soft-Desk-Pack-CutItQuik.zip",
  packFileName({ ...meta, creator: "" }),
);
check(
  "illegal filename characters stripped",
  packFileName({ ...meta, creator: "Saw/yer:Sa*yo?" }) === "SawyerSa yo-CutItQuik.zip".replace(" ", ""),
  packFileName({ ...meta, creator: "Saw/yer:Sa*yo?" }),
);
check(
  "readme starts with the title then the description",
  buildReadme(meta) === "Sawyer's Soft Desk Pack\n\nRecorded on a wooden desk in a quiet room.\n",
);

/* ---------- zip structure ---------- */
const noiseSamples = new Float32Array(RATE * 2);
for (let i = 0; i < noiseSamples.length; i++) noiseSamples[i] = (Math.random() * 2 - 1) * 0.01;
const noiseWav = encodeWav(noiseSamples, RATE).buffer as ArrayBuffer;

const zip = await buildPack({ meta, sounds, noise: { wav: noiseWav, duration: 2 } });
const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

const tmp = path.join(os.tmpdir(), "ciq-verify.zip");
fs.writeFileSync(tmp, buffer);
const listing = execSync(`tar -tf "${tmp}"`).toString().trim().split(/\r?\n/);
fs.rmSync(tmp);

const expected = [
  "readme.txt",
  "noise.wav",
  ...categories.map((c) => `${c}/`),
  "clicks/1.wav",
  "clicks/2.wav",
  "clicks/3.wav",
  "releases/1.wav",
  "hardreleases/1.wav",
  "hardclicks/1.wav",
  "softclicks/1.wav",
  "softreleases/1.wav",
  "microclicks/1.wav",
  "microreleases/1.wav",
];
const missing = expected.filter((entry) => !listing.includes(entry));
check("zip contains the full SD1 architecture", missing.length === 0, `missing: ${missing.join(", ")}`);
check("all 8 folders present even when used", listing.filter((l) => l.endsWith("/")).length === 8);
check("clips are numbered from 1", listing.includes("clicks/1.wav") && !listing.includes("clicks/0.wav"));
check("no nested root folder", !listing.some((l) => l.startsWith("SawyerSayo")));
check(
  "every clip made it into the zip",
  listing.filter((l) => l.endsWith(".wav") && l !== "noise.wav").length === sounds.length,
  `${listing.filter((l) => l.endsWith(".wav") && l !== "noise.wav").length} vs ${sounds.length}`,
);

const reloaded = await JSZip.loadAsync(buffer);
check("readme.txt round-trips", (await reloaded.file("readme.txt")!.async("string")).startsWith("Sawyer's Soft Desk Pack"));

console.log(results.join("\n"));
console.log(`\nzip entries: ${listing.length}`);
