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

export type { Action, Target } from "./timeline.js";
export type { Ease } from "./easing.js";
export type { ThemeName } from "./theme.js";
export type { RenderOptions, RenderResult } from "./renderer.js";
export type { GifOptions } from "./encoder.js";
export type { TtsEngine, TtsAudio, TtsOptions } from "./tts.js";
export { kokoro } from "./tts.js";
export { render } from "./renderer.js";

export interface DemoOptions {
  /** Visual chrome around the recorded page. Default: "macos". */
  theme?: ThemeName;
  /** Page viewport in CSS pixels: [width, height]. Default: [1280, 800]. */
  viewport?: [number, number];
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
  /** Print render progress to stderr. Default: true. */
  verbose?: boolean;
}

export interface MoveOptions {
  ease?: Ease;
  /** Movement duration in ms. Default: derived from distance. */
  duration?: number;
}

export interface ZoomOptions {
  /** Default: 1.6 */
  scale?: number;
  /** Transition duration in ms. Default: 700 */
  duration?: number;
  ease?: Ease;
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

class Browser {
  constructor(private demo: Demo) {}

  async goto(url: string, opts: GotoOptions = {}): Promise<void> {
    this.demo._push({ kind: "browser.goto", url, ...opts });
  }

  /** Intercept matching requests and return canned JSON — demos never hit a live backend. */
  mockAPI(pattern: string, response: unknown, opts: MockOptions = {}): void {
    this.demo._push({ kind: "browser.mockAPI", pattern, response, ...opts });
  }
}

export class Demo {
  readonly cursor = new Cursor(this);
  readonly zoom = new Zoom(this);
  readonly browser = new Browser(this);

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
  async render(outPath: string): Promise<RenderResult> {
    const out = process.env.REELSCRIPT_OUT || outPath;
    const snapRaw = process.env.REELSCRIPT_SNAPSHOT_AT;
    const snapshotAt = snapRaw ? Number(snapRaw) : undefined;
    const verbose = this.options.verbose ?? true;
    const started = Date.now();

    const result = await renderTimeline(this.actions, {
      out,
      fps: this.options.fps,
      viewport: this.options.viewport,
      theme: this.options.theme,
      deterministic: this.options.deterministic,
      gif: this.options.gif,
      tts: this.options.tts,
      voice: this.options.voice,
      pronunciations: this.options.pronunciations,
      snapshotAt,
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
