import { TARGET_SAMPLE_RATE } from "./wav";

type Active = {
  source: AudioBufferSourceNode;
  buffer: AudioBuffer;
  startedAt: number;
  offset: number;
  gain: GainNode;
};
/** Single shared output bus. Preview the sample waveform without tonal shaping. */
class AudioPlayer {
  private context: AudioContext | null = null;
  private bus: AudioNode | null = null;
  private active: Active | null = null;
  private buffers = new Map<string, AudioBuffer>();

  getContext(): AudioContext {
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext();
      const gain = this.context.createGain();
      gain.gain.value = 0.9;
      gain.connect(this.context.destination);
      this.bus = gain;
    }
    return this.context;
  }

  async resume() {
    const context = this.getContext();
    if (context.state === "suspended") await context.resume();
    return context;
  }

  createBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
    const context = this.getContext();
    const buffer = context.createBuffer(1, Math.max(1, samples.length), sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }

  /** Starts (or restarts) playback of `buffer` from `offset` seconds. */
  async play(buffer: AudioBuffer, offset = 0, volume = 1) {
    const context = await this.resume();
    this.stop();

    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(this.bus!);

    const clamped = Math.max(0, Math.min(offset, buffer.duration - 0.001));
    source.start(0, clamped);

    this.active = { source, buffer, startedAt: context.currentTime, offset: clamped, gain };
    return new Promise<void>((resolve) => {
      source.onended = () => {
        if (this.active?.source === source) this.active = null;
        resolve();
      };
    });
  }

  get isPlaying() {
    return this.active !== null;
  }

  /** Current playback position in buffer seconds. */
  get position() {
    if (!this.active) return 0;
    const elapsed = this.getContext().currentTime - this.active.startedAt;
    return Math.min(this.active.buffer.duration, this.active.offset + Math.max(0, elapsed));
  }

  stop() {
    if (!this.active) return;
    const { source, gain } = this.active;
    this.active = null;
    try {
      gain.gain.cancelScheduledValues(this.getContext().currentTime);
      gain.gain.setTargetAtTime(0, this.getContext().currentTime, 0.008);
      source.stop(this.getContext().currentTime + 0.05);
    } catch {
      /* already stopped */
    }
  }

  async playWav(wav: ArrayBuffer, cacheKey?: string) {
    if (cacheKey) {
      const cached = this.buffers.get(cacheKey);
      if (cached) {
        await this.play(cached, 0);
        return;
      }
    }
    const context = await this.resume();
    const decoded = await context.decodeAudioData(wav.slice(0));
    if (cacheKey) this.buffers.set(cacheKey, decoded);
    await this.play(decoded, 0);
  }

  invalidate(key: string) {
    this.buffers.delete(key);
  }
}

export const player = new AudioPlayer();

export { TARGET_SAMPLE_RATE };
