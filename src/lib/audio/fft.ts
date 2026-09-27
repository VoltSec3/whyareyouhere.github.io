/**
 * Minimal in-place radix-2 Cooley–Tukey FFT.
 *
 * Length must be a power of two. Both transforms are unnormalised except that
 * `ifft` divides by `n`, so a forward/inverse pair round-trips to the original
 * signal.
 */

function isPowerOfTwo(n: number): boolean {
  return n >= 2 && (n & (n - 1)) === 0;
}

function bitReverseSwap(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
}

export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n === 0) return;
  if (!isPowerOfTwo(n)) throw new Error(`FFT length must be a power of two, got ${n}`);
  if (n === 1) return;

  bitReverseSwap(re, im);

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);

    for (let start = 0; start < n; start += len) {
      let twiddleRe = 1;
      let twiddleIm = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;

        const bRe = re[b]! * twiddleRe - im[b]! * twiddleIm;
        const bIm = re[b]! * twiddleIm + im[b]! * twiddleRe;

        re[b] = re[a]! - bRe;
        im[b] = im[a]! - bIm;
        re[a] = re[a]! + bRe;
        im[a] = im[a]! + bIm;

        const nextRe = twiddleRe * stepRe - twiddleIm * stepIm;
        twiddleIm = twiddleRe * stepIm + twiddleIm * stepRe;
        twiddleRe = nextRe;
      }
    }
  }
}

export function ifft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n === 0) return;

  for (let i = 0; i < n; i++) im[i] = -im[i]!;
  fft(re, im);
  const scale = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] = re[i]! * scale;
    im[i] = -im[i]! * scale;
  }
}
