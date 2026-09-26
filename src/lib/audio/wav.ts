export const TARGET_SAMPLE_RATE = 48000;

/**
 * Encodes mono float samples as a 16-bit PCM RIFF/WAVE buffer.
 * The reference click packs (e.g. zcb) are 48 kHz / mono / 16-bit.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Uint8Array(buffer);
}

export function wavBlob(samples: Float32Array, sampleRate: number): Blob {
  return new Blob([encodeWav(samples, sampleRate) as BlobPart], { type: "audio/wav" });
}

/** Linear-interpolation resampler. Good enough for short percussive transients. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  if (from <= 0 || to <= 0) return new Float32Array(0);

  const ratio = to / from;
  const length = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const t = src - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }

  return out;
}

export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const length = channels[0]?.length ?? 0;
  const out = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) out[i] += channel[i];
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < length; i++) out[i] *= scale;
  return out;
}

export function formatSeconds(seconds: number, precision = 2): string {
  return `${seconds.toFixed(precision)}s`;
}

export function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}
