# Changelog

## 0.4.0

Closes the gaps in 0.3.1: places where the tool let a broken demo pass, promised more than it did, or behaved differently in two places. Renders of the same script are the same in more places, and a script that worked with 0.3.1 may need the changes listed first.

**Changes that can affect existing scripts**

- **Paths in a script are relative to the script's folder**, including `demo.render(path)` and the `recordingsDir` option, which were relative to the working directory. Paths on the command line are still relative to the working directory. A script run from its own folder is unaffected; otherwise its output moves next to it.
- **The page's date is pinned** to Tuesday, September 23, 2025, 9:41 AM UTC by default, matching the menu bar, instead of the real time at render. Pass `clock: new Date()` for the real time, or set `clock` and `timezone`.
- **VS Code has the macOS keybindings**, like the browser and the desktop around it: press `Meta+…` in the editor where scripts pressed `Control+…` (`Meta+ArrowDown` for the end of a file). Its menus show ⌘.
- **`menubar: { clock }` is now `menubar: { clockText }`**, since `clock` elsewhere is a moment, not text. `clock` still works there until 1.0.
- **The browser window is Chrome on a Mac on every host**, like the desktop: pages show the same shortcut hints in a local preview as in the container, and a site that checks the user agent or client hints for a headless browser sees an ordinary one. Press `Meta+…` for a page's own shortcuts (a script that pressed `Control+K` in the container needs `Meta+K`); editing shortcuts in its fields (`Meta+A`, `Alt+ArrowLeft`) do what they do on a Mac on every host.
- **The browser window has no tabs**: a link or `window.open()` that would open a new tab opens in the window, instead of in a tab nobody sees.
- **A page's `alert()`, `confirm()` or `prompt()`**, which isn't drawn in the video, is answered OK with a warning at the line, rather than cancelled silently (a confirmed delete stayed undeleted). The README lists what else Chromium draws outside the page: a `<select>`'s list, pickers, context menus, tooltips.
- **`pronunciations` respell whole words**: `{ SQL: "sequel" }` leaves PostgreSQL alone.
- **`goto({ settle })` is now `goto({ hold })`**, because `settle` elsewhere means time off camera. `settle` still works on `goto` until 1.0.
- **Clicks and `moveTo` are checked.** A script that moved to an element off screen, or clicked one covered by a window or an overlay, used to pass and film the wrong thing; now it fails at that line. Add `demo.scroll()` or `focus()` where needed.
- `render`, `RenderOptions`, `recordCommand`, `scriptedEvents`, and `playbackEvents` are no longer exported; they were internal.

**`check` can be trusted**

- An editor file or command that VS Code can't find fails at its script line, instead of pressing Enter on "No matching results" or a similar command.
- A script that never calls `demo.render()` fails instead of passing silently, and `render`, `preview` and `record` don't take a `demo.check()` for one (they exited 0 having written nothing).
- A missing terminal recording names the script line.
- Options render can't use fail at their `createDemo()` line: `fps`, `viewport`, `desktop` and `gif` sizes that aren't positive numbers (they failed in ffmpeg or sharp partway through a render), and a misspelt `theme`, `timezone` or `clock`. Number options on actions fail where they're queued too: a `wpm` or `speed` of 0, or a string, hung the render, and a negative `wait` ran time backwards. (`maxGap: Infinity`, which keeps every silence in a recording, is still allowed.)
- A missing `session` file names the `createDemo()` line.
- A misspelt option name fails where it's written, with the name it probably meant (`viewPort`: did you mean `viewport`?), as a misspelt value does; scripts run without type-checking, so `duraton: 3000` used to be ignored. Inside `camera`, `menubar` and `gif` too.
- `check` fails, at the `say()` line, when the voice engine can't run (no `kokoro-js` installed) for a line `render` would have to synthesize.
- The CLI names what's missing instead of doing something else: an option without its value (`--out` last), a value on an on/off option (`--prune=no`), a command with no script, `cache clear` with no part, an unknown `cache` command.
- `openFile()` and `command()` accept only the file or command asked for. VS Code's search offers a near match for almost anything (webapp.ts for "app.ts"), and that used to be opened while `check` passed; now it fails at the line and names what VS Code offered. `editor.file()` and `editor.tab()` match exact names too, and the folder the file is directly in when you give one (`"src/app.ts"`, spaces included).
- A script path that doesn't exist is named plainly, instead of with Node's module error.

**Fixes and additions**

- A page with scroll-driven animations (github.com has them) no longer stops the render with "Invalid currentTime": the page clock steps time-based animations only, and leaves one that follows the scroll position to the page.
- Renders no longer idle for about 10 seconds after finishing.
- With npm 12, which blocks dependencies' install scripts unless a project allows them, ffmpeg-static's binary is never downloaded: reelscript then uses an `ffmpeg` on your PATH, or names the two commands that fetch it, instead of failing with `spawn ENOENT`. The README's install says so too.
- `reelscript warmup browser` installs the Chromium build reelscript drives, and the README uses it: in a project with its own Playwright, `npx playwright install` fetched that version's build, and the error it led to sent you round in a loop. `warmup` with no parts includes it, and it checks the browser starts: on Linux, `--with-deps` installs Chromium's system libraries, and a launch that fails for lack of them names them and that command. A missing browser names the command wherever it's found, in a form that also works without a local install (for MCP); `login` says it can't show a browser only where that's so; `reelscript cache` lists the browser, and `cache clear browser` removes it (`clear all` leaves it, since other projects share it).
- A target is its first visible match, so a hidden copy (a collapsed mobile menu) no longer fails the step, and several visible matches are a warning at the line.
- MCP: `inspect_page` lists elements inside web components, suggests selectors that find text fields (by placeholder or label; `has-text` never matched them), and never shows what's typed in a field, such as a password.
- Terminal output ending in a newline no longer leaves a blank line before the next prompt, and `prompt` on `run()` and `print()` can be a string: the prompt from then on, after a `cd`, say.
- GIFs aren't scaled up past the video's width, and the summary gives the GIF's own size and frame count.
- An unknown command is named before the usage.
- The README's commands all run after its own install step (`npx reelscript login`, `record`, `warmup narration`), and its extension section says to build the extension first.
- Ctrl-C during `record` saves nothing, so the recordings a render replays stay as they were (it overwrote them with partial and empty ones); `check` warns about a recording that never finished.
- A click, or a page's own redirect, that lands on an HTTP error page is a warning at the line, as a `goto()` that does is.
- A terminal whose `cols` and `rows` don't fit its window warns that the rest is cut off (the README's asciinema recipe says to give it room).
- MCP `inspect_page` suggests one element per selector (`:text-is` for a short label, and which one when several share it, such as an Edit in every row) and says when it lists only the first 80.
- The README says what recorded commands print without a pseudo-terminal (`ls` one name per line, `git` without colour) and the flags that change it. An empty `REELSCRIPT_CACHE` counts as unset, as an empty `REELSCRIPT_MODELS` does; it made `cache clear all` clear the working folder.
- The test suite never clears a contributor's own `REELSCRIPT_MODELS` folder, and an empty `REELSCRIPT_MODELS` counts as unset.
- No `module.register()` deprecation warning on every command under Node 26 (the Node Homebrew installs), nor in MCP results.
- A `goto()` nothing answers says so (is the app running?), and in the container explains that `localhost` is the container and how to reach your machine; the README says so too.
- The README states the one exception to the path rule (Playwright's own calls in `demo.call()`), with a recipe for choosing a file to upload. `record`'s warnings name the script line, and typing while the terminal has focus says how to name the field's window.
- `demo.press("Meta+K")` sends the key a Mac does, `k`, so a command palette listening for it opens (it sent `K`).
- A function a script passes to `page.evaluate()` in `demo.call()` can use named helpers; tsx's `__name` wasn't defined in the page.
- Ctrl-C during `login` saves nothing and leaves any session already there as it was.
- Typed YAML lands as written in the editor; VS Code's own YAML settings turned auto-indent back on.
- A local page's paths from the root (`/pricing.html`, a built app's `/assets/...`) are its folder's, as a site's root would be.
- `check`, `render` and `record` with several scripts run them all, report each failure, and end with how many failed; the first failure used to stop the rest without a word.
- `until` matches in any case and says when the text never came; `record` stops what a command left running before exiting; a voice engine that returns no audio fails clearly (it made the render run forever); `clock: "now"` means the real time, as in MCP.
- The README says a live server's data is stamped with the real date (and what to do), and its CI recipe starts the app.
- `terminal.run(cmd, { until })`: `record` stops a command that keeps running (a dev server) once its output shows that text, as meant, instead of at its two-minute limit with a warning (and a failure under `--strict`).
- A recorded command doesn't see the settings the CLI passes itself, so recording a command that runs reelscript records what it really does.
- `check` and `render` warn about a recording of a command that failed (without the run's `exitCode` saying so) or was cut off, so `check --strict` catches it in CI; it was a warning only at `record`. MCP's `record_script` is strict by default.
- `demo.scroll(selector)` takes the first visible match like every other target, and warns when several are; it falls back to the first on the page only for content that appears once it's scrolled to.
- MCP `inspect_page` says when a local page isn't there, and when a page answered with an HTTP error.
- `render -h` shows the help, `cache clear` says when there was nothing to remove, and counts read "1 frame" and "an alert()".
- The page clock leaves a page's own control of its animations alone: what the page pauses (`pause()`, `animation-play-state: paused`) stays paused, where it seeks is where the clock goes on from, and what it finishes stays finished. The clock stepped them all.
- Local pages (`goto("./app.html")`) are served from this machine over http, not opened as files: their `fetch("/api/...")` reaches `mockAPI`, their cookies stick, ES modules load, and video can seek. A local page that isn't there fails with its path.
- `demo.scroll(selector)` goes to content that only appears once it's scrolled into view (a reveal-on-scroll section), and a target that's there but not visible says so, with a hint to scroll to it.
- A script can say a warning's cause is meant, so `--strict` passes it: `goto(url, { status: 404 })`, `terminal.run(cmd, { exitCode: 1 })`, and `cursor.click({ dialog: "accept" | "dismiss" })`, which also answers the dialog as asked.
- `open()` on an open terminal or editor keeps what isn't passed (an editor moved with `{ x, y }` kept no workspace, a terminal given a font lost its prompt).
- A failed run leaves earlier output alone: under `render --out`, a script that fails after its render puts the previous video back, and `record` writes recordings only once every command has run (and, with `--strict`, without warnings). The video is there as soon as `render()` returns, so a script can cut or caption its own render.
- `demo.type()` needs the keys to land in a text field (a button took a space as a click); `preview` of a script that renders twice shows the first; MCP tool calls that are cancelled stop the run.
- Content that reacts to scrolling (a reveal-on-scroll, an IntersectionObserver) renders the same every time: after a page loads and after each scroll step, the page renders on its own frames, which is when Chromium delivers those callbacks, before its clock moves on. Renders of such pages differed visibly.
- A fade or slide that a click starts renders the same every time: Chromium also runs it on its compositor, and the clock held it before that copy had started, which now and then left the click's frame showing it a frame in.
- An action missing what it can't do without fails where it's queued: `wait()` with no time hung the render, and `scroll()` needs a selector or exactly one of `{ by }` and `{ to }`.
- `login` without a terminal (an agent's shell, stdin from /dev/null) waits for the window to close instead of saving at once, and never writes an empty session, least of all over one that works.
- MCP: `check_script` is strict by default, as `check --strict` in CI, and `render_script` takes `strict`; `inspect_page` takes a `clock` and `timezone` like a demo's, so a session for an app that checks its token's expiry works there too.
- A target counts as visible only when a viewer could see it: an element inside something faded all the way out (a closed modal at `opacity: 0`) isn't, for targets, `waitFor`, the caret and MCP's `inspect_page` alike. The repo's own example let a script aim at its closed dialog and pass.
- `demo.type()` fails on a field that can't take the keyboard (disabled, read-only, not a text field), instead of typing into whatever had it before.
- A cookie the page sets to expire in a month, by its pinned date, is kept; Chromium judged it by the real date and dropped it at once (a consent banner that came back).
- `render --strict` with warnings leaves the previous video in place, like any failed render.
- The README shows your own first script (check, preview, render) right after Install, says a target is in the window's page and not inside an iframe (with the off-camera way to fill one), and that a saved sign-in wants `clock: new Date()` when the app checks its token's expiry. The CLI help shows `preview --at` as optional and `cache clear` taking several parts.
- `demo.scroll(selector)` scrolls across as well as down, so a card in a carousel, a column of a wide table or a board comes into view; it only scrolled down, and the next step's hint to scroll sent you round in a loop.
- `record` runs a command at the size of the terminal it runs in when the script fixes one (`cols`, `rows`), so its lines wrap as they will on screen.
- `check --strict` (and `render`, `record`) fails on warnings too, for CI: a page that answered 404, a mock no request used, an ambiguous target.
- `warmup` refuses a misspelt part before downloading anything. `login` opens the same browser a demo uses (Chrome on a Mac), without the automation flag some sign-in pages refuse. Command hints in errors all read `npx @reelscript/cli …`, which works with or without a local install.
- The README says a page's fonts come from the machine (`system-ui` is San Francisco on a Mac, a Linux font in the container).
- `scroll({ by })` and `scroll({ to })` move an app's own scrolling area when the page itself doesn't scroll (the usual app layout, where they did nothing), and fail when nothing on the page scrolls.
- A script that renders twice (an MP4 and a GIF) runs each command once under `record`, and `--out` or `preview`, which name one output, refuse it instead of overwriting one render with the other.
- A format `render` can't write is refused before narration is synthesized (and before the voice model downloads).
- VS Code's logs stay in each run's temporary folder instead of piling up in `~/.local/share/code-server`.
- `cache clear` takes several parts, like `warmup`, and refuses a misspelt one before removing anything; `login` names a missing web address.
- The README says network responses arrive in real time, and how to keep them out of the timing.
- `editor.type()` after clicking a file in the Explorer types into the file; the keys went to the Explorer (and selected files) while `check` passed. With no file open, it fails at its line.
- Opening a terminal that's open applies a new `fontSize` or `lineHeight` too, as the README's rule for `open()` now says.
- A `goto()` that gets an HTTP error is a warning at its line: a renamed page would otherwise be filmed as the site's error page.
- In a project without `"type": "module"`, the script's temporary copy is gone before the script runs, so it no longer shows in a demo's terminal (`ls`, `git status`) or the editor's Explorer.
- The browser's request headers match what its scripts see (Chrome on macOS, not HeadlessChrome), and `navigator.webdriver` is false. MCP `inspect_page` shows the page as a demo's browser does: Chrome on a Mac, on the demo's default date and timezone.
- `CHANGELOG.md` ships in the package and the README links it.
- A voice engine of your own has its own default voice (`defaultVoice`, or the first of its `voices`), not Kokoro's `af_heart`; the README documents `defaultVoice` and `ready()`.
- `goto("/pricing")` is a page on the site the browser is showing, as a path is in `mockAPI`, not a file at the root of the disk; with no site showing it says so. MCP `inspect_page` takes a local page's path.
- `reelscript cache` counts the browser at its real size, and output piped into `head` ends quietly.
- Scripts without top-level `await` run in projects without `"type": "module"` too, as the README promised, and errors from such a script name it rather than its temporary copy.
- `record --prune` works with scripts that have no recordings folder.
- `mockAPI("/api/projects")` matches that path on any origin and with any query, as a path suggests (a pattern was only a URL glob, which a bare path never matched); the README gives the forms, and a mock nothing requested is a warning at its line.
- `terminal.open({ cols })` or `{ rows }` alone fixes that one and fits the other; it was ignored without both.
- `preview --at` past the end fails with the demo's length, instead of quietly returning the last frame.
- A failure in the page clock itself is a warning, once, instead of silently leaving that page's animations on real time.
- `close()` on every window, and `browser.open(geometry)` to place the browser without navigating. `mockAPI` applies to the browser window without opening it.
- `clock` and `timezone` options; the menu bar shows the demo's clock.
- `reelscript cache` lists what's cached and `reelscript cache clear <part|all>` removes it; `reelscript warmup` also downloads VS Code. The parts share names with `warmup` (`narration`, `editor`).
- `reelscript record` takes several scripts, warns when a command fails, and `--prune` removes recordings no script uses.
- `reelscript login` and the session-not-found error print the exact paths to use, so following the error can't loop.
- The container image is built for amd64 and arm64, each tested on its own architecture. VS Code and the voice model are built in, and `/cache` holds what a render adds, so a volume there keeps extensions and spoken lines between runs. It runs as any user; the README shows `--user` so files it writes on Linux are yours.
- MCP: `inspect_page` takes a `session`; a new `record_script` tool that takes every script sharing a recordings folder; tools that drive the real app are no longer marked read-only; the container includes the README that `reelscript_docs` serves.
- `reelscript --help` exits cleanly, and progress lines are plain in CI logs.
- A closed editor opens again, and reopening it on a different workspace, extensions, or settings starts a fresh VS Code. Stopping VS Code now stops every process it started.
- Rendering to anything but `.mp4` or `.gif` is an error up front, and a render stops with ffmpeg's error instead of hanging if ffmpeg quits.
- `editor.type()` brings the editor forward before typing, and `demo.type()` takes a `window` and fails like other targets when its selector is missing.
- `reelscript record` runs commands in the script's folder, or a run's `cwd`, so recordings don't depend on where you ran it from.
- Calling `demo.check()` from a script counts as the script's run, and honours `verbose`.
- Error messages about a window that isn't open name the call that opens it.
- A failed render leaves the previous output in place; the new file replaces it only once rendering succeeds.
- The page clock handles `Date()` called without `new`, and pages that subclass `Date`. It also covers the time `Intl` formats when given no date and `Temporal.Now`, which showed the real date beside a pinned `Date`, and seeds `Math.random`, so a page's random data is the same on every render.
- `record --prune` only deletes terminal recordings, never other JSON files in the folder.
- Node 20.11 or later is required (20.6 to 20.10 couldn't run scripts in projects without `"type": "module"`).
- **Clicks land where you aimed.** Moving to or zooming on an element outside the visible part of its window fails with a hint to scroll first, and a click on an element covered by another window or an overlay fails at its line instead of clicking what's on top.
- **`demo.scroll(selector | { by, to })`** scrolls on the frame clock, so scrolling renders the same every time. Chromium's smooth scrolling is off, so keys like PageDown jump instead of animating on their own clock.
- The page clock also advances inside iframes.
- A misspelt voice fails `check` at its `say()` line, checked against the demo's own `voice` and `tts` engine, and narration errors name their line. `check` also rejects an output format `render` would.
- On macOS, a render that failed or was interrupted after synthesizing narration no longer aborts with a C++ "mutex lock failed" and exit code 134; it exits with 1, or 130 after Ctrl-C.
- Ctrl-C and termination stop VS Code and remove partial videos and temporary script copies.
- `record` warns clearly when it stops a command at its two-minute limit, and stops everything the command started (`a && b`, `npm run dev`), not just the shell. A command that runs twice, or in two folders, gets a recording for each run.
- Open VSX and `.vsix` extensions install into a mounted `/cache` (they failed with "cross-device link not permitted").
- In the container, `docker stop` and Ctrl-C work from the moment reelscript starts, not only once a browser is open.
- `render` takes several scripts; options a command doesn't take are errors; `--help` works after any command; `preview` checks `--at` and writes only `.png`.
- `demo.scroll()` fails clearly on the editor or terminal, which it can't scroll.
- `check` moves the page's mouse like a render, so hover menus open, and times narration with the real length of lines already synthesized.
- `login` saves IndexedDB too (Firebase and other apps keep their sign-in there), and explains that it needs your own machine when run where there's no visible browser.
- `readAsciicast(path)` plays asciinema recordings (v2 and v3) in a terminal window.
- `demo.type()` requires the field to be on screen, like `moveTo`; `demo.press()` takes a `window`.
- The README is honest about VS Code's real-time clock, and the extension example waits for its result instead of a fixed time.
- `browser.goto("./app.html")` opens a local page relative to the script, like every other path in a script.
- Quick Open and the Command Palette ask again if VS Code hasn't registered an extension's commands or indexed files yet, instead of failing on a slow machine.
- `editor.openFile()` ends once the file is open with the caret in it, and `editor.command()` once VS Code has run it (or moved on to its own prompt), so the next step never races VS Code; this made editor checks flaky on slow machines. `openFile()` also waits for the Explorer to reveal the file, and aiming at something in the editor waits for it to stop moving, so a folder expanding under the cursor can't turn a click into a click on the next row.
- `<video>`, `<audio>` and SVG (SMIL) animations follow the frame clock, so pages with a hero video or an animated SVG render the same every time; a page's own `play()`/`pause()` still work. Animated GIFs can't be controlled and are documented as playing on their own.
- Web components render the same every time too: animations, `<video>`, `<audio>` and SVG in shadow roots, open or closed, follow the frame clock, and their text fields get the drawn caret.
- A `<video>` that can't be moved to the clock's time (served without HTTP Range requests, as `python -m http.server` does) is a warning instead of a silently still picture.
- An odd `desktop` size is rounded up to even numbers, as H.264 needs, instead of failing the `.mp4` render; `goto("./app.html#route")` keeps its query and hash; `record` honours `verbose: false`; `cache clear narration` clears every voice model reelscript downloaded.
- The text caret in web pages blinks on the frame clock: Chromium's own blinks on real time, so two renders differed wherever a field had focus.
- The page clock follows Web Animations the page reverses, slows, speeds up, or replays.
- A misspelt `ease`, `window`, `within`, `button` or `camera` fails where the script sets it; typing or pressing keys in the terminal window fails with a pointer to `terminal.run()`; an extension folder named without `./` is a path; a missing `cwd` fails clearly in `record`.
- The desktop's wallpaper and menu bar are drawn before any page loads, and a screenshot Chromium refuses under load is retried, fixing intermittent `preview` failures on heavy sites.
- `cache clear narration` removes only the Kokoro model, not other files in a `REELSCRIPT_MODELS` folder.
- Option names drop their units: `camera: { hold }` and `maxGap`. `holdMs` and `maxGapMs` still work until 1.0.
- "Built in" in `reelscript cache` now means only the container's own copies; a models folder you set with `REELSCRIPT_MODELS` can be cleared, and a code-server you point at is never deleted.
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
