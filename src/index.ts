/**
 * reelscript — product demos as code.
 *
 * This is the public API surface. The engine (deterministic, frame-by-frame
 * offline rendering with a composited animated cursor + auto-zoom) is not
 * wired up yet — methods currently record timeline actions so the shape of
 * the API can be exercised and iterated on.
 */

export type Ease = "linear" | "smooth" | "snappy" | "overshoot";

export interface DemoOptions {
  /** Visual chrome around the recorded panel. */
  theme?: "macos" | "bare";
  /** Recording viewport in CSS pixels: [width, height]. */
  viewport?: [number, number];
  /** Output frames per second. */
  fps?: number;
}

export interface MoveOptions {
  ease?: Ease;
  /** Duration of the movement in milliseconds. */
  duration?: number;
}

export interface ZoomOptions {
  scale?: number;
  /** How long to hold the zoom before releasing, in milliseconds. */
  hold?: number;
  ease?: Ease;
}

export interface TypeOptions {
  /** Accelerated typing speed, words per minute. */
  wpm?: number;
}

/** A single recorded step on the demo timeline. */
export interface TimelineAction {
  kind: string;
  args: Record<string, unknown>;
}

class Cursor {
  constructor(private demo: Demo) {}

  async moveTo(target: string, opts: MoveOptions = {}): Promise<void> {
    this.demo._record("cursor.moveTo", { target, ...opts });
  }

  async click(): Promise<void> {
    this.demo._record("cursor.click", {});
  }
}

class Zoom {
  constructor(private demo: Demo) {}

  to(target: string, opts: ZoomOptions = {}): void {
    this.demo._record("zoom.to", { target, ...opts });
  }

  out(): void {
    this.demo._record("zoom.out", {});
  }
}

class Browser {
  constructor(private demo: Demo) {}

  async goto(url: string): Promise<void> {
    this.demo._record("browser.goto", { url });
  }

  /** Intercept a request and return canned data — demos never hit a live backend. */
  mockAPI(pattern: string, response: unknown): void {
    this.demo._record("browser.mockAPI", { pattern, response });
  }
}

export class Demo {
  readonly cursor = new Cursor(this);
  readonly zoom = new Zoom(this);
  readonly browser = new Browser(this);

  private timeline: TimelineAction[] = [];

  constructor(readonly options: DemoOptions = {}) {}

  /** @internal */
  _record(kind: string, args: Record<string, unknown>): void {
    this.timeline.push({ kind, args });
  }

  async type(target: string, text: string, opts: TypeOptions = {}): Promise<void> {
    this._record("type", { target, text, ...opts });
  }

  async wait(ms: number): Promise<void> {
    this._record("wait", { ms });
  }

  /** Return the recorded timeline (useful for tests and debugging). */
  getTimeline(): readonly TimelineAction[] {
    return this.timeline;
  }

  /** Render the recorded timeline to a video file. Not yet implemented. */
  async render(_outPath: string): Promise<void> {
    throw new Error(
      "reelscript: the render engine is not implemented yet. " +
        "The timeline API is in place — see getTimeline().",
    );
  }
}

export function createDemo(options: DemoOptions = {}): Demo {
  return new Demo(options);
}
