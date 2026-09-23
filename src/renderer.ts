import { chromium, type Page, type Browser, type CDPSession } from "playwright";
import sharp, { type OverlayOptions } from "sharp";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULTS, type Action, type Target } from "./timeline.js";
import { clamp, lerp, progress, type Ease } from "./easing.js";
import { createTheme, type SceneLayout, type Theme, type ThemeName } from "./theme.js";
import { cursorSprite, rippleSprite, type Sprite } from "./cursor.js";
import { Encoder, type GifOptions } from "./encoder.js";
import { CLOCK_SHIM } from "./clock.js";

export interface RenderOptions {
  out: string;
  fps?: number;
  viewport?: [number, number];
  theme?: ThemeName;
  /** Settings applied when `out` ends in .gif. */
  gif?: GifOptions;
  /**
   * Replace the page's clock with a virtual one that advances exactly one
   * frame per rendered frame, so CSS transitions, timers and rAF loops play
   * at the correct speed regardless of how long each frame takes to capture.
   * Default: true.
   */
  deterministic?: boolean;
  /**
   * Render up to this time (ms) and write that single frame as a PNG to `out`
   * instead of encoding a video. Fast way to iterate on a moment of a demo.
   */
  snapshotAt?: number;
  onProgress?: (info: { frame: number; timeMs: number }) => void;
}

export interface RenderResult {
  out: string;
  frames: number;
  durationMs: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ZoomState {
  scale: number;
  cx: number;
  cy: number;
}

interface Tween<T> {
  from: T;
  to: T;
  start: number;
  dur: number;
  ease: Ease;
}

/** A timeline action that occupies time. Instant actions return null from begin(). */
interface Step {
  end: number;
  onFrame?: (t: number) => Promise<void>;
  onEnd?: () => Promise<void> | void;
}

const RIPPLE_MS = 420;
const SQUISH_MS = 120;
const CURSOR_PX = 26;

class Engine {
  readonly layout: SceneLayout;
  private theme: Theme;
  private page!: Page;
  private browser!: Browser;
  private cdp!: CDPSession;

  // page-coordinate cursor state
  private cursor: Point;
  private move: Tween<Point> | null = null;
  // scene-coordinate zoom state
  private zoom: ZoomState;
  private zoomAnim: Tween<ZoomState> | null = null;
  private lastClick = -Infinity;
  private url = "";

  constructor(
    private viewport: [number, number],
    themeName: ThemeName,
    private deterministic: boolean,
  ) {
    this.theme = createTheme(themeName, viewport, (html, w, h) => this.rasterizeHtml(html, w, h));
    this.layout = this.theme.layout(viewport);
    this.cursor = { x: viewport[0] / 2, y: viewport[1] / 2 };
    this.zoom = { scale: 1, cx: this.layout.width / 2, cy: this.layout.height / 2 };
  }

  async open(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    const context = await this.browser.newContext({
      viewport: { width: this.viewport[0], height: this.viewport[1] },
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
    if (this.deterministic) await context.addInitScript(CLOCK_SHIM);
    this.page = await context.newPage();
    this.cdp = await context.newCDPSession(this.page);
  }

  /** Render static HTML (theme chrome) in a separate, un-shimmed context. */
  private async rasterizeHtml(html: string, width: number, height: number): Promise<Buffer> {
    const ctx = await this.browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      return await page.screenshot({ type: "png" });
    } finally {
      await ctx.close();
    }
  }

  // ------------------------------------------------------------ page clock

  /** Advance the page's virtual clock by `ms` (no-op before the first page loads). */
  async advanceClock(ms: number): Promise<void> {
    if (!this.deterministic) return;
    await this.page.evaluate((ms) => {
      const w = window as unknown as { __reelscript_advance?: (ms: number) => void };
      w.__reelscript_advance?.(ms);
    }, ms);
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }

  // ------------------------------------------------------------ targets

  private async resolveRect(target: Target): Promise<Rect> {
    if (typeof target !== "string") return { x: target.x, y: target.y, w: 0, h: 0 };
    const loc = this.page.locator(target).first();
    const deadline = Date.now() + 3000;
    while (!(await loc.isVisible())) {
      if (Date.now() > deadline) throw new Error(`reelscript: target "${target}" was not found or never became visible`);
      await new Promise((r) => setTimeout(r, 25));
    }
    const box = await loc.boundingBox();
    if (!box) throw new Error(`reelscript: target "${target}" has no bounding box`);
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  }

  private async resolvePoint(target: Target): Promise<Point> {
    const r = await this.resolveRect(target);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  // ------------------------------------------------------------ steps

  async begin(action: Action, start: number): Promise<Step | null> {
    const page = this.page;
    switch (action.kind) {
      case "browser.goto": {
        await page.goto(action.url, { waitUntil: "load" });
        this.url = action.url;
        return { end: start + (action.settle ?? DEFAULTS.gotoSettle) };
      }
      case "browser.mockAPI": {
        const { pattern, response, status = 200 } = action;
        await page.route(pattern, (route) =>
          route.fulfill({ status, contentType: "application/json", body: JSON.stringify(response) }),
        );
        return null;
      }
      case "cursor.moveTo": {
        const to = await this.resolvePoint(action.target);
        const from = { ...this.cursor };
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const dur = action.duration ?? clamp(Math.round(dist * 0.9 + 200), 250, 1400);
        this.move = { from, to, start, dur, ease: action.ease ?? "smooth" };
        return {
          end: start + dur,
          onEnd: () => {
            this.cursor = to;
            this.move = null;
          },
        };
      }
      case "cursor.click": {
        await page.mouse.click(this.cursor.x, this.cursor.y, { button: action.button ?? "left" });
        this.lastClick = start;
        return { end: start + DEFAULTS.clickDuration };
      }
      case "type": {
        if (action.target) await page.locator(action.target).first().focus();
        const msPerChar = 60000 / ((action.wpm ?? DEFAULTS.typeWpm) * 5);
        const chars = Array.from(action.text);
        const firstAt = start + 80;
        let next = 0;
        const flush = async (upTo: number) => {
          let batch = "";
          while (next < chars.length && firstAt + next * msPerChar <= upTo) batch += chars[next++];
          if (batch) await page.keyboard.type(batch);
        };
        return {
          end: firstAt + chars.length * msPerChar + 120,
          onFrame: flush,
          onEnd: () => flush(Infinity),
        };
      }
      case "press": {
        await page.keyboard.press(action.key);
        return { end: start + 100 };
      }
      case "wait":
        return { end: start + action.ms };
      case "zoom.to": {
        const r = await this.resolveRect(action.target);
        const to: ZoomState = {
          scale: action.scale ?? DEFAULTS.zoomScale,
          cx: this.layout.pageX + r.x + r.w / 2,
          cy: this.layout.pageY + r.y + r.h / 2,
        };
        this.zoomAnim = {
          from: { ...this.zoom },
          to,
          start,
          dur: action.duration ?? DEFAULTS.zoomDuration,
          ease: action.ease ?? "smooth",
        };
        return null;
      }
      case "zoom.out": {
        this.zoomAnim = {
          from: { ...this.zoom },
          to: { scale: 1, cx: this.layout.width / 2, cy: this.layout.height / 2 },
          start,
          dur: action.duration ?? DEFAULTS.zoomDuration,
          ease: action.ease ?? "smooth",
        };
        return null;
      }
      default: {
        const never: never = action;
        throw new Error(`reelscript: unknown action ${JSON.stringify(never)}`);
      }
    }
  }

  /** Time (ms) after which nothing on screen is still animating. */
  pendingUntil(): number {
    return this.zoomAnim ? this.zoomAnim.start + this.zoomAnim.dur : 0;
  }

  /** Advance continuous state (cursor, zoom) to time t. */
  sample(t: number): void {
    if (this.move) {
      const p = progress(t, this.move.start, this.move.dur, this.move.ease);
      this.cursor = { x: lerp(this.move.from.x, this.move.to.x, p), y: lerp(this.move.from.y, this.move.to.y, p) };
    }
    if (this.zoomAnim) {
      const z = this.zoomAnim;
      const p = progress(t, z.start, z.dur, z.ease);
      this.zoom = { scale: lerp(z.from.scale, z.to.scale, p), cx: lerp(z.from.cx, z.to.cx, p), cy: lerp(z.from.cy, z.to.cy, p) };
      if (t >= z.start + z.dur) {
        this.zoom = { ...z.to };
        this.zoomAnim = null;
      }
    }
  }

  /** Drive the real mouse to the animated cursor so hover states render. */
  async syncMouse(): Promise<void> {
    await this.page.mouse.move(this.cursor.x, this.cursor.y);
  }

  // ------------------------------------------------------------ frames

  /**
   * Capture the viewport via CDP rather than page.screenshot(): Playwright's
   * screenshot waits for an in-page requestAnimationFrame, which never fires
   * and is slower; CDP grabs the current compositor frame directly.
   */
  private async capture(): Promise<Buffer> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("reelscript: screenshot timed out (page compositor stalled)")), 10_000),
    );
    const { data } = await Promise.race([this.cdp.send("Page.captureScreenshot", { format: "png" }), timeout]);
    return Buffer.from(data, "base64");
  }

  /** Capture, compose, zoom, and overlay the cursor. Returns packed RGB. */
  async frame(t: number): Promise<Buffer> {
    const { width: W, height: H } = this.layout;
    const shot = await this.capture();
    const scene = await this.theme.compose(shot, { url: this.url });

    const s = this.zoom.scale;
    const cw = W / s;
    const ch = H / s;
    const crop = {
      left: Math.round(clamp(this.zoom.cx - cw / 2, 0, W - cw)),
      top: Math.round(clamp(this.zoom.cy - ch / 2, 0, H - ch)),
      width: Math.max(2, Math.round(cw)),
      height: Math.max(2, Math.round(ch)),
    };
    crop.width = Math.min(crop.width, W - crop.left);
    crop.height = Math.min(crop.height, H - crop.top);
    const sx = W / crop.width;
    const sy = H / crop.height;

    // cursor: page → scene → output coordinates
    const ox = (this.layout.pageX + this.cursor.x - crop.left) * sx;
    const oy = (this.layout.pageY + this.cursor.y - crop.top) * sy;

    const overlays: OverlayOptions[] = [];
    const since = t - this.lastClick;
    if (since >= 0 && since < RIPPLE_MS) {
      const p = since / RIPPLE_MS;
      const ripple = await rippleSprite((6 + 22 * p) * sx, 0.55 * (1 - p));
      const o = await placeSprite(ripple, ox, oy, W, H);
      if (o) overlays.push(o);
    }
    const squish = since >= 0 && since < SQUISH_MS ? 0.86 : 1;
    const arrow = await cursorSprite(CURSOR_PX * sx * squish);
    const o = await placeSprite(arrow, ox, oy, W, H);
    if (o) overlays.push(o);

    let pipeline = sharp(scene.data, { raw: { width: scene.width, height: scene.height, channels: scene.channels } });
    if (s > 1.001) pipeline = pipeline.extract(crop).resize(W, H, { kernel: "lanczos3", fit: "fill" });
    if (overlays.length) pipeline = pipeline.composite(overlays);
    return pipeline.removeAlpha().raw().toBuffer();
  }
}

/** Position a sprite by its hotspot, clipping it to the frame (sharp rejects out-of-bounds overlays). */
async function placeSprite(sp: Sprite, x: number, y: number, W: number, H: number): Promise<OverlayOptions | null> {
  let left = Math.round(x - sp.hx);
  let top = Math.round(y - sp.hy);
  let { width, height } = sp;
  if (left >= W || top >= H || left + width <= 0 || top + height <= 0) return null;
  const clipL = Math.max(0, -left);
  const clipT = Math.max(0, -top);
  const clipR = Math.max(0, left + width - W);
  const clipB = Math.max(0, top + height - H);
  if (!clipL && !clipT && !clipR && !clipB) return { input: sp.data, left, top };
  width -= clipL + clipR;
  height -= clipT + clipB;
  if (width <= 0 || height <= 0) return null;
  const input = await sharp(sp.data).extract({ left: clipL, top: clipT, width, height }).png().toBuffer();
  return { input, left: left + clipL, top: top + clipT };
}

export async function render(actions: Action[], options: RenderOptions): Promise<RenderResult> {
  const fps = options.fps ?? DEFAULTS.fps;
  const viewport = options.viewport ?? DEFAULTS.viewport;
  const themeName = options.theme ?? "macos";
  const frameMs = 1000 / fps;
  const snapshot = options.snapshotAt;

  const engine = new Engine(viewport, themeName, options.deterministic ?? true);
  const { width, height } = engine.layout;
  const encoder = snapshot === undefined ? new Encoder({ out: options.out, width, height, fps, gif: options.gif }) : null;

  await engine.open();
  encoder?.start();

  let t = 0;
  let frames = 0;
  let i = 0;
  let step: Step | null = null;
  let nextStart = 0;
  let endAt: number | null = null;

  try {
    for (;;) {
      // Advance the sequential step machine up to time t.
      for (;;) {
        if (step && t >= step.end) {
          await step.onEnd?.();
          nextStart = step.end;
          step = null;
        }
        if (step) break;
        if (i >= actions.length) {
          endAt ??= Math.max(nextStart, engine.pendingUntil()) + DEFAULTS.tailMs;
          break;
        }
        step = await engine.begin(actions[i++], nextStart);
      }
      if (endAt !== null && t >= endAt) break;

      engine.sample(t);
      await engine.syncMouse();
      if (step?.onFrame) await step.onFrame(t);
      await engine.advanceClock(frameMs);

      if (snapshot !== undefined) {
        if (t + frameMs / 2 >= snapshot || (endAt !== null && t + frameMs >= endAt)) {
          const rgb = await engine.frame(t);
          mkdirSync(dirname(options.out), { recursive: true });
          await sharp(rgb, { raw: { width, height, channels: 3 } }).png().toFile(options.out);
          frames++;
          break;
        }
      } else {
        const rgb = await engine.frame(t);
        await encoder!.writeFrame(rgb);
        frames++;
      }
      options.onProgress?.({ frame: frames, timeMs: t });
      t += frameMs;
    }
    await encoder?.finish();
  } finally {
    await engine.close();
  }

  return { out: options.out, frames, durationMs: Math.round(t), width, height };
}
