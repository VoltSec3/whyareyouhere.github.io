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

export type DecodedWav = {
  samples: Float32Array;
  sampleRate: number;
};

function readAscii(view: DataView, offset: number): string {
  let text = "";
  for (let i = 0; i < 4; i++) text += String.fromCharCode(view.getUint8(offset + i));
  return text;
}

/**
 * Minimal RIFF/WAVE reader for the 16-bit PCM buffers this app stores, and for
 * 8/24/32-bit PCM or 32-bit float in case a noise file came from elsewhere.
 * Returns null rather than throwing so callers can skip an unusable buffer.
 */
export function decodeWav(buffer: ArrayBuffer): DecodedWav | null {
  if (buffer.byteLength < 44) return null;
  const view = new DataView(buffer);
  if (readAscii(view, 0) !== "RIFF" || readAscii(view, 8) !== "WAVE") return null;

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;

  // Chunk walk rather than fixed offsets: encoders insert LIST/fact chunks.
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataStart = body;
      // Some encoders write a size that overruns the buffer; clamp it.
      dataLength = Math.max(0, Math.min(size, view.byteLength - body));
      break;
    }

    offset = body + size + (size % 2);
  }

  if (dataStart < 0 || channels < 1 || sampleRate < 1) return null;

  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample < 1) return null;
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  if (frameCount < 1) return null;

  const out = new Float32Array(frameCount);
  const float = format === 3;

  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = dataStart + (i * channels + c) * bytesPerSample;
      if (float) {
        sum += bitsPerSample === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true);
      } else if (bitsPerSample === 8) {
        sum += (view.getUint8(at) - 128) / 128;
      } else if (bitsPerSample === 16) {
        sum += view.getInt16(at, true) / 32768;
      } else if (bitsPerSample === 24) {
        const value =
          view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
        sum += value / 8388608;
      } else if (bitsPerSample === 32) {
        sum += view.getInt32(at, true) / 2147483648;
      }
    }
    out[i] = sum / channels;
  }

  return { samples: out, sampleRate };
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
