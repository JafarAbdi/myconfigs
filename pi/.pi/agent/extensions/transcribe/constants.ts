export const SHORTCUT = "ctrl+alt+z";
export const SHORTCUT_LABEL = "Ctrl+Alt+Z";

export const BATCH_URL = "https://dell-laptop.tail79ed4.ts.net:9450/api/transcribe";
export const LIVE_URL = "wss://dell-laptop.tail79ed4.ts.net:9450/api/transcribe/live";
export const LIVE_PROTOCOL = "transcribe.pcm-f32le.v1";

/** PvRecorder's native capture rate and frame size (device index -1: system default). */
export const CAPTURE_SAMPLE_RATE = 16_000;
export const RECORDER_FRAME_SAMPLES = 512;

/** Exact frame size the live WebSocket protocol requires per binary message. */
export const LIVE_FRAME_SAMPLES = 480;

export const WIDGET_KEY = "transcribe-status";
