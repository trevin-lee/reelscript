# reelscript

**Product demos as code.** Write a script, render a demo, re-run it in CI when your UI changes.

Screen-recording tools (Screen Studio, Arcade, Tango) all rot the same way: your product UI changes and your beautiful demo is now a lie, so you re-record it by hand. reelscript makes a demo a *build artifact* — the video is generated from a script, so when your UI updates you just re-run it.

## The idea

- **Code-first, not a UI timeline.** The demo is a script you version, diff, and review.
- **Deterministic offline rendering.** Because every step is scripted, frames are composited offline (drive the DOM to state N, overlay an animated cursor + auto-zoom, capture, encode) — perfect 60fps with no dropped frames, runnable headless in CI.
- **Cinematic layer.** Smooth cursor easing, zoom-to-cursor, accelerated typing, transitions — the polish that makes a demo feel produced.
- **Own the DOM.** `mockAPI()` and seeded data mean demos never depend on a live backend, real credentials, or flaky auth.
- **Clean stage.** Recording targets a mocked desktop/browser, so no clearing your real desktop or dodging notifications.

## Status

Very early. The timeline API is taking shape; the render engine is not built yet.

## Example

```ts
import { createDemo } from "reelscript";

const demo = createDemo({ theme: "macos", viewport: [1280, 800], fps: 60 });

await demo.browser.goto("https://app.local");
await demo.cursor.moveTo("#new-project", { ease: "smooth" });
await demo.cursor.click();

demo.zoom.to("#modal", { scale: 1.5, hold: 1200 });
await demo.type("#name", "Acme Q3 Launch", { wpm: 400 });
demo.zoom.out();

await demo.render("out.mp4");
```

## License

MIT
