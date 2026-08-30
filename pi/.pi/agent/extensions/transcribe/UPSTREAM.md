# Upstream provenance

`audio.ts` (`MicrophoneCapture`) and the escape-cancellation/`runExclusive`
shape in `runtime.ts` are closely adapted from:

- Repository: https://github.com/earendil-works/pi-transcribe
- Commit: `95b18bba3e529c42e6699e7658d3689f75dd14d3`
- Upstream files read for this port: `src/audio.ts`, `src/pcm.ts`,
  `src/index.ts`, `src/runtime.ts`, `src/shortcut-core.ts`,
  `src/transcription-service.ts`.

Deviations from upstream:

- No local model, catalog, downloads, settings UI, file tool, visualizer,
  onboarding, or `TranscriptionService` queue/scheduler. This extension
  streams to a remote transcription server instead (`transcribe-server`) and
  falls back to one batch HTTP POST.
- Fixed source constants (shortcut, server endpoints, protocol id) instead of
  persisted settings or a microphone/model picker. Always uses PvRecorder's
  system-default device (index `-1`).
- `pcm.ts`, `protocol.ts`, and `live-socket.ts` are new: they implement the
  `transcribe.pcm-f32le.v1` WebSocket protocol and its JSON event validation
  against `transcribe-server/src/api.rs`, which upstream `pi-transcribe` does
  not have.

Upstream's MIT license notice:

```
MIT License

Copyright (c) 2026 Earendil Works contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
