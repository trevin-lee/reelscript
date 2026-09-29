# reelscript

![A demo rendered by reelscript: the cursor glides to a button, a modal opens, the view zooms in, a name is typed, and the zoom releases](docs/demo.gif)

<sup>Made with reelscript, by reelscript: CI renders [examples/basic.ts](examples/basic.ts) inside the published container on every push to `main` and commits the result.</sup>

**Product demos as code.** Write a script, render a demo, re-run it in CI when your UI changes.

Screen-recording tools (Screen Studio, Arcade, Tango) all rot the same way: your product UI changes and your beautiful demo is now a lie, so you re-record it by hand. reelscript makes a demo a *build artifact*. The video is generated from a script, so when your UI updates you just re-run it, and `reelscript check` tells you in CI when a UI change has broken a demo.

```ts
import { createDemo } from "@reelscript/cli";

const demo = createDemo({ viewport: [1280, 800], camera: "follow" });

await demo.browser.goto("https://app.local");
await demo.cursor.moveTo("#new-project");
await demo.cursor.click();

demo.say("Give it a name, and hit Create.");
await demo.type("#project-name", "Acme Q3 Launch", { wpm: 400 });
await demo.cursor.moveTo("#create");
await demo.cursor.click();
await demo.waitForNarration();

await demo.render("out/demo.mp4");
```

## How it works

- **Code-first, not a UI timeline.** The demo is a script you version, diff, and review.
- **Deterministic offline rendering.** Frames are produced one at a time: drive a headless Chromium to the state for frame *n*, capture it, composite the animated cursor and zoom, and pipe it to ffmpeg. Every frame is there, and it runs headless in CI.
- **The page's clock is virtual and pinned.** reelscript replaces timers, `requestAnimationFrame`, `Date`, and `performance.now` inside the page and steps CSS transitions through the Web Animations API, one frame per rendered frame. A 200ms fade is 12 frames at 60fps no matter how slow capture is, and the page's date is the same on every render.
- **A camera that follows the action.** `camera: "follow"` eases in toward each click and the typing caret, holds, and eases back out when things go quiet. Or place zooms by hand with `zoom.to()`.
- **Cinematic layer.** Eased cursor motion, click ripples, zoom-to-element, accelerated typing, done as math over frames rather than captured motion.
- **Own the DOM.** Targets are Playwright selectors, and `browser.mockAPI()` returns canned JSON so demos needn't depend on a live backend.
- **A clean desktop.** The `macos` theme puts windows on a mocked macOS desktop, so there's nothing to tidy up before recording.
- **Browser, terminal, and VS Code windows.** Open them side by side, click between them, and the one you click comes to the front. The editor is a real VS Code that loads real extensions, including the one you're building.
- **Narration as code.** `say()` speaks a line while the actions continue, and `waitForNarration()` paces the timeline to the voice. The default voice is Kokoro, an open-weights model that runs on CPU with no account, so it works offline and in CI.

## Install

```sh
npm install -D @reelscript/cli
npx playwright install chromium
```

The package installs a `reelscript` command. Scripts are ES modules that use top-level `await`; set `"type": "module"` in your package.json, or the CLI will run them as modules for you. Commit your lockfile: it pins reelscript and the browser it drives, so renders don't change under you. (The unscoped name is blocked by npm's similarity rule against `rescript`, hence the scope.)

Requires Node 20.11 or later, on macOS or Linux. ffmpeg is bundled.

## Try it

```sh
git clone https://github.com/trevin-lee/reelscript && cd reelscript
npm install
npx playwright install chromium
npm run example            # renders examples/basic.ts -> examples/out/basic.mp4
```

The example drives a small dashboard app that ships with the repo, so it's fully self-contained. Rendering takes about three times the video's length on an M-series laptop; `preview` renders a single frame in a few seconds.

## Writing a demo

A script creates a demo with `createDemo()`, queues actions, and ends with `await demo.render(path)`. A few rules hold everywhere:

- **Paths in a script are relative to the script's folder**, wherever you run it from: the render output, `session`, `recordingsDir`, and an editor's `workspace` and `extensions`. Paths you pass on the command line are relative to your working directory.
- **Targets are [Playwright selectors](https://playwright.dev/docs/locators)**: CSS (`#create`), `text=Create`, `role=button[name="Create"]`, and so on. Prefer ids and `data-testid` attributes; they survive redesigns. A target can also be a point, `{ x, y }`, in the window's own coordinates.
- **Windows.** There is at most one browser, one terminal, and one editor window. The first window opened takes the `viewport` size and the main position on the desktop; later ones open smaller, at the lower right, unless you give them `x`, `y`, `width`, `height`. `browser.goto()` opens the browser window if it isn't open. Any window can be moved with `place()`, brought forward with `focus()`, and taken away with `close()`. Selectors resolve in the focused window unless you name one with `window`.
- **Time.** Actions run one after another. `zoom.to()` and `say()` start now and keep going while later actions run. `wait(ms)` holds on camera; `waitFor(selector)` holds off camera, so a slow load isn't filmed.
- **The clock.** Every demo happens at the same moment, Tuesday, September 23, 2025, 9:41 AM UTC, unless you set `clock` and `timezone`. The page's `Date` starts there and the menu bar shows it.

## Logged-in apps

Sign in once, by hand, in a real browser. reelscript saves the session (cookies and local storage) to a file:

```sh
reelscript login https://app.example.com/login --out demos/session.json
```

Then every browser window in a demo starts signed in. From a script in `demos/`:

```ts
const demo = createDemo({ session: "session.json" });
await demo.browser.goto("https://app.example.com/dashboard");
```

The file signs in as you, so add it to `.gitignore`. In CI, store it as a secret and write it out before rendering, for example `echo "$SESSION_JSON" > demos/session.json`. Sessions expire like any login; when a demo starts landing on the sign-in page, run `reelscript login` again. For anything else a demo needs set up off camera, `demo.call(({ page, context }) => ...)` gets the Playwright page and browser context.

## Several windows

```ts
const demo = createDemo({ viewport: [1180, 720], desktop: [1600, 1000] });
await demo.browser.goto("https://app.local");
await demo.terminal.open({ title: "acme", x: 700, y: 560, width: 840, height: 360 });
await demo.terminal.run("npm run deploy", { output: "Live at https://acme.app\n" });
await demo.terminal.close();
await demo.cursor.moveTo("#new-project", { window: "browser" });
await demo.cursor.click();
```

Each window is its own Chromium page; the desktop composites them in z-order with the theme's frames and shadows. Clicking a window raises it, and typing into a named window (`demo.type(selector, text, { window })`, `editor.type()`, `terminal.run()`) brings it forward first. See [examples/desktop.ts](examples/desktop.ts).

## Editor demos

```ts
await demo.editor.open({ workspace: "acme", extensions: ["esbenp.prettier-vscode@12.4.0"] });
await demo.cursor.moveTo(demo.editor.file("app.ts"));
await demo.cursor.click();
await demo.cursor.moveTo(".monaco-editor .view-lines"); // click into the editor to move keyboard focus
await demo.cursor.click();
await demo.press("Control+End");
await demo.editor.type('server.get("/health", () => ({ ok: true }));');
await demo.editor.command("Format Document");
```

`openFile()` and `command()` type into Quick Open and the Command Palette the way a person would. If VS Code can't find the file or command, the render and `check` fail at that line instead of pressing Enter on whatever VS Code offered, so a renamed command breaks the build rather than the demo.

The editor is [code-server](https://github.com/coder/code-server), a standalone build of Code - OSS. It's downloaded on first use, about 200 MB, and built into the container image. Each render starts it on a random local port with its own settings and a copy of the workspace, so your files are never edited, and stops it afterwards. Keybindings are always the Linux ones (Ctrl, not Cmd) so scripts behave the same on every host. VS Code runs on real time rather than reelscript's frame-stepped clock; its animations are off by default so this doesn't show. See [examples/editor.ts](examples/editor.ts).

### Demo the extension you're building

Point `extensions` at the extension's folder (a directory with a `package.json`), a `.vsix`, or an Open VSX id. Folders are copied in and registered, so no packaging step is needed:

```ts
// demo/extension.ts in the extension's repo: ".." is the repo root, the extension itself
await demo.editor.open({ workspace: "fixtures/project", extensions: [".."], notifications: true });
await demo.editor.command("Acme: Deploy to Production");
```

Each demo gets only the extensions it asks for. Open VSX extensions and `.vsix` files are installed once and cached; an Open VSX id without a version is cached at the version first installed, so pin one with `publisher.name@1.2.3`, or clear the cache to update (`reelscript cache clear extensions`). The extension runs in a real extension host with its Node dependencies, so keep `node_modules` present (or bundle) as you would for `vsce package`. See [examples/extension.ts](examples/extension.ts) and the sample extension in [examples/acme-ext](examples/acme-ext).

## Terminal demos

```ts
await demo.terminal.open({ title: "acme", prompt: "acme % " });
await demo.terminal.run("npm install -D @reelscript/cli", { output: "\nadded 38 packages in 2s\n" });
await demo.terminal.run("node --version"); // replayed from recordings/node-version-<hash>.json
```

Declared output never executes anything, so it renders identically everywhere. For real commands, run

```sh
reelscript record demos/terminal.ts
```

once, or in CI whenever your CLI changes. It executes every `terminal.run` that has no `output`, in the script's folder unless the run gives a `cwd`, captures stdout and stderr with timestamps, and saves `recordings/<command-slug>.json` next to the script. A command that exits with an error is still saved, since a demo may mean to show a failure, and `record` warns about it. When you change a command, its old recording stays until you run `record --prune` with every script that shares the folder. Commit the recordings; they're small JSON.

Rendering replays a recording with long silences capped (`maxGapMs`) and an optional `speed`, and never needs the tool installed. Commands run through a shell with `FORCE_COLOR=1` and a 256-color `TERM`, without a pseudo-terminal, so tools that insist on a TTY for progress bars print their plain output. A full-screen program (an agent's TUI, an editor) needs a real terminal: record it elsewhere at a fixed size (`script -r`, asciinema) and play it with `terminal.run(cmd, { events })` or `terminal.print("", { events })` in a terminal opened with the same `cols` and `rows`. See [examples/terminal.ts](examples/terminal.ts).

## Narration

`say()` uses [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) through the optional `kokoro-js` dependency, loaded only when a script calls `say()`. The model, about 90 MB, downloads on first use; `reelscript warmup` fetches it ahead of time, and the container has it built in. Spoken lines are cached by text and voice, so re-renders don't re-synthesize unchanged lines. Voices include `af_heart` (the default), `af_bella`, `am_michael`, `bf_emma`, and `bm_george`. `pronunciations` respells words the voice gets wrong, e.g. `{ Reelscript: "Reel script" }`.

GIF output has no audio track; narration still paces the timeline. Render to `.mp4` for sound.

To use another voice engine, pass `tts`: any object with a stable `id` (part of the cache key) and `synthesize(text, { voice, speed })` returning `{ audio, sampleRate }`, where `audio` is mono `Float32Array` samples in [-1, 1]. `kokoro(model?)` builds the default engine. Don't install with `--omit=optional` to skip Kokoro: npm also ships sharp's platform binaries as optional dependencies, and image processing breaks without them.

## Run in CI

`check` is the guard. It drives the real app through the whole timeline with nothing captured or encoded, in a few seconds, and fails when the UI changes under a script, pointing at the line:

```text
reelscript: target "#new-project" was not found or never became visible in the browser window
  at demos/signup.ts:14:19 (cursor.moveTo)
```

Run it on every pull request next to your tests, and render on `main`.

The container is the canonical render environment, for amd64 and arm64. Chromium, ffmpeg, fonts, VS Code, and the narration model are built in, so a script renders the same pixels on every machine:

```sh
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -v reelscript-cache:/cache \
  ghcr.io/trevin-lee/reelscript:0.4.0 render demos/signup.ts
```

Use the tag that matches your npm version (`latest` is the newest release). `--user` makes the files it writes yours; without it, on Linux they belong to root. What a render adds, editor extensions and spoken lines, goes in `/cache`; mount a volume there, as above, to keep it between runs. In GitHub Actions:

```yaml
jobs:
  demo:
    runs-on: ubuntu-latest
    container: ghcr.io/trevin-lee/reelscript:0.4.0
    steps:
      - uses: actions/checkout@v5
      - run: reelscript check demos/*.ts
      - run: reelscript render demos/signup.ts
      - uses: actions/upload-artifact@v5
        with:
          name: demo
          path: demos/out/
```

Scripts may `import { createDemo } from "@reelscript/cli"` without installing the package; the CLI resolves it to its own copy.

## Use it from a coding agent (MCP)

`reelscript mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server, so Claude Code or any MCP client can write and iterate on demos itself:

```sh
claude mcp add reelscript -- npx -y @reelscript/cli mcp
```

| Tool | What the agent gets |
| --- | --- |
| `reelscript_docs` | This README. |
| `inspect_page` | Visible buttons, links, and inputs on a URL, each with a suggested selector and position, plus a screenshot. Takes a `session` for pages behind a sign-in. |
| `record_script` | Runs scripts' real terminal commands and saves recordings; with `prune`, also removes recordings none of the listed scripts uses. |
| `check_script` | Runs the timeline without rendering; passes, or names the script line that failed. |
| `preview_frame` | The frame at a given second, as an image the agent can look at. |
| `render_script` | The final `.mp4` or `.gif`. |

`check_script`, `preview_frame`, and `render_script` click through your real app and run the script's `call()` code, and `record_script` runs shell commands, so none of them is marked read-only.

## CLI

```text
reelscript render  <script> [--out demo.mp4]     render a script to .mp4 or .gif
reelscript preview <script> --at <seconds> [--out frame.png]
                                                 render one frame as a PNG
reelscript check   <script> [more scripts...]    run the timeline without rendering
reelscript record  <script> [more...] [--prune]  run terminal commands for real and save recordings
reelscript login   <url> [--out session.json]    sign in once in a real browser; save the session
reelscript warmup  [narration] [editor]          download the voice model and VS Code ahead of time
reelscript cache   [clear <part|all>]            show or clear what's cached on disk
reelscript mcp                                   MCP server (stdio) for coding agents
reelscript --version
```

A script must call `demo.render()`; if it finishes without doing so, every command fails rather than passing silently.

| Environment variable | Effect |
| --- | --- |
| `REELSCRIPT_CACHE` | Cache folder. Default: `~/.cache/reelscript` |
| `REELSCRIPT_FFMPEG` | ffmpeg to use instead of the bundled one |
| `REELSCRIPT_CODE_SERVER` | code-server binary to use instead of downloading one |
| `REELSCRIPT_MODELS` | Folder for the narration model |

## Cache

reelscript keeps downloads and generated audio in one folder, `~/.cache/reelscript` unless `REELSCRIPT_CACHE` says otherwise. `reelscript cache` lists it:

| Part | What it holds |
| --- | --- |
| `editor` | VS Code (code-server), about 200 MB compressed |
| `extensions` | Editor extensions installed from Open VSX or `.vsix` |
| `narration` | The Kokoro voice model, about 90 MB |
| `narration-clips` | Spoken lines, reused while their text and voice are unchanged |

`reelscript cache clear <part>` deletes one part and `reelscript cache clear all` deletes everything; each is downloaded or generated again when next needed. In the container, VS Code and the voice model are built in and aren't cleared.

## API

| Call | What it does |
| --- | --- |
| `createDemo(options)` | Start a demo. Options below. |
| `demo.render(path)` | Render to `.mp4` (H.264, with narration) or `.gif` (palette-optimized, silent); any other extension is an error. `path` is relative to the script. |
| `demo.check()` | What `reelscript check` runs: the timeline against the real app, no rendering. |
| `demo.getTimeline()` | The actions queued so far, for tests. |
| `demo.cursor.moveTo(target, { ease, duration, window })` | Glide to a target. Duration defaults from distance. Eases: `smooth`, `snappy`, `overshoot`, `linear`. |
| `demo.cursor.click({ button, duration })` | Click at the cursor, with a ripple. Focuses and raises the window under the cursor. `duration: 0` takes no video time, so a following `waitFor` cuts straight to the page the click led to. |
| `demo.type(selector, text, { wpm, window })` | Focus a field and type at `wpm` (default 300), in the focused window or the one named by `window`. |
| `demo.press(key)` | Press a key or chord, e.g. `"Enter"`, `"Control+K"`. |
| `demo.wait(ms)` | Hold, on camera. |
| `demo.waitFor(selector, { window, timeout, settle })` | Hold, off camera, until the selector is visible, then run the page's clock `settle` ms more. The page keeps running, so its loading isn't filmed. |
| `demo.call(({ page, context }) => ...)` | Run your code at this point, off camera, and wait for it. Gets the focused window's Playwright `page` and the browser `context`. |
| `demo.zoom.to(target, { scale, duration, ease, window, within })` | Animate a zoom centred on a target; runs alongside the actions that follow. `within: "window"` keeps the view inside the target's window. |
| `demo.zoom.out({ duration, ease })` | Return to the whole desktop. |
| `demo.say(text, { voice, speed })` | Queue narration. Starts now or after the previous sentence, while following actions run. |
| `demo.waitForNarration()` | Hold until everything queued with `say()` has been spoken. |
| `demo.browser.open({ x, y, width, height })` | Open the browser window without navigating. Optional; `goto()` opens it too. |
| `demo.browser.goto(url, { hold })` | Navigate, then hold on the loaded page for `hold` ms (default 400). `settle` is the old name and still works. |
| `demo.browser.mockAPI(pattern, json, { status })` | Answer matching requests from every window with canned JSON. Opens no window. |
| `demo.terminal.open({ title, prompt, fontSize, lineHeight, cols, rows, x, y, width, height })` | Open a terminal window. `cols` and `rows` fix its size in characters; `lineHeight: 1` (default 1.3) joins block characters, as full-screen programs expect. |
| `demo.terminal.run(cmd, { output, events, duration, wpm, speed, maxGapMs, prompt, cwd })` | Type `cmd`. With `output`, stream that text; with `events`, play those timed chunks; with neither, replay its recording. `prompt: false` leaves the command running for `print()`. `cwd`, relative to the script, is where `reelscript record` runs it. |
| `demo.terminal.print(text, { duration, events, speed, maxGapMs, prompt })` | More output with no command typed, after a `run` with `prompt: false`. |
| `demo.editor.open({ workspace, extensions, settings, notifications, x, y, width, height })` | Open VS Code on a copy of a folder. `extensions` are Open VSX ids, `.vsix` files, or extension folders. `settings` merge over demo-friendly defaults; `notifications: true` shows VS Code's toasts. Reopening with a different workspace, extensions, or settings starts a fresh VS Code. |
| `demo.editor.openFile(path, { wpm })`, `demo.editor.command(name, { wpm })` | Quick Open (Ctrl+P) or the Command Palette (F1), typed visibly. Fails if VS Code finds no match. |
| `demo.editor.type(text, { wpm })` | Bring the editor forward and type at its caret. Auto-closing brackets and auto-indent are off, so typed code lands as written. |
| `demo.editor.file(name)`, `demo.editor.tab(name)` | Selectors for an Explorer row and an editor tab. |
| `.focus()`, `.place({ x, y, width, height })`, `.close()` on `browser`, `terminal`, `editor` | Bring forward, move or resize (`x, y` is the frame's corner on the desktop; `width, height` the content size), or take off the desktop; a closed window can be opened again. |

`createDemo` options:

| Option | Default | What it does |
| --- | --- | --- |
| `viewport` | `[1280, 800]` | Content size of the first window opened. |
| `desktop` | first window plus margins | Output size. |
| `theme` | `"macos"` | `"macos"` draws a desktop, menu bar, and window frames; `"bare"` shows window content only. |
| `fps` | `60` | Output frame rate. |
| `camera` | `"manual"` | `"follow"` zooms toward clicks and typing on its own; `{ scale, holdMs }` tunes it. |
| `clock` | `"2025-09-23T09:41:00"` | The moment the demo happens at: a `Date`, or an ISO string, read in `timezone` unless it has an offset. `new Date()` gives the real time. |
| `timezone` | `"UTC"` | IANA timezone for the page and the menu bar. |
| `session` | none | A saved login from `reelscript login`, relative to the script. |
| `address` | none | `(url) => string`, rewriting what the browser's address pill shows. |
| `menubar` | `{ app: "reelscript" }` | The macOS menu bar's `{ app, clock }` text; `clock` defaults to the demo's clock. `false` removes the bar. |
| `voice` | `"af_heart"` | Narration voice. |
| `tts` | Kokoro | Voice engine; see Narration. |
| `pronunciations` | none | Respellings for the voice, e.g. `{ Reelscript: "Reel script" }`. |
| `gif` | `{ width: 960, fps: 20 }` | Size and frame rate for `.gif` output. |
| `recordingsDir` | `"recordings"` | Where terminal recordings live, relative to the script. |
| `deterministic` | `true` | Step the page's clock one frame at a time. `false` lets the page run in real time (the date is still pinned). |
| `verbose` | `true` | Print progress and the output summary. |

## Status

Pre-1.0: the API can still change between minor versions, and the changelog says how. Roadmap, roughly in order:

- Captions generated from narration (SRT and burned-in)
- `reelscript generate`: point it at a URL with a sentence and get a script
- `watch` mode with live preview while editing a script
- Window open and close animations, and drag-to-move
- Editor: seed the integrated terminal, and place the caret per file
- Pseudo-terminal recording for TTY-only tools
- Retina (2x) output
- Transitions between scenes, and callouts
- A Linux desktop backend for demos of native apps

## License

MIT
