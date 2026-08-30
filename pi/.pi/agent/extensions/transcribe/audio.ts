import { PvRecorder } from "@picovoice/pvrecorder-node";
import { CAPTURE_SAMPLE_RATE, RECORDER_FRAME_SAMPLES } from "./constants.ts";
import { concatInt16Frames } from "./pcm.ts";

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}

/** Wraps PvRecorder on the system-default microphone (device index -1). */
export class MicrophoneCapture {
  private recorder: PvRecorder | undefined;
  private frames: Int16Array[] = [];
  private readLoop: Promise<void> | undefined;
  private stopping = false;
  private readError: Error | undefined;
  onFrame?: (frame: Int16Array) => void;

  async start(): Promise<void> {
    if (this.recorder) throw new Error("Microphone capture is already active");

    const recorder = new PvRecorder(RECORDER_FRAME_SAMPLES, -1);
    try {
      if (recorder.sampleRate !== CAPTURE_SAMPLE_RATE) {
        throw new Error(`PvRecorder reported ${recorder.sampleRate} Hz; expected ${CAPTURE_SAMPLE_RATE} Hz`);
      }
      this.frames = [];
      this.stopping = false;
      this.readError = undefined;
      recorder.start();
      this.recorder = recorder;
      this.readLoop = this.readFrames(recorder);
    } catch (error) {
      recorder.release();
      throw error;
    }
  }

  /** Stops capture and returns the complete retained Int16 recording. */
  async stop(): Promise<Int16Array> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("Microphone capture is not active");

    this.stopping = true;
    let stopError: Error | undefined;
    try {
      if (recorder.isRecording) recorder.stop();
    } catch (error) {
      stopError = toError(error);
    }

    try {
      await this.readLoop;
    } finally {
      recorder.release();
      this.recorder = undefined;
      this.readLoop = undefined;
    }

    if (stopError) throw stopError;
    if (this.readError) throw this.readError;
    return concatInt16Frames(this.frames);
  }

  private async readFrames(recorder: PvRecorder): Promise<void> {
    try {
      while (!this.stopping && recorder.isRecording) {
        const frame = await recorder.read();
        if (this.stopping) continue;
        this.frames.push(frame);
        try {
          this.onFrame?.(frame);
        } catch {
          // Streaming/widget updates must not fail the recording.
        }
      }
    } catch (error) {
      if (!this.stopping) this.readError = toError(error);
    }
  }
}
