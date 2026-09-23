# reelscript

**Product demos as code.** Write a script, render a demo, re-run it in CI when your UI changes.

![reelscript rendering a demo of a sample app: cursor glides to a button, a modal opens, the view zooms in, text is typed, and the zoom releases](https://raw.githubusercontent.com/trevin-lee/reelscript/main/docs/demo.gif)

<sup>This GIF is a demo of reelscript made with reelscript: CI renders [examples/basic.ts](examples/basic.ts) on every push to `main` and commits the result.</sup>

Screen-recording tools (Screen Studio, Arcade, Tango) all rot the same way: your product UI changes and your beautiful demo is now a lie, so you re-record it by hand. reelscript makes a demo a *build artifact*. The video is generated from a script, so when your UI updates you just re-run it.

```ts
import { createDemo } from "@reelscript/cli";

const demo = createDemo({ theme: "macos", viewport: [1280, 800], fps: 60 });

await demo.browser.goto("https://app.local");
await demo.cursor.moveTo("#new-project", { ease: "smooth" });
await demo.cursor.click();

demo.zoom.to("#modal", { scale: 1.6 });
await demo.type("#project-name", "Acme Q3 Launch", { wpm: 400 });
await demo.cursor.moveTo("#create");
await demo.cursor.click();
demo.zoom.out();

await demo.render("out/demo.mp4");
```

## How it works

- **Code-first, not a UI timeline.** The demo is a script you version, diff, and review.
- **Deterministic offline rendering.** Every step is scripted, so frames are produced one at a time: drive a headless Chromium to the state for frame *n*, capture it, composite the animated cursor and zoom, and pipe it to ffmpeg. Perfect 60fps with no dropped frames, and it runs headless in CI.
- **The page's clock is virtual.** reelscript replaces timers, `requestAnimationFrame`, `Date`, and `performance.now` inside the page and steps CSS transitions through the Web Animations API, advancing exactly one frame per rendered frame. A 200ms fade is 12 frames at 60fps no matter how slow capture is.
- **Cinematic layer.** Eased cursor motion, click ripples, zoom-to-element, accelerated typing. The polish that makes a demo feel produced, done as math over frames rather than captured motion.
- **Own the DOM.** Targets are CSS selectors, and `browser.mockAPI()` returns canned JSON so demos never depend on a live backend, real credentials, or flaky auth.
- **Clean stage.** The `macos` theme composites the page into a browser window on a mocked macOS desktop, so there is nothing to tidy up before recording.

## Install

```sh
npm install -D @reelscript/cli
npx playwright install chromium
```

The package installs a `reelscript` command. (The unscoped name is blocked by npm's similarity rule against `rescript`, hence the scope.)

## Try it

```sh
git clone https://github.com/trevin-lee/reelscript && cd reelscript
npm install
npx playwright install chromium
npm run example            # renders examples/basic.ts -> out/basic.mp4
```

The example drives a small dashboard app that ships with the repo, so it is fully self-contained. A 6.5s demo at 1424x992 / 60fps renders in about 15s on an M-series laptop.

## CLI

```sh
reelscript render  <script.ts> [--out demo.mp4]        # render a script to video
reelscript preview <script.ts> --at 2.5 [--out f.png]   # render the single frame at 2.5s
```

`preview` is the fast way to iterate on a moment of a demo without waiting for the whole video.

## API

| Call | What it does |
| --- | --- |
| `createDemo({ theme, viewport, fps, deterministic, gif })` | `theme`: `"macos"` or `"bare"`. Defaults: macos, 1280x800, 60fps, deterministic clock on. |
| `demo.browser.goto(url, { settle })` | Navigate, then hold for `settle` ms (default 400). |
| `demo.browser.mockAPI(pattern, json, { status })` | Fulfil matching requests with canned JSON. |
| `demo.cursor.moveTo(target, { ease, duration })` | Glide to a selector or `{x, y}`. Duration defaults from distance. Eases: `smooth`, `snappy`, `overshoot`, `linear`. |
| `demo.cursor.click({ button })` | Click at the cursor, with a ripple. |
| `demo.zoom.to(target, { scale, duration, ease })` | Animate a zoom centred on a target. Runs alongside the actions that follow. |
| `demo.zoom.out({ duration, ease })` | Return to 1x. |
| `demo.type(selector, text, { wpm })` | Focus the field and type at `wpm` (default 300). |
| `demo.press(key)` | Press a key or chord, e.g. `"Enter"`, `"Meta+K"`. |
| `demo.wait(ms)` | Hold. |
| `demo.render(path)` | Render to `.mp4` (H.264) or `.gif` (palette-optimized, 960px / 20fps by default, see `gif` option). Honours `REELSCRIPT_OUT` and `REELSCRIPT_SNAPSHOT_AT`, which the CLI uses. |

## Status

Early but working end to end. Roadmap, roughly in order:

- Auto-zoom that follows the cursor, and zoom transitions with a bit of drift
- `watch` mode with live preview while editing a script
- Retina (2x) output
- Transitions between scenes, captions and callouts
- Python bindings over the same timeline
- A Linux desktop backend (Xvfb in a container) for demos of native apps, targeted by coordinates or accessibility names

## Requirements

Node 20+. ffmpeg is bundled via `ffmpeg-static`; set `REELSCRIPT_FFMPEG` to use your own.

## License

MIT
