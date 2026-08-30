import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SHORTCUT } from "./constants.ts";
import type { TranscribeRuntime } from "./runtime.ts";

// Pi awaits extension module evaluation before continuing startup. Keep this
// entry point registration-only and load the runtime (and PvRecorder) lazily.
export default function transcribe(pi: ExtensionAPI): void {
  let runtimePromise: Promise<TranscribeRuntime> | undefined;

  function loadRuntime(): Promise<TranscribeRuntime> {
    runtimePromise ??= import("./runtime.ts").then(({ createTranscribeRuntime }) => createTranscribeRuntime());
    return runtimePromise;
  }

  pi.registerShortcut(SHORTCUT, {
    description: "Start/stop microphone transcription",
    handler: async (ctx) => {
      const runtime = await loadRuntime();
      await runtime.toggle(ctx);
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!runtimePromise) return;
    const runtime = await runtimePromise.catch(() => undefined);
    await runtime?.shutdown(ctx);
  });
}
