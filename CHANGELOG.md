# Changelog

## Unreleased

- **`demo.waitFor(selector)`.** Holds the camera until the selector is visible while the page's clock keeps running, so a page that loads, fetches or animates gets the time without its loading being filmed. No video time passes.
- **`demo.call(fn)`**, **`terminal.print(text)`** and **`terminal.run(cmd, { prompt: false })`.** A function run at a point of the timeline, for a change the page should see happen then, such as another client's edit; and terminal output split around it, with no prompt in between.
- **Output recorded elsewhere.** `terminal.run` and `terminal.print` take `events`, timed chunks of output with their escape codes, played like a recording; `terminal.open({ cols, rows })` fixes the terminal's size in characters. Together they play back a full-screen program (an agent's TUI, say) recorded at that size with `script -r` or asciinema. Those events are written as they are, as a terminal writes a program's output: a bare line feed moves down a row and keeps the column. Other output still gets a carriage return before each line feed.
- **`cursor.click({ duration })`** and **`waitFor(selector, { settle })`.** A click that takes no video time, followed by waitFor, cuts from the click straight to the page it led to; `settle` runs the page's clock a little longer, off camera, for what the page does once the target shows.
- **`zoom.to(target, { within: "window" })`.** Keeps the zoomed view inside the target's window, so the desktop behind it never shows at the window's edge.
- **`menubar` option.** `createDemo({ menubar: { app, clock } })` sets what the macOS menu bar says; `menubar: false` leaves it out and moves the window up into its place.

- **Fixed: animations replayed.** A CSS animation with a fill mode stays in `document.getAnimations()` after it ends; the page clock took it for a new one every frame and started it over, so titles kept sliding in and anything with an enter animation flickered.
- **`address` option.** `createDemo({ address: (url) => ... })` rewrites what the address pill shows, so a dev server can appear as the public site. The pill now follows in-page navigation too, instead of the address the window was opened at.
- The page context is granted clipboard read and write, so Copy buttons in the page under demo work as they do in a real browser.
- **Address pill.** Blank for `file://` pages (title cards, fixtures), and a long path is cut at the end with an ellipsis instead of being clipped on both sides.

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
