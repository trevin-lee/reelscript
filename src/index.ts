/**
 * reelscript — product demos as code.
 *
 * Scripts build a timeline through the `Demo` API; `render()` executes it
 * against a headless Chromium, samples the state at a fixed frame rate, and
 * composites the animated cursor + zoom offline before encoding to mp4.
 */

import { render as renderTimeline, type RenderResult } from "./renderer.js";
import type { Action, CallContext, Target } from "./timeline.js";
import { resolveSession } from "./session.js";
import type { Ease } from "./easing.js";
import type { Menubar, ThemeName } from "./theme.js";
import type { GifOptions } from "./encoder.js";
import type { TtsEngine } from "./tts.js";
import type { FollowCamera } from "./renderer.js";
import { recordCommand, saveRecording } from "./terminal.js";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/** "demo.ts:14:7" for the user code that called into the Demo API. */
function callerLocation(): string {
  const stack = new Error().stack?.split("\n").slice(1) ?? [];
  for (const line of stack) {
    const m = line.match(/\(?((?:file:\/\/)?\/[^():]+):(\d+):(\d+)\)?\s*$/);
    if (!m) continue;
    let file = m[1].replace(/^file:\/\//, "");
    if (file.startsWith(LIB_DIR) || file.includes("node:internal") || file.includes("/node_modules/")) continue;
    // Scripts run from a temporary .mts copy (CommonJS projects) report the copy's name.
    if (/\/\.[^/]+\.reelscript\.mts$/.test(file) && process.env.REELSCRIPT_SCRIPT) file = process.env.REELSCRIPT_SCRIPT;
    const rel = relative(process.cwd(), file);
    return `${rel.startsWith("..") ? file : rel}:${m[2]}:${m[3]}`;
  }
  return "unknown location";
}

export type { Action, CallContext, Target } from "./timeline.js";
export type { Ease } from "./easing.js";
export type { Menubar, ThemeName } from "./theme.js";
export type { RenderOptions, RenderResult, FollowCamera } from "./renderer.js";
export type { GifOptions } from "./encoder.js";
export type { TtsEngine, TtsAudio, TtsOptions } from "./tts.js";
export { kokoro } from "./tts.js";
export type { TermEvent, TermRecording } from "./terminal.js";
export { recordCommand, scriptedEvents, playbackEvents } from "./terminal.js";
export { render } from "./renderer.js";

export interface DemoOptions {
  /**
   * A saved login for browser windows, relative to the script: the file
   * `reelscript login <url>` writes. Every browser window starts signed in.
   */
  session?: string;
  /** Visual chrome around the recorded page. Default: "macos". */
  theme?: ThemeName;
  /** Content size of the first window, in CSS pixels. Default: [1280, 800]. */
  viewport?: [number, number];
  /** Desktop (output) size. Default: the first window plus the theme's margins. */
  desktop?: [number, number];
  /** Output frames per second. Default: 60. */
  fps?: number;
  /**
   * "follow" zooms toward clicks and the typing caret automatically and
   * eases out when things go quiet; pass { scale, holdMs } to tune it.
   * Default: "manual" (zoom only on zoom.to()).
   */
  camera?: "manual" | "follow" | FollowCamera;
  /** Freeze the page clock and step it per frame for reproducible animations. Default: true. */
  deterministic?: boolean;
  /** Applied when rendering to a .gif path. Default: 960px wide at 20fps. */
  gif?: GifOptions;
  /** Default narration voice for say(). Default: "af_heart" (Kokoro). */
  voice?: string;
  /** Text-to-speech engine. Default: Kokoro via the optional kokoro-js dependency. */
  tts?: TtsEngine;
  /** Respell words the voice mispronounces, e.g. { Reelscript: "Reel script" }. */
  pronunciations?: Record<string, string>;
  /** Where terminal recordings are stored. Default: `recordings/` next to the script. */
  recordingsDir?: string;
  /** Print render progress to stderr. Default: true. */
  verbose?: boolean;
  /**
   * What the browser window's address pill shows for a page's URL. Default:
   * the host and path. Use it to show a dev server as the public site:
   * `address: (url) => url.replace("http://localhost:3000", "https://example.com")`.
   */
  address?: (url: string) => string;
  /**
   * The macOS theme's menu bar. `false` leaves it out, and the first window
   * moves up into its place; `{ app, clock }` sets what it says. Default:
   * "reelscript" and a fixed clock.
   */
  menubar?: Menubar;
}

export interface MoveOptions {
  ease?: Ease;
  /** Movement duration in ms. Default: derived from distance. */
  duration?: number;
  /** Window to resolve a selector in. Default: the focused window. */
  window?: "browser" | "terminal" | "editor";
}

/** Window position (frame origin, desktop pixels) and content size. */
export interface WindowGeometry {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface ZoomOptions {
  /** Default: 1.6 */
  scale?: number;
  /** Transition duration in ms. Default: 700 */
  duration?: number;
  ease?: Ease;
  /** Window to resolve a selector in. Default: the focused window. */
  window?: "browser" | "terminal" | "editor";
  /**
   * `"window"` keeps the zoomed view inside the target's window, title bar
   * included, so the desktop behind it never shows. The view is moved, not
   * the target: aim near a window's edge and the target is off centre.
   * Default: the whole desktop.
   */
  within?: "window";
}

export interface WaitForOptions {
  /** Window to look in. Default: the focused window. */
  window?: "browser" | "terminal" | "editor";
  /** Give up after this many ms of real time. Default: 15000 */
  timeout?: number;
  /**
   * Once the selector is visible, run the page's clock this many ms more,
   * still off camera, for whatever the page does next (a layout pass, a
   * view fitting itself to its content). Default: 0
   */
  settle?: number;
}

export interface TypeOptions {
  /** Typing speed in words per minute. Default: 300 */
  wpm?: number;
}

export interface SayOptions {
  voice?: string;
  /** Speed multiplier. Default: 1 */
  speed?: number;
}

export interface TerminalOptions {
  /** Window title. Default: "zsh" */
  title?: string;
  /** Prompt string. Default: "~ % " */
  prompt?: string;
  /** Default: 15 */
  fontSize?: number;
  /**
   * Line height, as a multiple of the font's. Default: 1.3. 1 is what most
   * terminal apps use, and joins block characters from row to row, as
   * full-screen programs that draw with them expect.
   */
  lineHeight?: number;
  /**
   * A fixed size in characters, instead of as many as the window holds: for
   * output recorded at that size, such as a full-screen program, whose
   * layout depends on it. Make the window big enough to show it.
   */
  cols?: number;
  rows?: number;
}

export interface RunOptions {
  /** Output to show. Omit to replay a recording made with `reelscript record`. */
  output?: string;
  /**
   * Output as timed chunks, [ms, text], escape codes and all: a recording
   * made elsewhere, of a full-screen program, say. Played with `speed` and
   * `maxGapMs` like a recording.
   */
  events?: [number, string][];
  /** Spread declared output over this many ms. */
  duration?: number;
  /** Typing speed for the command. Default: 300 */
  wpm?: number;
  /** Playback speed for recorded output. Default: 1 */
  speed?: number;
  /** Cap silences in recorded output, in ms. Default: 700 */
  maxGapMs?: number;
  /**
   * Show a new prompt once the output ends. Default: true. With false the
   * command looks as if it is still running, and terminal.print() can go on
   * with its output.
   */
  prompt?: boolean;
}

export interface EditorOptions {
  /** Folder to open, relative to the script. It's copied, so the demo never edits your files. */
  workspace?: string;
  /** Extensions to install first: Open VSX ids like "esbenp.prettier-vscode" or paths to .vsix files. */
  extensions?: string[];
  /** VS Code settings merged over reelscript's demo defaults. */
  settings?: Record<string, unknown>;
  /** Show notification toasts. Default: false */
  notifications?: boolean;
}

export interface GotoOptions {
  /** ms to hold on the freshly loaded page. Default: 400 */
  settle?: number;
}

export interface MockOptions {
  status?: number;
}

class Cursor {
  constructor(private demo: Demo) {}

  /** Glide the cursor to a selector or point. */
  async moveTo(target: Target, opts: MoveOptions = {}): Promise<void> {
    this.demo._push({ kind: "cursor.moveTo", target, ...opts });
  }

  /**
   * Click at the cursor. The click takes `duration` ms of video (default
   * 180), while its ripple plays. With 0, the next action starts at once:
   * follow it with waitFor() and the frame after the click is the page the
   * click led to, not the page on its way there.
   */
  async click(opts: { button?: "left" | "right"; duration?: number } = {}): Promise<void> {
    this.demo._push({ kind: "cursor.click", ...opts });
  }
}

class Zoom {
  constructor(private demo: Demo) {}

  /** Animate a zoom centered on a selector or point. Runs alongside following actions. */
  to(target: Target, opts: ZoomOptions = {}): void {
    this.demo._push({ kind: "zoom.to", target, ...opts });
  }

  out(opts: Omit<ZoomOptions, "scale"> = {}): void {
    this.demo._push({ kind: "zoom.out", ...opts });
  }
}

class Win {
  constructor(
    protected demo: Demo,
    readonly id: "browser" | "terminal" | "editor",
  ) {}

  /** Bring this window to the front and direct typing to it. */
  async focus(): Promise<void> {
    this.demo._push({ kind: "window.focus", window: this.id });
  }

  /** Move or resize this window. */
  async place(geometry: WindowGeometry): Promise<void> {
    this.demo._push({ kind: "window.place", window: this.id, ...geometry });
  }
}

class Browser extends Win {
  constructor(demo: Demo) {
    super(demo, "browser");
  }

  /** Navigate the browser window (opening it if needed) and bring it to the front. */
  async goto(url: string, opts: GotoOptions = {}): Promise<void> {
    this.demo._push({ kind: "browser.goto", url, ...opts });
  }

  /** Intercept matching requests and return canned JSON — demos never hit a live backend. */
  mockAPI(pattern: string, response: unknown, opts: MockOptions = {}): void {
    this.demo._push({ kind: "browser.mockAPI", pattern, response, ...opts });
  }
}

class TerminalWindow extends Win {
  constructor(demo: Demo) {
    super(demo, "terminal");
  }

  /** Open a terminal window on the desktop (beside or over the browser) and focus it. */
  async open(opts: TerminalOptions & WindowGeometry = {}): Promise<void> {
    this.demo._push({ kind: "terminal.open", ...opts });
  }

  /**
   * Type a command and show its output. With `output`, nothing executes;
   * without it, the output is replayed from a recording (see `reelscript record`).
   */
  async run(command: string, opts: RunOptions = {}): Promise<void> {
    this.demo._push({ kind: "terminal.run", command, ...opts });
  }

  /**
   * More output, with no command typed: the rest of a command run with
   * `prompt: false`. Spread over `duration` ms, or given as timed `events`
   * (played like `run`'s, and `text` is then ignored); `prompt: true` ends
   * it with a new prompt.
   */
  async print(
    text: string,
    opts: { duration?: number; prompt?: boolean; events?: [number, string][]; speed?: number; maxGapMs?: number } = {},
  ): Promise<void> {
    this.demo._push({ kind: "terminal.print", text, ...opts });
  }
}

class EditorWindow extends Win {
  constructor(demo: Demo) {
    super(demo, "editor");
  }

  /** Open a real VS Code (code-server) window on a workspace folder and focus it. */
  async open(opts: EditorOptions & WindowGeometry = {}): Promise<void> {
    this.demo._push({ kind: "editor.open", ...opts });
  }

  /** Open a file through Quick Open (Ctrl+P), typing its name. */
  async openFile(path: string, opts: TypeOptions = {}): Promise<void> {
    this.demo._push({ kind: "editor.openFile", path, ...opts });
  }

  /** Run a command through the Command Palette, typing its name. */
  async command(command: string, opts: TypeOptions = {}): Promise<void> {
    this.demo._push({ kind: "editor.command", command, ...opts });
  }

  /** Type into the editor at the caret. */
  async type(text: string, opts: TypeOptions = {}): Promise<void> {
    this.demo._push({ kind: "type", text, ...opts });
  }

  /** Selector for a file or folder row in the Explorer, for cursor.moveTo(). */
  file(name: string): string {
    return `.explorer-folders-view .monaco-list-row[aria-label*="${name}"]`;
  }

  /** Selector for an open editor tab. */
  tab(name: string): string {
    return `.tabs-container .tab[aria-label*="${name}"]`;
  }
}

export class Demo {
  readonly cursor = new Cursor(this);
  readonly zoom = new Zoom(this);
  readonly browser = new Browser(this);
  readonly terminal = new TerminalWindow(this);
  readonly editor = new EditorWindow(this);

  private actions: Action[] = [];
  /** Where in the user's script each action was created, for error messages. */
  private sources: string[] = [];

  constructor(readonly options: DemoOptions = {}) {}

  /** @internal */
  _push(action: Action): void {
    this.actions.push(action);
    this.sources.push(callerLocation());
  }

  /** Type into a field with accelerated, evenly paced keystrokes. */
  async type(target: string, text: string, opts: TypeOptions = {}): Promise<void> {
    this._push({ kind: "type", target, text, ...opts });
  }

  /** Press a key or chord, e.g. "Enter" or "Meta+K". */
  async press(key: string): Promise<void> {
    this._push({ kind: "press", key });
  }

  async wait(ms: number): Promise<void> {
    this._push({ kind: "wait", ms });
  }

  /**
   * Hold the camera until `selector` is visible. Off camera: no video time
   * passes, but the page's clock keeps running, so a page that needs time
   * to load, fetch or animate gets it without its loading being filmed.
   */
  /**
   * Run `fn` at this point of the timeline, off camera: no video time
   * passes, and the render waits for it. For what the page should see happen
   * at a given moment and cannot cause itself, such as a change another
   * client makes on the server. `fn` receives `{ page, context }`: the
   * focused window's Playwright page and the browser context, e.g. to set a
   * cookie or local storage.
   */
  async call(fn: (ctx: CallContext) => unknown): Promise<void> {
    this._push({ kind: "call", fn });
  }

  async waitFor(selector: string, opts: WaitForOptions = {}): Promise<void> {
    this._push({ kind: "waitFor", target: selector, ...opts });
  }

  /**
   * Narrate. Starts speaking now (or when the previous sentence finishes)
   * while the following actions continue. Use waitForNarration() to hold
   * the timeline until speech ends.
   */
  say(text: string, opts: SayOptions = {}): void {
    this._push({ kind: "say", text, ...opts });
  }

  /** Hold until all narration queued so far has finished. */
  async waitForNarration(): Promise<void> {
    this._push({ kind: "waitForNarration" });
  }

  /** The recorded timeline (useful for tests and debugging). */
  getTimeline(): readonly Action[] {
    return this.actions;
  }

  /**
   * Render the timeline to a video file. The container is chosen from the
   * extension: .mp4 (H.264) or .gif (palette-optimized).
   *
   * Honors REELSCRIPT_OUT (override output path) and REELSCRIPT_SNAPSHOT_AT
   * (render a single PNG at that time in ms) so the CLI can drive scripts.
   */
  /** Directory for terminal recordings: option, else `recordings/` beside the entry script. */
  recordingsDir(): string {
    if (this.options.recordingsDir) return resolve(this.options.recordingsDir);
    const script = process.env.REELSCRIPT_SCRIPT || process.argv[1] || ".";
    return join(dirname(resolve(script)), "recordings");
  }

  /** Run every terminal command that has no declared output or events and save its recording. */
  async recordTerminals(): Promise<string[]> {
    const dir = this.recordingsDir();
    const files: string[] = [];
    for (const a of this.actions) {
      if (a.kind !== "terminal.run" || a.output !== undefined || a.events) continue;
      process.stderr.write(`reelscript: recording "${a.command}"\n`);
      const rec = await recordCommand(a.command);
      files.push(saveRecording(dir, rec));
    }
    return files;
  }

  /**
   * Run the whole timeline against the real app without capturing or
   * encoding: every selector must resolve, every command must succeed, every
   * recording must exist. Narration isn't synthesized; its length is
   * estimated. Throws on the first failure with the script location.
   */
  async check(): Promise<RenderResult> {
    const started = Date.now();
    const result = await renderTimeline(this.actions, {
      out: "",
      check: true,
      camera: this.options.camera,
      fps: this.options.fps,
      viewport: this.options.viewport,
      desktop: this.options.desktop,
      theme: this.options.theme,
      deterministic: this.options.deterministic,
      recordingsDir: this.recordingsDir(),
      sources: this.sources,
      baseDir: dirname(resolve(process.env.REELSCRIPT_SCRIPT || process.argv[1] || ".")),
      session: this.options.session ? resolveSession(this.options.session, dirname(resolve(process.env.REELSCRIPT_SCRIPT || process.argv[1] || "."))) : undefined,
      onStatus: (m) => process.stderr.write(`reelscript: ${m}\n`),
    });
    const script = basename(process.env.REELSCRIPT_SCRIPT || process.argv[1] || "script");
    process.stderr.write(
      `reelscript: check passed for ${script}: ${this.actions.length} actions, ${(result.durationMs / 1000).toFixed(1)}s timeline, checked in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
    );
    return result;
  }

  async render(outPath: string): Promise<RenderResult> {
    if (process.env.REELSCRIPT_RECORD) {
      const files = await this.recordTerminals();
      process.stderr.write(
        files.length
          ? `reelscript: saved ${files.length} recording${files.length === 1 ? "" : "s"} in ${this.recordingsDir()}\n`
          : "reelscript: nothing to record (no terminal.run without output)\n",
      );
      return { out: "", frames: 0, durationMs: 0, width: 0, height: 0 };
    }
    if (process.env.REELSCRIPT_CHECK) return this.check();
    const out = process.env.REELSCRIPT_OUT || outPath;
    const snapRaw = process.env.REELSCRIPT_SNAPSHOT_AT;
    const snapshotAt = snapRaw ? Number(snapRaw) : undefined;
    const verbose = this.options.verbose ?? true;
    const started = Date.now();

    const result = await renderTimeline(this.actions, {
      out,
      fps: this.options.fps,
      viewport: this.options.viewport,
      desktop: this.options.desktop,
      theme: this.options.theme,
      deterministic: this.options.deterministic,
      gif: this.options.gif,
      camera: this.options.camera,
      tts: this.options.tts,
      voice: this.options.voice,
      pronunciations: this.options.pronunciations,
      address: this.options.address,
      menubar: this.options.menubar,
      snapshotAt,
      recordingsDir: this.recordingsDir(),
      sources: this.sources,
      baseDir: dirname(resolve(process.env.REELSCRIPT_SCRIPT || process.argv[1] || ".")),
      session: this.options.session ? resolveSession(this.options.session, dirname(resolve(process.env.REELSCRIPT_SCRIPT || process.argv[1] || "."))) : undefined,
      onStatus: verbose ? (m) => process.stderr.write(`reelscript: ${m}\n`) : undefined,
      onProgress: verbose
        ? ({ frame, timeMs }) => {
            if (frame > 0 && frame % 30 === 0) {
              process.stderr.write(`\rreelscript: frame ${frame}  t=${(timeMs / 1000).toFixed(2)}s`);
            }
          }
        : undefined,
    });

    if (verbose) {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      process.stderr.write(
        `\rreelscript: wrote ${result.out}  (${result.width}x${result.height}, ${result.frames} frames, ${(result.durationMs / 1000).toFixed(2)}s video, rendered in ${secs}s)\n`,
      );
    }
    return result;
  }
}

export function createDemo(options: DemoOptions = {}): Demo {
  return new Demo(options);
}
