/**
 * reelscript — product demos as code.
 *
 * Scripts build a timeline through the `Demo` API; `render()` executes it
 * against a headless Chromium, samples the state at a fixed frame rate, and
 * composites the animated cursor + zoom offline before encoding to mp4.
 */

import { render as renderTimeline, type RenderResult } from "./renderer.js";
import type { Action, Target } from "./timeline.js";
import type { Ease } from "./easing.js";
import type { ThemeName } from "./theme.js";
import type { GifOptions } from "./encoder.js";
import type { TtsEngine } from "./tts.js";
import { recordCommand, saveRecording } from "./terminal.js";
import { dirname, join, resolve } from "node:path";

export type { Action, Target } from "./timeline.js";
export type { Ease } from "./easing.js";
export type { ThemeName } from "./theme.js";
export type { RenderOptions, RenderResult } from "./renderer.js";
export type { GifOptions } from "./encoder.js";
export type { TtsEngine, TtsAudio, TtsOptions } from "./tts.js";
export { kokoro } from "./tts.js";
export type { TermEvent, TermRecording } from "./terminal.js";
export { recordCommand, scriptedEvents, playbackEvents } from "./terminal.js";
export { render } from "./renderer.js";

export interface DemoOptions {
  /** Visual chrome around the recorded page. Default: "macos". */
  theme?: ThemeName;
  /** Content size of the first window, in CSS pixels. Default: [1280, 800]. */
  viewport?: [number, number];
  /** Desktop (output) size. Default: the first window plus the theme's margins. */
  desktop?: [number, number];
  /** Output frames per second. Default: 60. */
  fps?: number;
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
}

export interface MoveOptions {
  ease?: Ease;
  /** Movement duration in ms. Default: derived from distance. */
  duration?: number;
  /** Window to resolve a selector in. Default: the focused window. */
  window?: "browser" | "terminal";
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
  window?: "browser" | "terminal";
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
}

export interface RunOptions {
  /** Output to show. Omit to replay a recording made with `reelscript record`. */
  output?: string;
  /** Spread declared output over this many ms. */
  duration?: number;
  /** Typing speed for the command. Default: 300 */
  wpm?: number;
  /** Playback speed for recorded output. Default: 1 */
  speed?: number;
  /** Cap silences in recorded output, in ms. Default: 700 */
  maxGapMs?: number;
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

  async click(opts: { button?: "left" | "right" } = {}): Promise<void> {
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
    readonly id: "browser" | "terminal",
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
}

export class Demo {
  readonly cursor = new Cursor(this);
  readonly zoom = new Zoom(this);
  readonly browser = new Browser(this);
  readonly terminal = new TerminalWindow(this);

  private actions: Action[] = [];

  constructor(readonly options: DemoOptions = {}) {}

  /** @internal */
  _push(action: Action): void {
    this.actions.push(action);
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

  /** Run every terminal command that has no declared output and save its recording. */
  async recordTerminals(): Promise<string[]> {
    const dir = this.recordingsDir();
    const files: string[] = [];
    for (const a of this.actions) {
      if (a.kind !== "terminal.run" || a.output !== undefined) continue;
      process.stderr.write(`reelscript: recording "${a.command}"\n`);
      const rec = await recordCommand(a.command);
      files.push(saveRecording(dir, rec));
    }
    return files;
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
      tts: this.options.tts,
      voice: this.options.voice,
      pronunciations: this.options.pronunciations,
      snapshotAt,
      recordingsDir: this.recordingsDir(),
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
