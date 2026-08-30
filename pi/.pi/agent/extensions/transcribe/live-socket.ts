import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  CAPTURE_SAMPLE_RATE,
  LIVE_FRAME_SAMPLES,
  LIVE_PROTOCOL,
  LIVE_URL,
} from "./constants.ts";
import { parseLiveEvent, type LiveFinalEvent } from "./protocol.ts";

const MAX_BUFFERED_BYTES = 64 * 1024;

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/**
 * One live-transcription connection: negotiates the `transcribe.pcm-f32le.v1`
 * subprotocol, queues frames sent before the server's `ready` event so no
 * captured audio is dropped while connecting, and settles on `final`/`error`/
 * an unexpected close. See transcribe-server/src/api.rs for the wire contract.
 */
export class LiveConnection {
  private readonly socket: WebSocket;
  private readonly readyDeferred = createDeferred<void>();
  private readonly finalDeferred = createDeferred<LiveFinalEvent>();
  private ready = false;
  private settled = false;
  private readonly pending: ArrayBuffer[] = [];
  private pendingBytes = 0;
  onRevision?: (committed: string, tentative: string) => void;

  constructor() {
    const socket = new WebSocket(LIVE_URL, [LIVE_PROTOCOL]);
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("error", () => this.fail(new Error("WebSocket error")));
    socket.addEventListener("close", (event) => {
      if (this.settled) return;
      this.fail(new Error(`Live transcription socket closed unexpectedly (code ${event.code})`));
    });
    this.socket = socket;
  }

  /** False once the connection has failed, finalized, or been cancelled. */
  get usable(): boolean {
    return !this.settled;
  }

  private handleMessage(event: MessageEvent): void {
    if (this.settled) return;
    if (!Value.Check(Type.String(), event.data)) {
      this.fail(new Error("Live transcription server sent a non-text message"));
      return;
    }

    let parsed: ReturnType<typeof parseLiveEvent>;
    try {
      parsed = parseLiveEvent(event.data);
    } catch (error) {
      this.fail(toError(error));
      return;
    }

    switch (parsed.type) {
      case "ready":
        if (
          this.ready ||
          this.socket.protocol !== LIVE_PROTOCOL ||
          parsed.sample_rate !== CAPTURE_SAMPLE_RATE ||
          parsed.frame_samples !== LIVE_FRAME_SAMPLES
        ) {
          this.fail(new Error("Live transcription server negotiated an incompatible stream"));
          return;
        }
        this.ready = true;
        this.readyDeferred.resolve();
        this.flushPending();
        return;
      case "revision":
        if (!this.ready) {
          this.fail(new Error("Live transcription server sent a revision before ready"));
          return;
        }
        this.onRevision?.(parsed.committed, parsed.tentative);
        return;
      case "final":
        if (!this.ready) {
          this.fail(new Error("Live transcription server sent a final result before ready"));
          return;
        }
        this.settled = true;
        this.finalDeferred.resolve(parsed);
        this.closeSocket();
        return;
      case "error":
        this.fail(new Error(parsed.message));
        return;
    }
  }

  private flushPending(): void {
    while (this.pending.length > 0 && !this.settled) {
      const buffer = this.pending.shift()!;
      this.pendingBytes -= buffer.byteLength;
      this.sendNow(buffer);
    }
  }

  private sendNow(buffer: ArrayBuffer): void {
    if (this.socket.bufferedAmount + buffer.byteLength > MAX_BUFFERED_BYTES) {
      this.fail(new Error("Live transcription WebSocket output exceeded 64 KiB"));
      return;
    }
    try {
      this.socket.send(buffer);
    } catch (error) {
      this.fail(toError(error));
    }
  }

  private closeSocket(): void {
    try {
      this.socket.close();
    } catch {
      // Already closing or closed.
    }
  }

  private fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.readyDeferred.reject(error);
    this.finalDeferred.reject(error);
    this.closeSocket();
  }

  /**
   * Queues or sends one binary frame. Frames sent before `ready` are held and
   * flushed in order once the server is ready, so capture is never lost.
   */
  sendFrame(buffer: ArrayBuffer): void {
    if (this.settled) throw new Error("Live transcription socket is no longer usable");
    if (!this.ready) {
      this.pendingBytes += buffer.byteLength;
      if (this.pendingBytes > MAX_BUFFERED_BYTES) {
        this.fail(new Error("Live transcription WebSocket setup exceeded 64 KiB"));
        throw new Error("Live transcription socket is no longer usable");
      }
      this.pending.push(buffer);
      return;
    }
    this.sendNow(buffer);
  }

  /**
   * Sends `{"type":"stop"}` and awaits the server's `final` event. Waits for
   * `ready` first: sending stop before the server is ready would race ahead
   * of any still-queued binary frames, which the server would then discard.
   */
  async stop(): Promise<LiveFinalEvent> {
    if (this.settled) throw new Error("Live transcription socket is no longer usable");
    await this.readyDeferred.promise;
    try {
      this.socket.send(JSON.stringify({ type: "stop" }));
    } catch (error) {
      this.fail(toError(error));
    }
    return this.finalDeferred.promise;
  }

  /** Aborts the connection without finalizing: no error, no final text. */
  cancel(): void {
    if (this.settled) return;
    this.settled = true;
    const error = new Error("Live transcription cancelled");
    this.readyDeferred.reject(error);
    this.finalDeferred.reject(error);
    this.closeSocket();
  }
}
