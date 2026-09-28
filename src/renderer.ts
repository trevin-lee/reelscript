import { chromium, type Page, type Browser, type BrowserContext, type CDPSession } from "playwright";
import sharp, { type OverlayOptions } from "sharp";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, extname } from "node:path";
import { DEFAULTS, type Action, type Target } from "./timeline.js";
import { clamp, lerp, progress, type Ease } from "./easing.js";
import { createTheme, type FrameImage, type Menubar, type RawImage, type Theme, type ThemeName, type WindowKind } from "./theme.js";
import { cursorSprite, rippleSprite, type Sprite } from "./cursor.js";
import { Encoder, muxNarration, type GifOptions, type NarrationCue } from "./encoder.js";
import { CLOCK_SHIM } from "./clock.js";
import { applyPronunciations, kokoro, synthesizeClip, type Clip, type TtsEngine } from "./tts.js";
import {
  TERMINAL_URL,
  loadRecording,
  playbackEvents,
  scriptedEvents,
  withCarriageReturns,
  terminalPageHtml,
  type TermEvent,
} from "./terminal.js";
import { EditorServer, LINUX_UA, editorStyles, editorTitle } from "./editor.js";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export interface RenderOptions {
  out: string;
  fps?: number;
  /** Content size of the first window. */
  viewport?: [number, number];
  /** Desktop (output) size. Default: first window plus theme margins. */
  desktop?: [number, number];
  theme?: ThemeName;
  /** Settings applied when `out` ends in .gif. */
  gif?: GifOptions;
  /** Text-to-speech engine for say(). Default: Kokoro via kokoro-js. */
  tts?: TtsEngine;
  /** Default narration voice. Default: "af_heart" */
  voice?: string;
  /** Words to respell before synthesis, e.g. { Reelscript: "Reel script" }. */
  pronunciations?: Record<string, string>;
  /** Rewrites a page URL before the address pill shows it. */
  address?: (url: string) => string;
  /** The macOS theme's menu bar, or `false` for none. */
  menubar?: Menubar;
  onStatus?: (message: string) => void;
  /** Where terminal recordings live (for terminal.run without declared output). */
  recordingsDir?: string;
  /** Directory relative paths in the script (e.g. editor workspaces) resolve against. */
  baseDir?: string;
  /** Absolute path of a saved login (storage state) for browser windows. */
  session?: string;
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
  /** Run the timeline without capturing, encoding, or synthesizing narration (see Demo.check). */
  check?: boolean;
  /**
   * Camera behaviour. "manual" (default) zooms only on zoom.to(); "follow"
   * zooms toward clicks and the typing caret automatically and eases back
   * out when things go quiet.
   */
  camera?: "manual" | "follow" | FollowCamera;
  /** Script location of each action, used in error messages. */
  sources?: string[];
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

export interface FollowCamera {
  /** Zoom level while following. Default: 1.5 */
  scale?: number;
  /** How long to stay zoomed after the last click or keystroke, ms. Default: 1200 */
  holdMs?: number;
}

interface Attention {
  at: number;
  x: number;
  y: number;
}

interface Geometry {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** A window on the desktop: one Chromium page plus its chrome. */
interface Win {
  id: string;
  kind: WindowKind;
  page: Page;
  cdp: CDPSession;
  /** Editor windows get their own un-shimmed context (VS Code runs on real time). */
  ctx: BrowserContext | null;
  /** Frame origin in desktop pixels. */
  x: number;
  y: number;
  /** Content size. */
  width: number;
  height: number;
  z: number;
  title: string;
  url: string;
  termPrompt: string;
  termRouted: boolean;
  frameOverlay: { key: string; overlay: OverlayOptions | null } | null;
}

const RIPPLE_MS = 420;
const SQUISH_MS = 120;
const CURSOR_PX = 26;
const CASCADE_MARGIN = 40;

class Engine {
  readonly desktop: [number, number];
  private theme: Theme;
  private browser!: Browser;
  private context!: BrowserContext;

  private windows = new Map<string, Win>();
  private zTop = 0;
  private focusedId: string | null = null;

  // desktop-coordinate cursor state
  private cursor: Point;
  private move: Tween<Point> | null = null;
  private zoom: ZoomState;
  private zoomAnim: Tween<ZoomState> | null = null;
  private lastClick = -Infinity;
  // follow camera
  private follow: Required<FollowCamera> | null = null;
  private attention: Attention | null = null;
  private manualZoom = false;
  private lastSampleT = 0;
  private typing: { win: Win; until: number } | null = null;
  private lastCaretProbe = -Infinity;
  private actions: Action[] = [];
  // terminal
  private termEvents = new Map<number, TermEvent[]>();
  // editor
  private editorServer: EditorServer | null = null;
  private editorFallbackTitle = "";
  onStatus: (m: string) => void = () => {};
  session: string | undefined;
  baseDir = process.cwd();
  // narration
  private clips = new Map<number, Clip>();
  private narrationEnd = 0;
  readonly narration: NarrationCue[] = [];
  /** Rewrites a page URL before the address pill shows it. */
  address?: (url: string) => string;

  constructor(
    private viewport: [number, number],
    desktop: [number, number] | undefined,
    themeName: ThemeName,
    private deterministic: boolean,
    menubar: Menubar = {},
    /** One frame of page time, for steps that run the clock off camera. */
    private frameMs = 1000 / DEFAULTS.fps,
  ) {
    this.theme = createTheme(themeName, (html, w, h, transparent) => this.rasterizeHtml(html, w, h, transparent), menubar);
    this.desktop = desktop ?? this.theme.defaultDesktop(viewport);
    this.cursor = { x: this.desktop[0] / 2, y: this.desktop[1] / 2 };
    this.zoom = { scale: 1, cx: this.desktop[0] / 2, cy: this.desktop[1] / 2 };
  }

  setClips(clips: Map<number, Clip>): void {
    this.clips = clips;
  }

  setTerminalEvents(events: Map<number, TermEvent[]>): void {
    this.termEvents = events;
  }

  setCamera(camera: RenderOptions["camera"], actions: Action[]): void {
    this.actions = actions;
    if (!camera || camera === "manual") return;
    const opts = camera === "follow" ? {} : camera;
    this.follow = { scale: opts.scale ?? 1.5, holdMs: opts.holdMs ?? 1200 };
  }

  private attend(at: number, p: Point): void {
    if (this.follow) this.attention = { at, x: p.x, y: p.y };
  }

  /** While typing, keep the camera on the caret (the focused element, which VS Code and xterm keep at the caret). */
  async followCaret(t: number): Promise<void> {
    if (!this.follow || !this.typing || t > this.typing.until || t - this.lastCaretProbe < 64) return;
    this.lastCaretProbe = t;
    const w = this.typing.win;
    const r = await w.page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left + Math.min(b.width / 2, 300), y: b.top + b.height / 2 };
    });
    if (r) this.attend(t, { x: w.x + r.x, y: w.y + this.titleH + r.y });
  }

  async open(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      viewport: { width: this.viewport[0], height: this.viewport[1] },
      deviceScaleFactor: 1,
      colorScheme: "light",
      storageState: this.session,
    });
    // Headless Chromium denies clipboard writes by default, so a "Copy"
    // button in the page under demo would fail where a real browser succeeds.
    await this.context.grantPermissions(["clipboard-read", "clipboard-write"]);
    if (this.deterministic) await this.context.addInitScript(CLOCK_SHIM);
  }

  async close(): Promise<void> {
    await this.browser?.close();
    await this.editorServer?.stop();
  }

  /** Render static HTML (theme chrome) in a separate, un-shimmed context. */
  private async rasterizeHtml(html: string, width: number, height: number, transparent: boolean): Promise<Buffer> {
    const ctx = await this.browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      return await page.screenshot({ type: "png", omitBackground: transparent });
    } finally {
      await ctx.close();
    }
  }

  // ------------------------------------------------------------ windows

  private get titleH(): number {
    return this.theme.titleHeight;
  }

  private clampGeometry(w: Win): void {
    const [W, H] = this.desktop;
    w.width = Math.max(200, Math.min(w.width, W));
    w.height = Math.max(120, Math.min(w.height, H - this.titleH));
    w.x = Math.round(clamp(w.x, 0, W - w.width));
    w.y = Math.round(clamp(w.y, 0, H - w.height - this.titleH));
  }

  /** Get a window, creating its page if this is the first time it's used. */
  private async ensureWindow(id: string, kind: WindowKind, geometry: Geometry = {}): Promise<Win> {
    const existing = this.windows.get(id);
    if (existing) {
      if (geometry.x !== undefined || geometry.y !== undefined || geometry.width !== undefined || geometry.height !== undefined) {
        await this.place(existing, geometry);
      }
      return existing;
    }
    const first = this.windows.size === 0;
    const [W, H] = this.desktop;
    let width = geometry.width ?? (first ? this.viewport[0] : Math.min(900, Math.round(W * 0.6)));
    let height = geometry.height ?? (first ? this.viewport[1] : Math.min(520, Math.round(H * 0.5)));
    let x: number;
    let y: number;
    if (first) {
      ({ x, y } = this.theme.mainPlacement(this.desktop, [width, height]));
    } else {
      x = W - width - CASCADE_MARGIN;
      y = H - height - this.titleH - CASCADE_MARGIN;
    }
    if (geometry.x !== undefined) x = geometry.x;
    if (geometry.y !== undefined) y = geometry.y;

    let ctx: BrowserContext | null = null;
    if (kind === "editor") {
      ctx = await this.browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
        colorScheme: "dark",
        userAgent: LINUX_UA, // consistent Ctrl-based keybindings on every host
      });
    }
    const page = await (ctx ?? this.context).newPage();
    const win: Win = {
      id,
      kind,
      page,
      cdp: await (ctx ?? this.context).newCDPSession(page),
      ctx,
      x,
      y,
      width,
      height,
      z: ++this.zTop,
      title: "",
      url: "",
      termPrompt: DEFAULTS.terminalPrompt,
      termRouted: false,
      frameOverlay: null,
    };
    this.clampGeometry(win);
    await page.setViewportSize({ width: win.width, height: win.height });
    this.windows.set(id, win);
    this.focusedId = id;
    return win;
  }

  private window(id: string): Win {
    const w = this.windows.get(id);
    if (!w) throw new Error(`reelscript: window "${id}" is not open (call browser.goto or terminal.open first)`);
    return w;
  }

  private focused(): Win {
    if (!this.focusedId) throw new Error("reelscript: no window is open yet (call browser.goto or terminal.open first)");
    return this.window(this.focusedId);
  }

  private focus(w: Win): void {
    if (this.focusedId !== w.id || w.z !== this.zTop) w.z = ++this.zTop;
    this.focusedId = w.id;
  }

  private async place(w: Win, g: Geometry): Promise<void> {
    const resized = (g.width !== undefined && g.width !== w.width) || (g.height !== undefined && g.height !== w.height);
    if (g.x !== undefined) w.x = g.x;
    if (g.y !== undefined) w.y = g.y;
    if (g.width !== undefined) w.width = g.width;
    if (g.height !== undefined) w.height = g.height;
    this.clampGeometry(w);
    if (resized) {
      await w.page.setViewportSize({ width: w.width, height: w.height });
      if (w.kind === "terminal") await this.refitTerminal(w);
    }
  }

  private byZ(): Win[] {
    return [...this.windows.values()].sort((a, b) => a.z - b.z);
  }

  /** Topmost window whose frame contains the desktop point. */
  private windowAt(p: Point): Win | null {
    const wins = this.byZ();
    for (let i = wins.length - 1; i >= 0; i--) {
      const w = wins[i];
      if (p.x >= w.x && p.x < w.x + w.width && p.y >= w.y && p.y < w.y + w.height + this.titleH) return w;
    }
    return null;
  }

  private toLocal(w: Win, p: Point): Point {
    return { x: p.x - w.x, y: p.y - w.y - this.titleH };
  }

  private inContent(w: Win, local: Point): boolean {
    return local.x >= 0 && local.y >= 0 && local.x < w.width && local.y < w.height;
  }

  // ------------------------------------------------------------ page clock

  /** Advance every window's virtual clock by `ms`. */
  async advanceClock(ms: number): Promise<void> {
    if (!this.deterministic) return;
    await Promise.all(
      [...this.windows.values()].map((w) =>
        w.page.evaluate((ms) => {
          const g = window as unknown as { __reelscript_advance?: (ms: number) => void };
          g.__reelscript_advance?.(ms);
        }, ms),
      ),
    );
  }

  // ------------------------------------------------------------ targets

  /** Resolve a target to desktop coordinates, searching the given or focused window. */
  private async resolveRect(target: Target, windowId?: string): Promise<Rect> {
    const w = windowId ? this.window(windowId) : this.focused();
    if (typeof target !== "string") return { x: w.x + target.x, y: w.y + this.titleH + target.y, w: 0, h: 0 };
    const loc = w.page.locator(target).first();
    const deadline = Date.now() + 3000;
    while (!(await loc.isVisible())) {
      if (Date.now() > deadline) throw new Error(`reelscript: target "${target}" was not found or never became visible in the ${w.id} window`);
      await new Promise((r) => setTimeout(r, 25));
    }
    const box = await loc.boundingBox();
    if (!box) throw new Error(`reelscript: target "${target}" has no bounding box`);
    return { x: w.x + box.x, y: w.y + this.titleH + box.y, w: box.width, h: box.height };
  }

  private async resolvePoint(target: Target, windowId?: string): Promise<Point> {
    const r = await this.resolveRect(target, windowId);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  // ------------------------------------------------------------ terminal

  /**
   * Writes to a terminal. A line feed starts a new line, as in a script or
   * a `reelscript record` recording; `raw` output, from a pseudo-terminal,
   * already has its carriage returns, and a bare line feed there moves down
   * a row and keeps the column, which full-screen programs rely on.
   */
  private async termWrite(w: Win, text: string, raw = false): Promise<void> {
    if (!text) return;
    if (!raw) text = withCarriageReturns(text);
    await w.page.evaluate((s) => {
      (window as unknown as { __rsTerm: { write: (s: string) => void } }).__rsTerm.write(s);
    }, text);
  }

  private async refitTerminal(w: Win): Promise<void> {
    const dims = await w.page.evaluate(() => {
      const t = (window as unknown as { __rsTerm?: { fit: () => { cols: number; rows: number } } }).__rsTerm;
      return t ? t.fit() : null;
    });
    if (dims) w.title = w.title.replace(/\s\S+$/, ` ${dims.cols}×${dims.rows}`);
  }

  // ------------------------------------------------------------ steps

  async begin(action: Action, index: number, start: number): Promise<Step | null> {
    switch (action.kind) {
      case "browser.goto": {
        const w = await this.ensureWindow("browser", "browser");
        this.focus(w);
        await w.page.goto(action.url, { waitUntil: "load" });
        w.url = action.url;
        return { end: start + (action.settle ?? DEFAULTS.gotoSettle) };
      }
      case "browser.mockAPI": {
        const w = await this.ensureWindow("browser", "browser");
        const { pattern, response, status = 200 } = action;
        await w.page.route(pattern, (route) =>
          route.fulfill({ status, contentType: "application/json", body: JSON.stringify(response) }),
        );
        return null;
      }
      case "cursor.moveTo": {
        const to = await this.resolvePoint(action.target, action.window);
        const from = { ...this.cursor };
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const dur = action.duration ?? clamp(Math.round(dist * 0.9 + 200), 250, 1400);
        this.move = { from, to, start, dur, ease: action.ease ?? "smooth" };
        // Anticipate: if this move ends in a click, start easing the camera toward it now.
        if (this.actions[index + 1]?.kind === "cursor.click") this.attend(start, to);
        return {
          end: start + dur,
          onEnd: () => {
            this.cursor = to;
            this.move = null;
          },
        };
      }
      case "cursor.click": {
        const w = this.windowAt(this.cursor);
        if (w) {
          this.focus(w);
          const local = this.toLocal(w, this.cursor);
          if (this.inContent(w, local)) await w.page.mouse.click(local.x, local.y, { button: action.button ?? "left" });
        }
        this.lastClick = start;
        this.attend(start, this.cursor);
        return { end: start + (action.duration ?? DEFAULTS.clickDuration) };
      }
      case "type": {
        const w = this.focused();
        if (action.target) await w.page.locator(action.target).first().focus();
        const msPerChar = 60000 / ((action.wpm ?? DEFAULTS.typeWpm) * 5);
        const chars = Array.from(action.text);
        const firstAt = start + 80;
        let next = 0;
        const flush = async (upTo: number) => {
          let batch = "";
          while (next < chars.length && firstAt + next * msPerChar <= upTo) batch += chars[next++];
          if (batch) await w.page.keyboard.type(batch);
        };
        const end = firstAt + chars.length * msPerChar + 120;
        this.typing = { win: w, until: end };
        return {
          end,
          onFrame: flush,
          onEnd: () => flush(Infinity),
        };
      }
      case "press": {
        await this.focused().page.keyboard.press(action.key);
        return { end: start + 100 };
      }
      case "wait":
        return { end: start + action.ms };
      case "waitFor": {
        // Off camera: the page's clock runs a frame at a time, with real
        // time between steps for the page to lay out and paint, until the
        // target shows. No frame is filmed and no video time passes.
        const w = action.window ? this.window(action.window) : this.focused();
        const loc = w.page.locator(action.target).first();
        const deadline = Date.now() + (action.timeout ?? 15_000);
        while (!(await loc.isVisible())) {
          if (Date.now() > deadline) throw new Error(`reelscript: waitFor "${action.target}" timed out in the ${w.id} window`);
          await this.advanceClock(this.frameMs);
          await new Promise((r) => setTimeout(r, 16));
        }
        for (let ms = 0; ms < (action.settle ?? 0); ms += this.frameMs) {
          await this.advanceClock(this.frameMs);
          await new Promise((r) => setTimeout(r, 16));
        }
        return null;
      }
      case "zoom.to": {
        const r = await this.resolveRect(action.target, action.window);
        const scale = action.scale ?? DEFAULTS.zoomScale;
        let cx = r.x + r.w / 2;
        let cy = r.y + r.h / 2;
        if (action.within === "window") {
          const w = action.window ? this.window(action.window) : this.focused();
          const [W, H] = this.desktop;
          cx = centreWithin(cx, W / scale, w.x, w.x + w.width);
          cy = centreWithin(cy, H / scale, w.y, w.y + this.titleH + w.height);
        }
        const to: ZoomState = { scale, cx, cy };
        this.zoomAnim = { from: zoomAt(this.zoomAnim, this.zoom, start), to, start, dur: action.duration ?? DEFAULTS.zoomDuration, ease: action.ease ?? "smooth" };
        this.manualZoom = true; // an explicit zoom takes over from the follow camera until zoom.out()
        return null;
      }
      case "zoom.out": {
        this.manualZoom = false;
        this.attention = null;
        this.zoomAnim = {
          from: zoomAt(this.zoomAnim, this.zoom, start),
          to: { scale: 1, cx: this.desktop[0] / 2, cy: this.desktop[1] / 2 },
          start,
          dur: action.duration ?? DEFAULTS.zoomDuration,
          ease: action.ease ?? "smooth",
        };
        return null;
      }
      case "say": {
        const clip = this.clips.get(index);
        if (!clip) throw new Error("reelscript: narration clip missing (internal)");
        const at = Math.max(start, this.narrationEnd);
        this.narration.push({ file: clip.file, atMs: at });
        this.narrationEnd = at + clip.seconds * 1000 + DEFAULTS.narrationGapMs;
        return null;
      }
      case "waitForNarration":
        return { end: Math.max(start, this.narrationEnd) };
      case "editor.open": {
        const w = await this.ensureWindow("editor", "editor", action);
        this.focus(w);
        if (!this.editorServer) {
          this.editorServer = new EditorServer();
          const workspace = action.workspace ? resolvePath(this.baseDir, action.workspace) : undefined;
          this.onStatus("starting code-server");
          await this.editorServer.start(
            { workspace, extensions: action.extensions, settings: action.settings, baseDir: this.baseDir },
            this.onStatus,
          );
          await w.page.route("**/__reelscript/fonts/*", (route) => {
            const name = route.request().url().split("/").pop() ?? "";
            route.fulfill({ status: 200, contentType: "font/ttf", body: readFileSync(new URL(`../assets/fonts/${name}`, import.meta.url)) });
          });
        }
        const url = this.editorServer.url();
        await w.page.goto(url, { waitUntil: "load" });
        await w.page.waitForSelector(".monaco-workbench .editor-group-container", { timeout: 60_000 });
        await w.page.addStyleTag({ content: editorStyles(action.notifications ?? false) });
        await w.page.evaluate(() => Promise.all([document.fonts.load('14px "JetBrains Mono"'), document.fonts.load('13px "Inter"')]));
        await w.page.waitForTimeout(600);
        w.url = url;
        this.editorFallbackTitle = this.editorServer.workspace.split("/").pop() ?? "Code";
        w.title = editorTitle(await w.page.title(), this.editorFallbackTitle);
        return { end: start + 400 };
      }
      case "editor.openFile":
      case "editor.command": {
        const w = this.window("editor");
        this.focus(w);
        const text = action.kind === "editor.openFile" ? action.path : action.command;
        const chars = Array.from(text);
        const msPerChar = 60000 / ((action.wpm ?? DEFAULTS.typeWpm) * 5);
        const typeStart = start + 350;
        const typeEnd = typeStart + chars.length * msPerChar;
        const enterAt = typeEnd + 400;
        await w.page.keyboard.press(action.kind === "editor.openFile" ? "Control+P" : "F1");
        let next = 0;
        let entered = false;
        const flush = async (t: number) => {
          let batch = "";
          while (next < chars.length && typeStart + next * msPerChar <= t) batch += chars[next++];
          if (batch) await w.page.keyboard.type(batch);
          if (!entered && t >= enterAt) {
            entered = true;
            await w.page.keyboard.press("Enter");
          }
        };
        this.typing = { win: w, until: enterAt };
        return { end: enterAt + 500, onFrame: flush, onEnd: () => flush(Infinity) };
      }
      case "window.focus": {
        this.focus(this.window(action.window));
        return null;
      }
      case "window.place": {
        await this.place(this.window(action.window), action);
        return null;
      }
      case "terminal.open": {
        const w = await this.ensureWindow("terminal", "terminal", action);
        this.focus(w);
        if (!w.termRouted) {
          const html = terminalPageHtml(action.fontSize, action.lineHeight);
          await w.page.route(`${TERMINAL_URL}**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
          w.termRouted = true;
        }
        await w.page.goto(TERMINAL_URL, { waitUntil: "load" });
        const deadline = Date.now() + 5000;
        let dims: { cols: number; rows: number } | null = null;
        while (!dims) {
          dims = await w.page.evaluate(() => {
            const t = (window as unknown as { __rsTerm?: { ready: boolean; cols: number; rows: number } }).__rsTerm;
            return t?.ready ? { cols: t.cols, rows: t.rows } : null;
          });
          if (!dims) {
            if (Date.now() > deadline) throw new Error("reelscript: terminal page did not initialise");
            await new Promise((r) => setTimeout(r, 25));
          }
        }
        if (action.cols && action.rows) {
          dims = await w.page.evaluate(
            ([cols, rows]) =>
              (window as unknown as { __rsTerm: { resize: (c: number, r: number) => { cols: number; rows: number } } }).__rsTerm.resize(cols, rows),
            [action.cols, action.rows] as const,
          );
        }
        w.termPrompt = action.prompt ?? DEFAULTS.terminalPrompt;
        await this.termWrite(w, w.termPrompt);
        w.url = TERMINAL_URL;
        w.title = `${action.title ?? DEFAULTS.terminalTitle} — ${dims.cols}×${dims.rows}`;
        return { end: start + 300 };
      }
      case "terminal.run": {
        const w = this.window("terminal");
        this.focus(w);
        const events = this.termEvents.get(index);
        if (!events) throw new Error("reelscript: terminal events missing (internal)");
        const chars = Array.from(action.command);
        const msPerChar = 60000 / ((action.wpm ?? DEFAULTS.typeWpm) * 5);
        const typeStart = start + 120;
        const typeEnd = typeStart + chars.length * msPerChar;
        const outStart = typeEnd + 60;
        const lastOut = events.length ? outStart + events[events.length - 1][0] : outStart;
        const endsWithNewline = !events.length || /\n$/.test(events[events.length - 1][1]);
        const promptAt = lastOut + 150;
        let nextChar = 0;
        let nextEvent = 0;
        let entered = false;
        let prompted = false;
        const flush = async (t: number) => {
          let batch = "";
          while (nextChar < chars.length && typeStart + nextChar * msPerChar <= t) batch += chars[nextChar++];
          await this.termWrite(w, batch);
          if (!entered && t >= typeEnd) {
            entered = true;
            await this.termWrite(w, "\r\n");
          }
          let out = "";
          while (nextEvent < events.length && outStart + events[nextEvent][0] <= t) out += events[nextEvent++][1];
          await this.termWrite(w, out, !!action.events);
          if (!prompted && t >= promptAt) {
            prompted = true;
            if (action.prompt !== false) await this.termWrite(w, (endsWithNewline ? "" : "\r\n") + w.termPrompt);
          }
        };
        this.typing = { win: w, until: promptAt };
        return { end: promptAt + 100, onFrame: flush, onEnd: () => flush(Infinity) };
      }
      case "terminal.print": {
        const w = this.window("terminal");
        const events = this.termEvents.get(index);
        if (!events) throw new Error("reelscript: terminal events missing (internal)");
        const lastOut = events.length ? start + events[events.length - 1][0] : start;
        const endsWithNewline = !events.length || /\n$/.test(events[events.length - 1][1]);
        let nextEvent = 0;
        let prompted = false;
        const flush = async (t: number) => {
          let out = "";
          while (nextEvent < events.length && start + events[nextEvent][0] <= t) out += events[nextEvent++][1];
          await this.termWrite(w, out, !!action.events);
          if (action.prompt && !prompted && t >= lastOut + 150) {
            prompted = true;
            await this.termWrite(w, (endsWithNewline ? "" : "\r\n") + w.termPrompt);
          }
        };
        return { end: lastOut + 250, onFrame: flush, onEnd: () => flush(Infinity) };
      }
      case "call": {
        const page = this.focusedId ? this.window(this.focusedId).page : undefined;
        await action.fn({ page, context: this.context });
        return null;
      }
      default: {
        const never: never = action;
        throw new Error(`reelscript: unknown action ${JSON.stringify(never)}`);
      }
    }
  }

  /** Time (ms) after which nothing is still animating or speaking. */
  pendingUntil(): number {
    const zoom = this.zoomAnim ? this.zoomAnim.start + this.zoomAnim.dur : 0;
    const follow = this.follow && this.attention ? this.attention.at + this.follow.holdMs + 900 : 0;
    return Math.max(zoom, this.narrationEnd, follow);
  }

  /** Advance continuous state (cursor, zoom) to time t. */
  sample(t: number): void {
    const dt = Math.max(0, t - this.lastSampleT);
    this.lastSampleT = t;
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
    } else if (this.follow && !this.manualZoom) {
      this.followCamera(t, dt);
    }
  }

  /**
   * Ease the camera toward the latest attention point while it's fresh, keep
   * the cursor inside the zoomed view if it wanders, and ease back to the full
   * desktop when things go quiet. Exponential smoothing, so motion is
   * frame-rate independent and deterministic.
   */
  private followCamera(t: number, dt: number): void {
    const f = this.follow!;
    const [W, H] = this.desktop;
    const active = this.attention && t - this.attention.at < f.holdMs;
    let target: ZoomState = { scale: 1, cx: W / 2, cy: H / 2 };
    if (active && this.attention) {
      target = { scale: f.scale, cx: this.attention.x, cy: this.attention.y };
      // Keep the cursor within the inner 70% of the zoomed view.
      const halfW = (W / f.scale / 2) * 0.7;
      const halfH = (H / f.scale / 2) * 0.7;
      if (this.cursor.x > target.cx + halfW) target.cx = this.cursor.x - halfW;
      if (this.cursor.x < target.cx - halfW) target.cx = this.cursor.x + halfW;
      if (this.cursor.y > target.cy + halfH) target.cy = this.cursor.y - halfH;
      if (this.cursor.y < target.cy - halfH) target.cy = this.cursor.y + halfH;
    }
    const kScale = 1 - Math.exp(-dt / (active ? 380 : 520));
    const kPan = 1 - Math.exp(-dt / 320);
    this.zoom = {
      scale: this.zoom.scale + (target.scale - this.zoom.scale) * kScale,
      cx: this.zoom.cx + (target.cx - this.zoom.cx) * kPan,
      cy: this.zoom.cy + (target.cy - this.zoom.cy) * kPan,
    };
  }

  /** Drive the real mouse in whichever window is under the cursor so hover states render. */
  async syncMouse(): Promise<void> {
    const w = this.windowAt(this.cursor);
    if (!w) return;
    const local = this.toLocal(w, this.cursor);
    if (this.inContent(w, local)) await w.page.mouse.move(local.x, local.y);
  }

  // ------------------------------------------------------------ frames

  /**
   * Capture a window via CDP rather than page.screenshot(): Playwright's
   * screenshot waits for an in-page requestAnimationFrame, which is under
   * our control and slower; CDP grabs the current compositor frame directly.
   */
  private async capture(w: Win): Promise<Buffer> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("reelscript: screenshot timed out (page compositor stalled)")), 10_000),
    );
    const { data } = await Promise.race([w.cdp.send("Page.captureScreenshot", { format: "png" }), timeout]);
    return Buffer.from(data, "base64");
  }

  /** Window content as RGBA raw, masked to the theme's rounded corners. */
  private async contentOverlay(w: Win): Promise<OverlayOptions> {
    const png = await this.capture(w);
    const mask = await this.theme.contentMask(w.width, w.height);
    let pipeline = sharp(png).ensureAlpha();
    if (mask) pipeline = pipeline.composite([{ input: mask.data, raw: { width: mask.width, height: mask.height, channels: 4 }, blend: "dest-in" }]);
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    return { input: data, raw: { width: info.width, height: info.height, channels: 4 }, left: w.x, top: w.y + this.titleH };
  }

  /** Window chrome as an overlay, clipped to the desktop; cached per style and position. */
  private async frameOverlay(w: Win): Promise<OverlayOptions | null> {
    if (w.kind === "editor") w.title = editorTitle(await w.page.title(), this.editorFallbackTitle);
    // A browser window shows where its page is now, in-page navigation
    // included, not the address it was opened at.
    const url = w.kind === "browser" ? (this.address ? this.address(w.page.url()) : w.page.url()) : w.url;
    const style = { kind: w.kind, width: w.width, height: w.height, title: w.title, url, focused: w.id === this.focusedId };
    const key = `${JSON.stringify(style)}@${w.x},${w.y}`;
    if (w.frameOverlay?.key === key) return w.frameOverlay.overlay;
    const img = await this.theme.frame(style);
    const overlay = img ? await clipRaw(img, w.x + img.dx, w.y + img.dy, this.desktop[0], this.desktop[1]) : null;
    w.frameOverlay = { key, overlay };
    return overlay;
  }

  /** Capture every window, compose the desktop, zoom, and overlay the cursor. Returns packed RGB. */
  async frame(t: number): Promise<Buffer> {
    const [W, H] = this.desktop;
    const bg = await this.theme.background(this.desktop);
    const layers = await Promise.all(
      this.byZ().map(async (w) => {
        const [frame, content] = await Promise.all([this.frameOverlay(w), this.contentOverlay(w)]);
        return frame ? [frame, content] : [content];
      }),
    );
    const { data: sceneData } = await sharp(bg.data, { raw: { width: bg.width, height: bg.height, channels: 4 } })
      .composite(layers.flat())
      .raw()
      .toBuffer({ resolveWithObject: true });

    const s = this.zoom.scale;
    const cw = W / s;
    const ch = H / s;
    // Sub-pixel crop origin. Rounding it to whole pixels makes the content
    // jump by up to a pixel per frame during a zoom, which reads as flicker.
    const fx = clamp(this.zoom.cx - cw / 2, 0, W - cw);
    const fy = clamp(this.zoom.cy - ch / 2, 0, H - ch);

    // cursor: desktop → output coordinates
    const ox = (this.cursor.x - fx) * s;
    const oy = (this.cursor.y - fy) * s;

    const overlays: OverlayOptions[] = [];
    const since = t - this.lastClick;
    if (since >= 0 && since < RIPPLE_MS) {
      const p = since / RIPPLE_MS;
      const ripple = await rippleSprite((6 + 22 * p) * s, 0.55 * (1 - p));
      const o = await placeSprite(ripple, ox, oy, W, H);
      if (o) overlays.push(o);
    }
    const squish = since >= 0 && since < SQUISH_MS ? 0.86 : 1;
    const arrow = await cursorSprite(CURSOR_PX * s * squish);
    const o = await placeSprite(arrow, ox, oy, W, H);
    if (o) overlays.push(o);

    let zoomed: Buffer = sceneData;
    if (s > 1.001) {
      // Integer crop with a margin, then scale with the fractional offset
      // folded into the affine transform, then trim to the output size.
      const left = Math.floor(fx);
      const top = Math.floor(fy);
      const width = Math.min(W - left, Math.ceil(fx + cw) - left + 2);
      const height = Math.min(H - top, Math.ceil(fy + ch) - top + 2);
      const { data, info } = await sharp(sceneData, { raw: { width: W, height: H, channels: 4 } })
        .extract({ left, top, width, height })
        .affine([[s, 0], [0, s]], { interpolator: "bicubic", idx: -(fx - left), idy: -(fy - top), background: "#000" })
        .raw()
        .toBuffer({ resolveWithObject: true });
      zoomed = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
        .extract({ left: 0, top: 0, width: Math.min(W, info.width), height: Math.min(H, info.height) })
        .resize(W, H, { fit: "fill" })
        .raw()
        .toBuffer();
    }

    let pipeline = sharp(zoomed, { raw: { width: W, height: H, channels: 4 } });
    if (overlays.length) pipeline = pipeline.composite(overlays);
    return pipeline.removeAlpha().raw().toBuffer();
  }
}

/**
 * The zoom at time `t`: as far as the running animation has got, or `rest`
 * when none is running. A new zoom starts from here, so one that replaces
 * another before a frame has been drawn (two at the same instant) starts
 * where the first would have put the camera, not where the last frame was.
 */
export function zoomAt(anim: Tween<ZoomState> | null, rest: ZoomState, t: number): ZoomState {
  if (!anim) return { ...rest };
  const p = progress(t, anim.start, anim.dur, anim.ease);
  return { scale: lerp(anim.from.scale, anim.to.scale, p), cx: lerp(anim.from.cx, anim.to.cx, p), cy: lerp(anim.from.cy, anim.to.cy, p) };
}

/**
 * Where to centre a view `size` wide so that it stays between `lo` and
 * `hi`: as near `c` as it can be, or the middle when the span is narrower
 * than the view.
 */
export function centreWithin(c: number, size: number, lo: number, hi: number): number {
  if (hi - lo <= size) return (lo + hi) / 2;
  return clamp(c, lo + size / 2, hi - size / 2);
}

/** Clip a raw RGBA image to the desktop bounds and return it as an overlay (sharp rejects out-of-bounds overlays). */
async function clipRaw(img: RawImage, left: number, top: number, W: number, H: number): Promise<OverlayOptions | null> {
  let { width, height } = img;
  if (left >= W || top >= H || left + width <= 0 || top + height <= 0) return null;
  const clipL = Math.max(0, -left);
  const clipT = Math.max(0, -top);
  const clipR = Math.max(0, left + width - W);
  const clipB = Math.max(0, top + height - H);
  if (!clipL && !clipT && !clipR && !clipB) {
    return { input: img.data, raw: { width, height, channels: 4 }, left, top };
  }
  width -= clipL + clipR;
  height -= clipT + clipB;
  if (width <= 0 || height <= 0) return null;
  const { data } = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .extract({ left: clipL, top: clipT, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { input: data, raw: { width, height, channels: 4 }, left: left + clipL, top: top + clipT };
}

/** Position a sprite by its hotspot, clipping it to the frame. */
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
  const snapshot = options.snapshotAt;
  // A check steps time coarsely: nothing is captured, only page state matters.
  const frameMs = options.check ? 50 : 1000 / fps;

  const engine = new Engine(viewport, options.desktop, themeName, options.deterministic ?? true, options.menubar, frameMs);
  if (options.onStatus) engine.onStatus = options.onStatus;
  engine.session = options.session;
  engine.setCamera(options.camera, actions);
  if (options.address) engine.address = options.address;
  if (options.baseDir) engine.baseDir = options.baseDir;
  const [width, height] = engine.desktop;

  // Narration is synthesized up front so clip durations can pace the timeline.
  const sayIndexes = actions.flatMap((a, i) => (a.kind === "say" ? [i] : []));
  const isGif = extname(options.out).toLowerCase() === ".gif";
  const check = options.check ?? false;
  const hasAudio = sayIndexes.length > 0 && snapshot === undefined && !isGif && !check;
  if (sayIndexes.length && check) {
    // Estimate speech length (~155 wpm) instead of loading the TTS model.
    const clips = new Map<number, Clip>();
    for (const i of sayIndexes) {
      const words = (actions[i] as Extract<Action, { kind: "say" }>).text.split(/\s+/).filter(Boolean).length;
      clips.set(i, { file: "", seconds: Math.max(0.6, words / 2.6) });
    }
    engine.setClips(clips);
  } else if (sayIndexes.length) {
    const tts = options.tts ?? kokoro();
    options.onStatus?.(`synthesizing narration (${sayIndexes.length} clip${sayIndexes.length === 1 ? "" : "s"})`);
    const clips = new Map<number, Clip>();
    for (const i of sayIndexes) {
      const a = actions[i] as Extract<Action, { kind: "say" }>;
      const text = applyPronunciations(a.text, options.pronunciations);
      clips.set(i, await synthesizeClip(tts, text, { voice: a.voice ?? options.voice, speed: a.speed }));
    }
    engine.setClips(clips);
    if (isGif && snapshot === undefined) options.onStatus?.("note: GIF output has no audio; narration is used for pacing only");
  }

  // Terminal output: declared in the script, or replayed from a recording.
  const termRuns = actions.flatMap((a, i) => (a.kind === "terminal.run" ? [i] : []));
  const termPrints = actions.flatMap((a, i) => (a.kind === "terminal.print" ? [i] : []));
  if (termRuns.length || termPrints.length) {
    const events = new Map<number, TermEvent[]>();
    for (const i of termPrints) {
      const a = actions[i] as Extract<Action, { kind: "terminal.print" }>;
      events.set(i, a.events ? playbackEvents(a.events, { speed: a.speed, maxGapMs: a.maxGapMs }) : scriptedEvents(a.text ?? "", a.duration));
    }
    for (const i of termRuns) {
      const a = actions[i] as Extract<Action, { kind: "terminal.run" }>;
      if (a.events) {
        events.set(i, playbackEvents(a.events, { speed: a.speed, maxGapMs: a.maxGapMs }));
        continue;
      }
      if (a.output !== undefined) {
        events.set(i, scriptedEvents(a.output, a.duration));
        continue;
      }
      const rec = options.recordingsDir ? loadRecording(options.recordingsDir, a.command) : null;
      if (!rec) {
        throw new Error(
          `reelscript: no recording for terminal command "${a.command}".\n` +
            `  Declare its output with terminal.run(cmd, { output }), or record it:\n` +
            `  reelscript record <script>`,
        );
      }
      events.set(i, playbackEvents(rec.events, { speed: a.speed, maxGapMs: a.maxGapMs }));
    }
    engine.setTerminalEvents(events);
  }

  const videoPath = hasAudio ? `${options.out}.video.tmp.mp4` : options.out;
  const encoder = snapshot === undefined && !check ? new Encoder({ out: videoPath, width, height, fps, gif: options.gif }) : null;
  const where = (index: number, err: unknown): Error => {
    const e = err instanceof Error ? err : new Error(String(err));
    const loc = options.sources?.[index];
    if (loc && !e.message.includes(`\n  at ${loc}`)) e.message += `\n  at ${loc} (${actions[index]?.kind})`;
    return e;
  };
  let stepIndex = -1;

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
          try {
            await step.onEnd?.();
          } catch (err) {
            throw where(stepIndex, err);
          }
          nextStart = step.end;
          step = null;
        }
        if (step) break;
        if (i >= actions.length) {
          endAt ??= Math.max(nextStart, engine.pendingUntil()) + DEFAULTS.tailMs;
          break;
        }
        try {
          step = await engine.begin(actions[i], i, nextStart);
        } catch (err) {
          throw where(i, err);
        }
        stepIndex = i;
        i++;
      }
      if (endAt !== null && t >= endAt) break;

      engine.sample(t);
      if (!check) await engine.syncMouse();
      if (step?.onFrame) {
        try {
          await step.onFrame(t);
        } catch (err) {
          throw where(stepIndex, err);
        }
      }
      await engine.followCaret(t);
      await engine.advanceClock(frameMs);

      if (check) {
        // nothing to capture
      } else if (snapshot !== undefined) {
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
    if (hasAudio && engine.narration.length) {
      options.onStatus?.("mixing narration");
      await muxNarration(videoPath, engine.narration, options.out);
      unlinkSync(videoPath);
    }
  } finally {
    await engine.close();
  }

  return { out: options.out, frames, durationMs: Math.round(t), width, height };
}
