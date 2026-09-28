# Changelog

## 0.4.0

Closes the gaps a coherence review found in 0.3.1: places where the tool let a broken demo pass, promised more than it did, or behaved differently in two places.

**Changes that can affect existing scripts**

- **Paths in a script are relative to the script's folder**, including `demo.render(path)` and the `recordingsDir` option, which were relative to the working directory. Paths on the command line are still relative to the working directory. A script run from its own folder is unaffected; otherwise its output moves next to it.
- **The page's date is pinned** to Tuesday, September 23, 2025, 9:41 AM UTC by default, matching the menu bar, instead of the real time at render. Pass `clock: new Date()` for the real time, or set `clock` and `timezone`.
- **`goto({ settle })` is now `goto({ hold })`**, because `settle` elsewhere means time off camera. `settle` still works on `goto` until 1.0.
- `render`, `recordCommand`, `scriptedEvents`, and `playbackEvents` are no longer exported; they were internal.

**`check` can be trusted**

- An editor file or command that VS Code can't find fails at its script line, instead of pressing Enter on "No matching results" or a similar command.
- A script that never calls `demo.render()` fails instead of passing silently.
- A missing terminal recording names the script line.

**Fixes and additions**

- Renders no longer idle for about 10 seconds after finishing.
- `close()` on every window, and `browser.open(geometry)` to place the browser without navigating. `mockAPI` applies to every window and no longer opens one.
- `clock` and `timezone` options; the menu bar shows the demo's clock.
- `reelscript cache` lists what's cached and `reelscript cache clear <part|all>` removes it; `reelscript warmup` also downloads VS Code.
- `reelscript record` takes several scripts, warns when a command fails, and `--prune` removes recordings no script uses.
- `reelscript login` and the session-not-found error print the exact paths to use, so following the error can't loop.
- The container image is built for amd64 and arm64, each tested on its own architecture. VS Code and the voice model are built in, and `/cache` holds what a render adds, so a volume there keeps extensions and spoken lines between runs.
- MCP: `inspect_page` takes a `session`; a new `record_script` tool; tools that drive the real app are no longer marked read-only.
- `reelscript --help` exits cleanly, and progress lines are plain in CI logs.
- The README covers every command, option, and method, and the rules that hold across them.

## 0.3.1

- **Logged-in apps.** `reelscript login <url>` opens a real browser so you can sign in once, and saves the session to a file. `createDemo({ session: "session.json" })` starts every browser window signed in. A missing session file is a clear error that tells you how to make one.
- **`demo.call(fn)` gets the page.** `fn` receives `{ page, context }`, the focused window's Playwright page and the browser context, for setup that has to happen off camera.
- **Editor extensions no longer leak between demos.** Each demo gets its own extensions, so an extension one demo loads never appears in another. Open VSX extensions and `.vsix` files install once and are cached; pin versions with `publisher.name@1.2.3`.

## 0.3.0

- **`reelscript check`.** Runs a script's whole timeline against the real app with nothing captured or encoded, in about a second for a browser demo, and fails with the script line of the first broken step. Made for pull requests: the demo breaks in CI when the UI changes under it.
- **Errors point at your script.** Every failure from `render` or `check` now ends with the line that caused it, like `at demo/signup.ts:14:19 (cursor.moveTo)`.
- **Follow camera.** `camera: "follow"` zooms toward clicks and the typing caret on its own, starts moving before a click lands, keeps the cursor in view, and eases out when things go quiet. `{ scale, holdMs }` tunes it; `zoom.to()` still takes over when you want a specific shot.
- **MCP server for coding agents.** `reelscript mcp` gives Claude Code and other MCP clients the docs, page inspection with ready-made selectors, `check`, frame previews as images, and rendering, so an agent can write and iterate on a demo itself.
- **`demo.waitFor(selector)`.** Holds the camera until the selector is visible while the page's clock keeps running, so a page that loads, fetches or animates gets the time without its loading being filmed. No video time passes.
- **`demo.call(fn)`**, **`terminal.print(text)`** and **`terminal.run(cmd, { prompt: false })`.** A function run at a point of the timeline, for a change the page should see happen then, such as another client's edit; and terminal output split around it, with no prompt in between.
- **Output recorded elsewhere.** `terminal.run` and `terminal.print` take `events`, timed chunks of output with their escape codes, played like a recording; `terminal.open({ cols, rows })` fixes the terminal's size in characters, and `lineHeight` sets its line spacing (1 joins block characters, as in most terminal apps; the default stays 1.3). Together they play back a full-screen program (an agent's TUI, say) recorded at that size with `script -r` or asciinema. Those events are written as they are, as a terminal writes a program's output: a bare line feed moves down a row and keeps the column. Other output still gets a carriage return before each line feed.
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
