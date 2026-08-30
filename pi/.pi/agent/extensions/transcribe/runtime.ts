import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { MicrophoneCapture } from "./audio.ts";
import { BATCH_URL, CAPTURE_SAMPLE_RATE, SHORTCUT_LABEL, WIDGET_KEY } from "./constants.ts";
import { LiveConnection } from "./live-socket.ts";
import { encodeWav, LiveFrameChunker } from "./pcm.ts";
import { parseBatchError, parseBatchSuccess } from "./protocol.ts";

export type TranscribeRuntime = {
  toggle(ctx: ExtensionContext): Promise<void>;
  shutdown(ctx: ExtensionContext): Promise<void>;
};

type Phase = "idle" | "recording" | "finishing";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function postBatchFallback(pcm: Int16Array, signal: AbortSignal): Promise<string> {
  const wav = encodeWav(pcm, CAPTURE_SAMPLE_RATE);
  const response = await fetch(BATCH_URL, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: wav,
    signal,
  });

  const raw = await response.text();
  if (response.ok) return parseBatchSuccess(raw).text;

  let detail: string;
  try {
    const failure = parseBatchError(raw);
    detail = `${failure.code}: ${failure.message}`;
  } catch {
    detail = raw.slice(0, 500) || response.statusText;
  }
  throw new Error(`Transcription server returned ${response.status}: ${detail}`);
}

export function createTranscribeRuntime(): TranscribeRuntime {
  let phase: Phase = "idle";
  let cancelled = false;
  let operation: Promise<void> | undefined;
  let capture: MicrophoneCapture | undefined;
  let chunker: LiveFrameChunker | undefined;
  let socket: LiveConnection | undefined;
  let fallbackAbort: AbortController | undefined;
  let committed = "";
  let tentative = "";
  let stopListening: (() => void) | undefined;

  let statusLabel = "";

  function renderWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const lines = [ctx.ui.theme.fg("accent", statusLabel)];
    if (committed || tentative) {
      lines.push(`${ctx.ui.theme.fg("text", committed)}${ctx.ui.theme.fg("dim", tentative)}`);
    }
    ctx.ui.setWidget(WIDGET_KEY, lines);
  }

  function clearWidget(ctx: ExtensionContext): void {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  function clearEscapeListener(): void {
    stopListening?.();
    stopListening = undefined;
  }

  function listenForEscape(ctx: ExtensionContext): void {
    clearEscapeListener();
    if (!ctx.hasUI) return;
    stopListening = ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "escape")) return;
      if (phase === "recording") {
        void runExclusive(ctx, () => cancelRecording(ctx));
        return { consume: true };
      }
      if (phase === "finishing") {
        cancelled = true;
        fallbackAbort?.abort();
        socket?.cancel();
        return { consume: true };
      }
    });
  }

  async function cancelRecording(ctx: ExtensionContext): Promise<void> {
    const activeCapture = capture;
    socket?.cancel();
    phase = "idle";
    capture = undefined;
    chunker = undefined;
    socket = undefined;
    committed = "";
    tentative = "";
    clearEscapeListener();
    clearWidget(ctx);
    if (activeCapture) await activeCapture.stop().catch(() => undefined);
    ctx.ui.notify("Recording discarded", "info");
  }

  async function startRecording(ctx: ExtensionContext): Promise<void> {
    cancelled = false;
    committed = "";
    tentative = "";
    statusLabel = `Recording — ${SHORTCUT_LABEL} to finish, Esc to cancel`;

    const nextChunker = new LiveFrameChunker();
    const nextSocket = new LiveConnection();
    const nextCapture = new MicrophoneCapture();

    nextSocket.onRevision = (nextCommitted, nextTentative) => {
      committed = nextCommitted;
      tentative = nextTentative;
      renderWidget(ctx);
    };
    nextCapture.onFrame = (frame) => {
      for (const buffer of nextChunker.push(frame)) {
        if (!nextSocket.usable) break;
        try {
          nextSocket.sendFrame(buffer);
        } catch {
          // The socket has failed; capture continues for the WAV fallback.
        }
      }
    };

    try {
      await nextCapture.start();
    } catch (error) {
      nextSocket.cancel();
      ctx.ui.notify(`Microphone capture failed: ${errorMessage(error)}`, "error");
      return;
    }

    // Cancellation (e.g. session_shutdown) may have arrived while the
    // microphone was still starting, before `socket`/`capture` were published
    // for it to reach. Tear down what was just created instead of leaking it.
    if (cancelled) {
      nextSocket.cancel();
      await nextCapture.stop().catch(() => undefined);
      return;
    }

    capture = nextCapture;
    chunker = nextChunker;
    socket = nextSocket;
    phase = "recording";
    listenForEscape(ctx);
    renderWidget(ctx);
  }

  function finishIdle(ctx: ExtensionContext): void {
    phase = "idle";
    capture = undefined;
    chunker = undefined;
    socket = undefined;
    clearEscapeListener();
    clearWidget(ctx);
    committed = "";
    tentative = "";
  }

  async function stopAndFinalize(ctx: ExtensionContext): Promise<void> {
    const activeCapture = capture!;
    const activeChunker = chunker!;
    const activeSocket = socket!;
    phase = "finishing";
    statusLabel = "Transcribing…";
    renderWidget(ctx);

    let pcm: Int16Array;
    try {
      pcm = await activeCapture.stop();
    } catch (error) {
      finishIdle(ctx);
      ctx.ui.notify(`Microphone capture failed: ${errorMessage(error)}`, "error");
      return;
    }
    if (cancelled) {
      finishIdle(ctx);
      return;
    }

    let finalText: string | undefined;
    if (activeSocket.usable) {
      try {
        const finalFrame = activeChunker.flush();
        if (finalFrame) activeSocket.sendFrame(finalFrame);
        finalText = (await activeSocket.stop()).text;
      } catch {
        finalText = undefined;
      }
    }

    if (cancelled) {
      finishIdle(ctx);
      return;
    }

    if (finalText === undefined) {
      const controller = new AbortController();
      fallbackAbort = controller;
      try {
        finalText = await postBatchFallback(pcm, controller.signal);
      } catch (error) {
        fallbackAbort = undefined;
        finishIdle(ctx);
        if (!cancelled) ctx.ui.notify(`Transcription failed: ${errorMessage(error)}`, "error");
        return;
      }
      fallbackAbort = undefined;
    }

    finishIdle(ctx);
    if (cancelled) return;
    if (finalText) {
      ctx.ui.pasteToEditor(finalText);
    } else {
      ctx.ui.notify("No speech detected", "info");
    }
  }

  function runExclusive(ctx: ExtensionContext, task: () => Promise<void>): Promise<void> {
    if (operation) {
      ctx.ui.notify("A transcription operation is already in progress", "warning");
      return operation;
    }
    const next = task().finally(() => {
      if (operation === next) operation = undefined;
    });
    operation = next;
    return next;
  }

  async function toggle(ctx: ExtensionContext): Promise<void> {
    await runExclusive(ctx, () => (phase === "recording" ? stopAndFinalize(ctx) : startRecording(ctx)));
  }

  async function shutdown(ctx: ExtensionContext): Promise<void> {
    if (phase === "idle" && !operation) return;
    cancelled = true;
    fallbackAbort?.abort();
    socket?.cancel();
    await operation?.catch(() => undefined);

    const activeCapture = capture;
    capture = undefined;
    chunker = undefined;
    socket = undefined;
    phase = "idle";
    clearEscapeListener();
    clearWidget(ctx);
    if (activeCapture) await activeCapture.stop().catch(() => undefined);
  }

  return { toggle, shutdown };
}
