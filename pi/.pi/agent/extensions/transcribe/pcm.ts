import { LIVE_FRAME_SAMPLES } from "./constants.ts";

/** Concatenates PvRecorder's Int16 frames into one buffer for the WAV fallback. */
export function concatInt16Frames(frames: readonly Int16Array[]): Int16Array {
  const sampleCount = frames.reduce((total, frame) => total + frame.length, 0);
  const pcm = new Int16Array(sampleCount);
  let offset = 0;
  for (const frame of frames) {
    pcm.set(frame, offset);
    offset += frame.length;
  }
  return pcm;
}

function encodeFloat32LEFrame(samples: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 4);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setFloat32(index * 4, (samples[index] ?? 0) / 32_768, true);
  }
  return buffer;
}

/**
 * Buffers PvRecorder's 512-sample Int16 frames and yields exact
 * `LIVE_FRAME_SAMPLES`-sample Float32LE frames for the live WebSocket protocol.
 */
export class LiveFrameChunker {
  private carry = new Int16Array(0);

  /** Appends a captured frame and returns zero or more ready-to-send frames. */
  push(frame: Int16Array): ArrayBuffer[] {
    const combined = new Int16Array(this.carry.length + frame.length);
    combined.set(this.carry);
    combined.set(frame, this.carry.length);

    const frames: ArrayBuffer[] = [];
    let offset = 0;
    while (combined.length - offset >= LIVE_FRAME_SAMPLES) {
      frames.push(encodeFloat32LEFrame(combined.subarray(offset, offset + LIVE_FRAME_SAMPLES)));
      offset += LIVE_FRAME_SAMPLES;
    }
    this.carry = combined.slice(offset);
    return frames;
  }

  /** Zero-pads and returns the trailing partial frame, or undefined if none remains. */
  flush(): ArrayBuffer | undefined {
    if (this.carry.length === 0) return undefined;
    const padded = new Int16Array(LIVE_FRAME_SAMPLES);
    padded.set(this.carry);
    this.carry = new Int16Array(0);
    return encodeFloat32LEFrame(padded);
  }
}

const WAV_HEADER_BYTES = 44;

/** Encodes mono 16-bit PCM as a little-endian WAV file for the batch fallback. */
export function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2;
  const buffer = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);
  const byteRate = sampleRate * 2;

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < pcm.length; index += 1) {
    buffer.writeInt16LE(pcm[index] ?? 0, WAV_HEADER_BYTES + index * 2);
  }

  return buffer;
}
