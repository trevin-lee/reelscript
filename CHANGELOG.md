# Changelog

## 0.2.0

- **Editor window.** `demo.editor.open()` runs a real VS Code (code-server) on a workspace folder. Open files from the Explorer or Quick Open, type code, run palette commands, and load extensions from a folder, a `.vsix`, or Open VSX. Demo the extension you're building straight from its repo.
- **Multi-window desktop.** Browser, terminal, and editor windows with positions, sizes, focus, and z-order. Clicking a window raises it; selectors resolve in the focused window or the one named with `window`.
- **Terminal windows.** `demo.terminal.open()` and `terminal.run()` with declared output, or record real commands with `reelscript record` and replay them frame-exact.
- **Narration.** `demo.say()` with Kokoro text-to-speech by default (offline, no account), paced timeline via `waitForNarration()`, clips cached, audio mixed into the mp4.
- **Sub-pixel zoom.** No more cursor jitter during zooms.
- **GIF output** with a palette-optimized encoder, chosen by file extension.
- **Container image** at `ghcr.io/trevin-lee/reelscript` with Chromium, ffmpeg, fonts, the narration model, and code-server baked in.
- CLI runs scripts as ES modules from any project, and `reelscript warmup` pre-downloads the narration model.

## 0.1.0

- First release: scripted cursor, clicks, typing, zoom, a mocked macOS desktop, and deterministic frame-by-frame rendering to mp4.
