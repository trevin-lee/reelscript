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
import { interrupted } from "./cleanup.js";
import type { Ease } from "./easing.js";
import type { Menubar, ThemeName } from "./theme.js";
import type { GifOptions } from "./encoder.js";
import type { TtsEngine } from "./tts.js";
import type { FollowCamera } from "./renderer.js";
import { RECORD_TIMEOUT_MS, parseAsciicast, recordCommand, recordingKeys, saveRecording } from "./terminal.js";
import { DEFAULT_TIMEZONE, clockEpoch } from "./time.js";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/** The script being run: set by the CLI, or the entry file when run directly. */
function scriptFile(): string {
  return resolve(process.env.REELSCRIPT_SCRIPT || process.argv[1] || ".");
}

/** Paths written in a script are relative to the script's folder, wherever it's run from. */
function fromScript(path: string): string {
  return resolve(dirname(scriptFile()), path);
}

/**
 * After Ctrl-C, the clean-up stops VS Code and ffmpeg under a render that is
 * still going, so the render fails. That failure isn't the script's: let the
 * clean-up finish and exit, rather than reporting it and exiting early.
 */
async function unlessInterrupted<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (interrupted()) await new Promise(() => {}); // the clean-up exits the process
    throw err;
  }
}

const EASES = ["smooth", "snappy", "overshoot", "linear"];
const WINDOWS = ["browser", "terminal", "editor"];

/** What's wrong with an option that takes one of a fixed set of values, if anything. */
function invalidChoice(action: Action): string | null {
  const a = action as Record<string, unknown>;
  const one = (name: string, value: unknown, allowed: string[]) =>
    value !== undefined && !allowed.includes(value as string) ? `unknown ${name} ${JSON.stringify(value)} (use ${allowed.map((x) => `"${x}"`).join(", ")})` : null;
  return (
    one("ease", a.ease, EASES) ??
    one("window", a.window, WINDOWS) ??
    (action.kind === "zoom.to" ? one("within", a.within, ["window"]) : null) ??
    (action.kind === "cursor.click" ? one("button", a.button, ["left", "right"]) : null)
  );
}

/** Number options by what they allow: rates and sizes, durations, and positions. */
const ABOVE_0 = ["wpm", "speed", "scale", "fontSize", "lineHeight", "cols", "rows", "width", "height"];
const AT_LEAST_0 = ["ms", "duration", "hold", "holdMs", "settle", "maxGap", "maxGapMs", "timeout"];
const ANY_NUMBER = ["x", "y", "by", "to"];

/** What's wrong with a number option, if anything: a 0 rate or a string would hang a render, a negative time run it backwards. */
function invalidNumber(options: object): string | null {
  const o = options as Record<string, unknown>;
  const shown = (v: unknown) => (typeof v === "number" ? String(v) : JSON.stringify(v));
  const rules = [
    [ABOVE_0, (n: number) => n > 0, "a number above 0"],
    [AT_LEAST_0, (n: number) => n >= 0, "a number, 0 or more"],
    [ANY_NUMBER, () => true, "a number"],
  ] as const;
  for (const [keys, ok, rule] of rules) {
    for (const k of keys) {
      const v = o[k];
      if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && ok(v))) return `${k} must be ${rule}, not ${shown(v)}`;
    }
  }
  if (o.status !== undefined && !(Number.isInteger(o.status) && (o.status as number) >= 100 && (o.status as number) <= 599)) {
    return `status must be an HTTP status code, not ${shown(o.status)}`;
  }
  return null;
}

/** What's wrong with createDemo()'s options, if anything: what a render would fail on, found before it starts. */
function invalidOption(o: DemoOptions): string | null {
  const shown = (v: unknown) => (typeof v === "number" ? String(v) : JSON.stringify(v));
  const camera = o.camera;
  if (camera !== undefined && camera !== "manual" && camera !== "follow" && (typeof camera !== "object" || camera === null)) {
    return `unknown camera ${shown(camera)} (use "manual", "follow", or { scale, hold })`;
  }
  if (typeof camera === "object" && camera !== null) {
    const problem = invalidNumber(camera);
    if (problem) return `camera ${problem}`;
  }
  const above0 = (name: string, v: unknown) =>
    v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v > 0) ? `${name} must be a number above 0, not ${shown(v)}` : null;
  const pixels = (name: string, v: unknown) =>
    v !== undefined && !(Number.isInteger(v) && (v as number) > 0) ? `${name} must be a whole number of pixels above 0, not ${shown(v)}` : null;
  const size = (name: string, v: unknown) =>
    v !== undefined && !(Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n > 0))
      ? `${name} must be [width, height] in whole pixels above 0, not ${shown(v)}`
      : null;
  const numbers = above0("fps", o.fps) ?? size("viewport", o.viewport) ?? size("desktop", o.desktop) ?? above0("gif.fps", o.gif?.fps) ?? pixels("gif.width", o.gif?.width);
  if (numbers) return numbers;
  if (o.theme !== undefined && o.theme !== "macos" && o.theme !== "bare") return `unknown theme ${shown(o.theme)} (use "macos", "bare")`;
  if (o.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: o.timezone });
    } catch {
      return `unknown timezone ${shown(o.timezone)} (use an IANA name, like "America/New_York")`;
    }
  }
  if (o.clock !== undefined) {
    if (o.clock instanceof Date ? Number.isNaN(o.clock.getTime()) : typeof o.clock !== "string") return `clock must be a Date or an ISO date string, not ${shown(o.clock)}`;
    try {
      clockEpoch(o.clock, o.timezone ?? DEFAULT_TIMEZONE);
    } catch (err) {
      return (err as Error).message.replace(/^reelscript: /, "");
    }
  }
  return null;
}

/** Counts render/check/record calls so the CLI can tell a script that never rendered. */
function noteRun(): void {
  const g = globalThis as { __reelscript_runs?: number };
  g.__reelscript_runs = (g.__reelscript_runs ?? 0) + 1;
}

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
export type { RenderResult, FollowCamera } from "./renderer.js";
export type { GifOptions } from "./encoder.js";
export type { TtsEngine, TtsAudio, TtsOptions } from "./tts.js";
export { kokoro } from "./tts.js";
export type { TermEvent, TermRecording } from "./terminal.js";

/**
 * Read an asciinema recording (.cast, v2 or v3), relative to the script:
 * its timed output for terminal.run(cmd, { events }) and the size it was
 * recorded at for terminal.open({ cols, rows }).
 */
export function readAsciicast(path: string): { events: [number, string][]; cols: number; rows: number } {
  return parseAsciicast(readFileSync(fromScript(path), "utf8"));
}


export interface DemoOptions {
  /**
   * A saved login for browser windows, relative to the script: the file
   * `reelscript login <url>` writes. Every browser window starts signed in.
   */
  session?: string;
  /**
   * The moment the demo happens at. The page's Date starts here and the
   * menu bar shows it, so every render shows the same dates. A Date, or an
   * ISO string ("2026-03-10T14:30"; without an offset it's a time in
   * `timezone`). Pass `new Date()` for the real time. Default: Tue Sep 23
   * 2025, 9:41 AM.
   */
  clock?: string | Date;
  /** IANA timezone for the page and the menu bar clock, e.g. "America/New_York". Default: "UTC" */
  timezone?: string;
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
   * eases out when things go quiet; pass { scale, hold } to tune it.
   * Default: "manual" (zoom only on zoom.to()).
   */
  camera?: "manual" | "follow" | FollowCamera;
  /** Freeze the page clock and step it per frame for reproducible animations. Default: true. */
  deterministic?: boolean;
  /** Applied when rendering to a .gif path. Default: 960px wide (or the video's width, if narrower) at 20fps. */
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

export interface ScrollOptions {
  /** ms. Default: from the distance */
  duration?: number;
  ease?: Ease;
  /** Window to scroll. Default: the focused window. */
  window?: "browser" | "terminal" | "editor";
}

export interface TypeOptions {
  /** Typing speed in words per minute. Default: 300 */
  wpm?: number;
}

export interface DemoTypeOptions extends TypeOptions {
  /** Window to type in; it comes to the front. Default: the focused window. */
  window?: "browser" | "terminal" | "editor";
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
   * `maxGap` like a recording.
   */
  events?: [number, string][];
  /** Spread declared output over this many ms. */
  duration?: number;
  /** Typing speed for the command. Default: 300 */
  wpm?: number;
  /** Playback speed for recorded output. Default: 1 */
  speed?: number;
  /** Cap silences in recorded output, in ms. Default: 700 */
  maxGap?: number;
  /** @deprecated Renamed to maxGap. */
  maxGapMs?: number;
  /** Folder `reelscript record` runs the command in, relative to the script. Default: the script's folder */
  cwd?: string;
  /**
   * The prompt once the output ends. Default: true, the terminal's prompt. A
   * string shows that prompt instead, and keeps it from then on (after a
   * `cd`, say). With false the command looks as if it is still running, and
   * terminal.print() can go on with its output.
   */
  prompt?: boolean | string;
}

export interface EditorOptions {
  /** Folder to open, relative to the script. It's copied, so the demo never edits your files. */
  workspace?: string;
  /**
   * Extensions to load: Open VSX ids like "esbenp.prettier-vscode@12.4.0",
   * paths to .vsix files, or extension folders (a directory with a
   * package.json, such as the extension you're building). Paths are relative
   * to the script.
   */
  extensions?: string[];
  /** VS Code settings merged over reelscript's demo defaults. */
  settings?: Record<string, unknown>;
  /** Show notification toasts. Default: false */
  notifications?: boolean;
}

export interface GotoOptions {
  /** ms to hold, on camera, on the freshly loaded page. Default: 400 */
  hold?: number;
  /** @deprecated Renamed to `hold`, since `settle` elsewhere means time off camera. Still works; removed in 1.0. */
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

  /** Take this window off the desktop. Focus passes to the topmost window left. It can be opened again later. */
  async close(): Promise<void> {
    this.demo._push({ kind: "window.close", window: this.id });
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

  /**
   * Open the browser window at a position and size without navigating.
   * Optional: goto() opens it if it isn't open yet.
   */
  async open(geometry: WindowGeometry = {}): Promise<void> {
    this.demo._push({ kind: "browser.open", ...geometry });
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
   * it with a new prompt, and a string with that prompt from then on.
   */
  async print(
    text: string,
    opts: { duration?: number; prompt?: boolean | string; events?: [number, string][]; speed?: number; maxGap?: number; /** @deprecated Renamed to maxGap. */ maxGapMs?: number } = {},
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
    this.demo._push({ kind: "type", text, ...opts, window: "editor" });
  }

  /** Selector for a file or folder row in the Explorer, by its name ("app.ts"), or its folder and name ("src/app.ts"), for cursor.moveTo(). */
  file(name: string): string {
    const { base, inFolder } = fileName(name);
    return `.explorer-folders-view .monaco-list-row[aria-label=${JSON.stringify(base)}]${inFolder}`;
  }

  /** Selector for an open editor tab, by its file's name ("app.ts"), or its folder and name ("src/app.ts"). */
  tab(name: string): string {
    const { base, inFolder } = fileName(name);
    // "app.ts", or "app.ts, …" in states where VS Code adds to the label.
    return `.tabs-container .tab[aria-label=${JSON.stringify(base)}]${inFolder}, .tabs-container .tab[aria-label^=${JSON.stringify(`${base}, `)}]${inFolder}`;
  }
}

/**
 * A file's name, and a selector condition for the folder it's in, if the
 * name gives one: VS Code marks the icon of each Explorer row and tab with
 * the name of the file's folder ("src-name-dir-icon").
 */
function fileName(name: string): { base: string; inFolder: string } {
  const parts = name.replace(/^\.\//, "").split("/");
  const base = parts.pop()!;
  const folder = parts.pop();
  return { base, inFolder: folder ? `:has([class~=${JSON.stringify(`${folder.toLowerCase()}-name-dir-icon`)}])` : "" };
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

  /** Where the script created the demo, for errors about its options found later. */
  private readonly createdAt: string;

  constructor(readonly options: DemoOptions = {}) {
    this.createdAt = callerLocation();
    const problem = invalidOption(options);
    if (problem) throw new Error(`reelscript: ${problem}\n  at ${this.createdAt} (createDemo)`);
  }

  /** The session file to start signed in with, or an error at the createDemo line. */
  private session() {
    if (!this.options.session) return undefined;
    try {
      return resolveSession(this.options.session, dirname(scriptFile()));
    } catch (err) {
      if (err instanceof Error) err.message += `\n  at ${this.createdAt} (createDemo)`;
      throw err;
    }
  }

  /** @internal */
  _push(action: Action): void {
    const source = callerLocation();
    // A misspelt choice or an impossible number fails here, where the script queued it, not deep in a render.
    const problem = invalidChoice(action) ?? invalidNumber(action);
    if (problem) throw new Error(`reelscript: ${problem}\n  at ${source} (${action.kind})`);
    this.actions.push(action);
    this.sources.push(source);
  }

  /** Type into a field with accelerated, evenly paced keystrokes. */
  async type(target: string, text: string, opts: DemoTypeOptions = {}): Promise<void> {
    this._push({ kind: "type", target, text, ...opts });
  }

  /** Press a key or chord, e.g. "Enter" or "Control+K", in the focused window or the one named by `window` (it comes to the front). */
  async press(key: string, opts: { window?: "browser" | "terminal" | "editor" } = {}): Promise<void> {
    this._push({ kind: "press", key, ...opts });
  }

  async wait(ms: number): Promise<void> {
    this._push({ kind: "wait", ms });
  }

  /**
   * Scroll, on camera, stepped with the frame clock: to bring `target` into
   * view (centered, scrolling its nearest scrollable container), or by / to a
   * position on the page, e.g. `scroll({ by: 600 })` or `scroll({ to: 0 })`.
   */
  async scroll(target: string | { by?: number; to?: number }, opts: ScrollOptions = {}): Promise<void> {
    if (typeof target === "string") this._push({ kind: "scroll", target, ...opts });
    else this._push({ kind: "scroll", ...target, ...opts });
  }

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

  /**
   * Hold the camera until `selector` is visible. Off camera: no video time
   * passes, but the page's clock keeps running, so a page that needs time
   * to load, fetch or animate gets it without its loading being filmed.
   */
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

  /** The actions the script queued, in order (useful for tests and debugging). */
  getTimeline(): readonly Action[] {
    return this.actions;
  }

  /** @internal Folder for terminal recordings: the `recordingsDir` option, else `recordings/` beside the script. */
  recordingsDir(): string {
    return fromScript(this.options.recordingsDir ?? "recordings");
  }

  /**
   * @internal Used by `reelscript record`.
   * Run every terminal command that has no declared output or events and
   * save its recording. A command that fails is still saved, since a demo
   * may mean to show a failure, but the exit code is reported.
   */
  async recordTerminals(): Promise<string[]> {
    const dir = this.recordingsDir();
    const files: string[] = [];
    const keys = recordingKeys(this.actions as never);
    for (const [i, key] of keys) {
      const a = this.actions[i] as Extract<Action, { kind: "terminal.run" }>;
      if (this.options.verbose ?? true) process.stderr.write(`reelscript: recording "${a.command}"\n`);
      const cwd = fromScript(a.cwd ?? ".");
      if (!existsSync(cwd)) {
        throw new Error(`reelscript: the folder "${a.cwd}" for "${a.command}" doesn't exist (${cwd})\n  at ${this.sources[i]} (terminal.run)`);
      }
      const rec = await recordCommand(a.command, { cwd });
      if (rec.timedOut) {
        process.stderr.write(
          `reelscript: warning: "${a.command}" ran past ${RECORD_TIMEOUT_MS / 1000}s and was stopped; the recording has its output up to then\n`,
        );
      } else if (rec.exitCode !== 0) {
        process.stderr.write(
          `reelscript: warning: "${a.command}" exited with code ${rec.exitCode}; the recording shows its output as it is\n`,
        );
      }
      files.push(saveRecording(dir, rec, key));
    }
    // Let `reelscript record --prune` know which recordings are still in use.
    const g = globalThis as { __reelscript_recorded?: Map<string, Set<string>> };
    g.__reelscript_recorded ??= new Map();
    const used = g.__reelscript_recorded.get(dir) ?? new Set<string>();
    for (const f of files) used.add(f);
    g.__reelscript_recorded.set(dir, used);
    return files;
  }

  /**
   * Run the whole timeline against the real app without capturing or
   * encoding: every selector must resolve, every file and command typed into
   * the editor must be found, and every terminal recording must exist. Narration isn't synthesized; its length is
   * estimated. Throws on the first failure with the script location.
   */
  async check(outPath?: string): Promise<RenderResult> {
    noteRun();
    const started = Date.now();
    const verbose = this.options.verbose ?? true;
    const result = await unlessInterrupted(renderTimeline(this.actions, {
      out: outPath ? fromScript(outPath) : "",
      check: true,
      tts: this.options.tts,
      voice: this.options.voice,
      pronunciations: this.options.pronunciations,
      camera: this.options.camera,
      clock: this.options.clock,
      timezone: this.options.timezone,
      menubar: this.options.menubar,
      fps: this.options.fps,
      viewport: this.options.viewport,
      desktop: this.options.desktop,
      theme: this.options.theme,
      deterministic: this.options.deterministic,
      recordingsDir: this.recordingsDir(),
      sources: this.sources,
      baseDir: dirname(scriptFile()),
      session: this.session(),
      onStatus: verbose ? (m) => process.stderr.write(`reelscript: ${m}\n`) : undefined,
    }));
    const script = basename(scriptFile());
    if (verbose) process.stderr.write(
      `reelscript: check passed for ${script}: ${this.actions.length} actions, ${(result.durationMs / 1000).toFixed(1)}s timeline, checked in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
    );
    return result;
  }

  /**
   * Render the timeline. The format follows the extension: .mp4 (H.264, with
   * narration) or .gif (palette-optimized, silent). `outPath` is relative to
   * the script's folder. Under the CLI this also does `check`, `preview` and
   * `record`, which set REELSCRIPT_CHECK, REELSCRIPT_SNAPSHOT_AT,
   * REELSCRIPT_RECORD and REELSCRIPT_OUT.
   */
  async render(outPath: string): Promise<RenderResult> {
    noteRun();
    if (process.env.REELSCRIPT_RECORD) {
      const files = await this.recordTerminals();
      if (this.options.verbose ?? true) process.stderr.write(
        files.length
          ? `reelscript: saved ${files.length} recording${files.length === 1 ? "" : "s"} in ${this.recordingsDir()}\n`
          : "reelscript: nothing to record (no terminal.run without output)\n",
      );
      return { out: "", frames: 0, durationMs: 0, width: 0, height: 0 };
    }
    if (process.env.REELSCRIPT_CHECK) {
      const g = globalThis as { __reelscript_runs?: number };
      g.__reelscript_runs = (g.__reelscript_runs ?? 1) - 1; // check() counts itself
      return this.check(outPath);
    }
    const out = process.env.REELSCRIPT_OUT || fromScript(outPath);
    const snapRaw = process.env.REELSCRIPT_SNAPSHOT_AT;
    const snapshotAt = snapRaw ? Number(snapRaw) : undefined;
    const verbose = this.options.verbose ?? true;
    const started = Date.now();

    const result = await unlessInterrupted(renderTimeline(this.actions, {
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
      clock: this.options.clock,
      timezone: this.options.timezone,
      snapshotAt,
      recordingsDir: this.recordingsDir(),
      sources: this.sources,
      baseDir: dirname(scriptFile()),
      session: this.session(),
      onStatus: verbose ? (m) => process.stderr.write(`reelscript: ${m}\n`) : undefined,
      onProgress: verbose
        ? ({ frame, timeMs }) => {
            if (frame > 0 && frame % 30 === 0 && process.stderr.isTTY) {
              process.stderr.write(`\rreelscript: frame ${frame}  t=${(timeMs / 1000).toFixed(2)}s`);
            }
          }
        : undefined,
    }));

    if (verbose) {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      process.stderr.write(
        `${process.stderr.isTTY ? "\r" : ""}reelscript: wrote ${result.out}  (${result.width}x${result.height}, ${result.frames} frames, ${(result.durationMs / 1000).toFixed(2)}s video, rendered in ${secs}s)\n`,
      );
    }
    return result;
  }
}

export function createDemo(options: DemoOptions = {}): Demo {
  return new Demo(options);
}
