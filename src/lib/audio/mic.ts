import { TARGET_SAMPLE_RATE } from "./wav";

const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.size = 0;
    this.limit = 4096;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      this.chunks.push(new Float32Array(input[0]));
      this.size += input[0].length;
      if (this.size >= this.limit) {
        const merged = new Float32Array(this.size);
        let offset = 0;
        for (const chunk of this.chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        this.chunks = [];
        this.size = 0;
        this.port.postMessage(merged, [merged.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("ciq-capture", CaptureProcessor);
`;

let workletUrl: string | null = null;
function getWorkletUrl() {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
  }
  return workletUrl;
}

export type MicOptions = {
  onChunk: (chunk: Float32Array) => void;
};

/**
 * Captures raw mono PCM from the default microphone. Intentionally bypasses the
 * browser's echo cancellation / noise suppression / AGC so clicks stay crisp.
 */
export class MicCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private readonly onChunk: (chunk: Float32Array) => void;
  private chunks: Float32Array[] = [];
  private length = 0;

  constructor(options: MicOptions) {
    this.onChunk = options.onChunk;
  }

  get sampleRate() {
    return this.context?.sampleRate ?? TARGET_SAMPLE_RATE;
  }

  static isSupported() {
    return (
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      (typeof AudioWorkletNode !== "undefined" ||
        typeof (window as { ScriptProcessorNode?: unknown }).ScriptProcessorNode !== "undefined")
    );
  }

  async start() {
    if (!MicCapture.isSupported()) {
      throw new Error("This browser cannot record audio. Try Chrome, Edge, Firefox or Safari.");
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });

    this.context = new AudioContext({ latencyHint: "interactive" });
    if (this.context.state === "suspended") await this.context.resume();

    this.source = this.context.createMediaStreamSource(this.stream);

    if (typeof AudioWorkletNode !== "undefined") {
      try {
        await this.context.audioWorklet.addModule(getWorkletUrl());
        const worklet = new AudioWorkletNode(this.context, "ciq-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
        });
        worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
          this.push(new Float32Array(event.data));
        };
        this.source.connect(worklet);
        const sink = this.context.createGain();
        sink.gain.value = 0;
        worklet.connect(sink).connect(this.context.destination);
        this.node = worklet;
        return;
      } catch {
        this.node = null;
      }
    }

    const processor = this.context.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      this.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    this.source.connect(processor);
    const sink = this.context.createGain();
    sink.gain.value = 0;
    processor.connect(sink).connect(this.context.destination);
    this.node = processor;
  }

  private push(chunk: Float32Array) {
    this.chunks.push(chunk);
    this.length += chunk.length;
    this.onChunk(chunk);
  }

  /** Returns everything captured so far as a single buffer. */
  take(): Float32Array {
    const merged = new Float32Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.length = 0;
    return merged;
  }

  async stop() {
    const node = this.node;
    this.node = null;
    if (node) {
      if ("port" in node) node.port.onmessage = null;
      node.disconnect();
      if ("onaudioprocess" in node) node.onaudioprocess = null;
    }
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.source = null;
    this.stream = null;
    if (this.context && this.context.state !== "closed") await this.context.close();
    this.context = null;
  }
}

/** Decodes any browser-supported audio blob (used for pack previews). */
export async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  const bytes = await blob.arrayBuffer();
  const context = new AudioContext();
  try {
    return await context.decodeAudioData(bytes);
  } finally {
    void context.close();
  }
}
