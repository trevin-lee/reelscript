import type { Page, Browser, BrowserContext, CDPSession, Locator } from "playwright";
import { launchChromium, macChrome } from "./browser.js";
import { macShortcut, pressMacShortcut } from "./macKeys.js";
import { LocalPages } from "./localPages.js";
import sharp, { type OverlayOptions } from "sharp";
import { mkdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { DEFAULTS, type Action, type Target } from "./timeline.js";
import { clamp, lerp, progress, type Ease } from "./easing.js";
import { createTheme, type FrameImage, type Menubar, type RawImage, type Theme, type ThemeName, type WindowKind } from "./theme.js";
import { cursorSprite, rippleSprite, type Sprite } from "./cursor.js";
import { Encoder, checkOutputFormat, gifSize, muxNarration, stopEncoders, type GifOptions, type NarrationCue } from "./encoder.js";
import { clockShim, dateShim } from "./clock.js";
import { DEFAULT_CLOCK, DEFAULT_TIMEZONE, clockEpoch, menubarClock } from "./time.js";
import { applyPronunciations, cachedClip, kokoro, synthesizeClip, voiceFor, type Clip, type TtsEngine } from "./tts.js";
import { onInterrupt } from "./cleanup.js";
import { warn, warningCount } from "./warnings.js";
import {
  TERMINAL_URL,
  loadRecording,
  recordingKeys,
  playbackEvents,
  scriptedEvents,
  withCarriageReturns,
  terminalPageHtml,
  type TermEvent,
} from "./terminal.js";
import { EditorServer, editorStyles, editorTitle } from "./editor.js";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  /** The moment the demo happens at: the page's Date starts here and the menu bar shows it. */
  clock?: string | Date;
  /** IANA timezone for the page and the menu bar. Default: "UTC" */
  timezone?: string;
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
  hold?: number;
  /** @deprecated Renamed to hold. */
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
  /** The terminal page being served, as its font settings: opening it again with others serves a new one. */
  termRouted: string | null;
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
  private follow: { scale: number; hold: number } | null = null;
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
  /** The demo's clock (ms since epoch) and timezone; see RenderOptions.clock. */
  epoch: number;
  timezone = DEFAULT_TIMEZONE;
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
    this.epoch = clockEpoch(DEFAULT_CLOCK, DEFAULT_TIMEZONE);
    // Even sizes, as H.264 needs; the default desktop already is.
    this.desktop = desktop ? [desktop[0] + (desktop[0] % 2), desktop[1] + (desktop[1] % 2)] : this.theme.defaultDesktop(viewport);
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
    this.follow = { scale: opts.scale ?? 1.5, hold: opts.hold ?? opts.holdMs ?? 1200 };
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
    // Smooth scrolling runs on Chromium's own clock, not the frame-stepped one,
    // so it's off: keyboard and page scrolls jump, and demo.scroll() animates.
    this.browser = await launchChromium({
      headless: true,
      args: ["--disable-smooth-scrolling"],
      // Playwright's own signal handlers exit the process straight away; reelscript's
      // clean-up closes the browser itself, after stopping VS Code and ffmpeg.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    this.unregisterBrowser = onInterrupt(() => this.browser.close().catch(() => {}));
    // Draw the desktop (wallpaper, menu bar) now, before any page loads: drawn
    // lazily at the first captured frame, it raced a heavy page for the GPU.
    await this.theme.background(this.desktop);
    // The browser is Chrome on a Mac on every host, like the desktop it sits
    // on: pages show the same ⌘ shortcut hints in a local preview as in CI.
    const mac = macChrome(this.browser);
    this.context = await this.browser.newContext({
      viewport: { width: this.viewport[0], height: this.viewport[1] },
      deviceScaleFactor: 1,
      colorScheme: "light",
      storageState: this.session,
      timezoneId: this.timezone,
      userAgent: mac.userAgent,
      extraHTTPHeaders: mac.headers,
    });
    await this.context.addInitScript(mac.script);
    // Headless Chromium denies clipboard writes by default, so a "Copy"
    // button in the page under demo would fail where a real browser succeeds.
    await this.context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await this.context.addInitScript(this.deterministic ? clockShim(this.epoch) : dateShim(this.epoch));
    await this.context.addInitScript(ONE_TAB);
    // alert(), confirm() and prompt() are Chromium's, not the page's, and are
    // never drawn. Answer OK, as a demo clicking "Delete" means to, and say so
    // at the line; leaving a page (beforeunload) is the script's own doing.
    this.context.on("dialog", (dialog) => {
      const type = dialog.type();
      // The click that opened it said how to answer: meant, so no warning.
      if (this.dialogAnswer && type !== "beforeunload") {
        (this.dialogAnswer === "accept" ? dialog.accept(type === "prompt" ? dialog.defaultValue() : undefined) : dialog.dismiss()).catch(() => {});
        return;
      }
      if (type !== "beforeunload") {
        const key = `${type} ${dialog.message()}`;
        if (!this.dialogs.has(key)) {
          this.dialogs.add(key);
          warn(
            `the page opened a ${type}("${dialog.message()}") dialog, which isn't drawn in the video; reelscript answered OK\n  at ${this.at}`,
          );
        }
      }
      dialog.accept(type === "prompt" ? dialog.defaultValue() : undefined).catch(() => {});
    });
  }
  /** Dialogs already warned about. */
  private dialogs = new Set<string>();
  /** How the latest click said to answer a dialog it opens, until the next step. */
  private dialogAnswer: "accept" | "dismiss" | null = null;

  private unregisterBrowser: (() => void) | null = null;

  async close(): Promise<void> {
    this.unregisterBrowser?.();
    await this.browser?.close();
    await this.editorServer?.stop();
    this.local.close();
  }

  /** Serves the demo's local pages over http (see LocalPages). */
  private local = new LocalPages();

  /** Render static HTML (theme chrome) in a separate, un-shimmed context. */
  private async rasterizeHtml(html: string, width: number, height: number, transparent: boolean): Promise<Buffer> {
    return retryCapture("the desktop's window frames", async () => {
      const ctx = await this.browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      try {
        const page = await ctx.newPage();
        await page.setContent(html, { waitUntil: "load" });
        await page.evaluate(() => document.fonts.ready);
        return await page.screenshot({ type: "png", omitBackground: transparent });
      } finally {
        await ctx.close();
      }
    });
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
        timezoneId: this.timezone,
        // A Mac, like the browser beside it: the same ⌘ keybindings on every host.
        userAgent: macChrome(this.browser).userAgent,
      });
      await ctx.addInitScript(macChrome(this.browser).script);
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
      termRouted: null,
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
    if (!w) {
      const how: Record<string, string> = { browser: "demo.browser.goto() or demo.browser.open()", terminal: "demo.terminal.open()", editor: "demo.editor.open()" };
      throw new Error(`reelscript: window "${id}" is not open (open it with ${how[id] ?? "its open() method"} first)`);
    }
    return w;
  }

  private focused(): Win {
    if (!this.focusedId) {
      throw new Error("reelscript: no window is open (open one with browser.goto(), browser.open(), terminal.open() or editor.open())");
    }
    return this.window(this.focusedId);
  }

  /** Take a window off the desktop; focus passes to the topmost one left. */
  /** Each open terminal's and editor's options, from its last open(). */
  private lastOpen = new Map<string, Action>();

  private async closeWindow(w: Win): Promise<void> {
    this.windows.delete(w.id);
    this.lastOpen.delete(w.id); // opened again after close(), it starts from its defaults
    if (this.typing?.win === w) this.typing = null;
    await w.page.close();
    await w.ctx?.close();
    if (this.focusedId === w.id) {
      const top = this.byZ().at(-1);
      this.focusedId = top ? top.id : null;
    }
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

  /** Media sources, and page clock failures, already warned about. */
  private stuckMedia = new Set<string>();
  private clockFailures = new Set<string>();

  /**
   * A frame that navigated or went away mid-step is expected. Anything else
   * is the page clock itself failing, which would leave that page's
   * animations off the frame clock: say so once, rather than pass silently.
   */
  private clockFailed(url: string, err: unknown): undefined {
    const message = (err instanceof Error ? err.message : String(err)).split("\n")[0];
    if (/Execution context was destroyed|detached|has been closed|Target closed|Cannot find context|navigat/i.test(message)) return undefined;
    if (!this.clockFailures.has(message)) {
      this.clockFailures.add(message);
      warn(`the page clock failed in ${url}, so its animations may differ between renders: ${message}`);
    }
    return undefined;
  }

  /** Advance every window's virtual clock by `ms`. */
  async advanceClock(ms: number): Promise<void> {
    if (!this.deterministic) return;
    // Every frame of every window, iframes included: each has its own clock.
    const results = await Promise.all(
      [...this.windows.values()].flatMap((w) =>
        w.page.frames().map((f) =>
          f
            .evaluate((ms) => {
              const g = window as unknown as { __reelscript_advance?: (ms: number) => Promise<(string | undefined)[]> | undefined };
              return g.__reelscript_advance?.(ms); // resolves once any media seek has landed, with media that wouldn't move
            }, ms)
            .catch((err: unknown) => this.clockFailed(this.local.file(f.url()), err)),
        ),
      ),
    );
    for (const served of results.flat()) {
      if (!served) continue;
      const src = this.local.file(served);
      if (this.stuckMedia.has(src)) continue;
      this.stuckMedia.add(src);
      warn(
        `${src} can't be moved to the page clock's time, so it stands still in the video. ` +
          `Its server may not support HTTP Range requests (python -m http.server doesn't); open it as a local page (goto("./page.html")), or serve it with one that does`,
      );
    }
  }

  // ------------------------------------------------------------ targets

  /** Resolve a target to desktop coordinates, searching the given or focused window. */
  /** The element the cursor last moved to, which a click there is meant to hit. */
  private aimed: { selector: string; window: string } | null = null;

  /**
   * A click must land on what the cursor moved to. Another window on top, or
   * an element covering the target (an overlay, a toast), would take the
   * click instead, and the demo would carry on showing the wrong thing.
   */
  private async expectClickLands(w: Win | null, aimed: { selector: string; window: string }): Promise<void> {
    if (!w || w.id !== aimed.window) {
      throw new Error(
        `reelscript: the click on "${aimed.selector}" would land on ${w ? `the ${w.id} window` : "the desktop"}, ` +
          `which covers the ${aimed.window} window there; bring it forward first with demo.${aimed.window}.focus()`,
      );
    }
    const local = this.toLocal(w, this.cursor);
    // No named helper functions inside evaluate: some compilers wrap them in
    // helpers (__name) that don't exist in the page.
    let hits: boolean;
    try {
      const all = w.page.locator(aimed.selector);
      hits = await all
        .nth((await shownMatches(all))[0] ?? 0) // the element visible() aimed at
        .evaluate(
          (el, [x, y]) => {
            let hit = document.elementFromPoint(x, y);
            while (hit && hit.shadowRoot) {
              const inner = hit.shadowRoot.elementFromPoint(x, y);
              if (!inner || inner === hit) break;
              hit = inner;
            }
            if (!hit) return false;
            // Is the element hit the target, inside it, or around it (crossing shadow roots)?
            for (let n: Node | null = hit; n; n = n.parentNode || (n as ShadowRoot).host || null) if (n === el) return true;
            for (let n: Node | null = el; n; n = n.parentNode || (n as ShadowRoot).host || null) if (n === hit) return true;
            return false;
          },
          [local.x, local.y] as [number, number],
          { timeout: 2000 },
        );
    } catch {
      throw new Error(`reelscript: "${aimed.selector}", which the cursor moved to, was gone before the click`);
    }
    if (!hits) {
      throw new Error(`reelscript: something else in the ${w.id} window covers "${aimed.selector}" where the click would land`);
    }
  }

  /** Where in the script the current action came from, for warnings. */
  private at = "";
  /** mockAPI routes, to warn about any a whole run never used. */
  mocks: { pattern: string; at: string; hits: number }[] = [];
  /** Script lines, by action, from renderTimeline's options. */
  sources: string[] = [];
  /** Targets already warned about as ambiguous, by script line. */
  private ambiguous = new Set<string>();

  /**
   * A selector's first visible match, or a reelscript error after 3s. (A
   * hidden copy, such as a collapsed mobile menu, doesn't count.) Several
   * visible matches are a warning: the first may not be the one meant.
   */
  private async visible(w: Win, target: string) {
    const all = w.page.locator(target);
    const deadline = Date.now() + 3000;
    let seen = await shownMatches(all);
    while (!seen.length) {
      if (Date.now() > deadline) {
        // On the page but not seen: say so, since content that appears as it scrolls into view is common.
        throw new Error(
          (await all.count())
            ? `reelscript: target "${target}" is on the page but not visible in the ${w.id} window (hidden, or faded out until something shows it); if it appears as it scrolls into view, demo.scroll("${target}") first`
            : `reelscript: target "${target}" was not found in the ${w.id} window`,
        );
      }
      await new Promise((r) => setTimeout(r, 25));
      seen = await shownMatches(all);
    }
    const loc = all.nth(seen[0]);
    const count = seen.length;
    const key = `${this.at} ${target}`;
    if (count > 1 && !this.ambiguous.has(key)) {
      this.ambiguous.add(key);
      warn(
        `"${target}" matches ${count} visible elements in the ${w.id} window; using the first. ` +
          (w.kind === "editor"
            ? `For a file, name its folder too, like editor.file("src/app.ts")`
            : `An id, a data-testid, or role=button[name="…"] picks the one you mean`) +
          `\n  at ${this.at}`,
      );
    }
    return loc;
  }

  /**
   * A selector's first match that's on the page with a box, seen or not: what
   * demo.scroll() goes to, since content that fades in as it scrolls into view
   * isn't visible until scroll has brought it there.
   */
  private async present(w: Win, target: string) {
    const loc = w.page.locator(target).first();
    for (const deadline = Date.now() + 3000; !(await loc.boundingBox().catch(() => null)); ) {
      if (Date.now() > deadline) throw new Error(`reelscript: target "${target}" was not found in the ${w.id} window`);
      await new Promise((r) => setTimeout(r, 25));
    }
    return loc;
  }

  private async resolveRect(target: Target, windowId?: string): Promise<Rect> {
    const w = windowId ? this.window(windowId) : this.focused();
    if (typeof target !== "string") return { x: w.x + target.x, y: w.y + this.titleH + target.y, w: 0, h: 0 };
    const loc = await this.visible(w, target);
    let box = await this.inView(w, loc, target);
    // VS Code runs on real time, and may still be laying out (a folder
    // expanding, a panel opening) as the script aims: wait for the target to
    // stay put, so the cursor goes where the click will still find it.
    for (const deadline = Date.now() + 2000; w.kind === "editor" && Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 100));
      const now = await loc.boundingBox();
      if (!now || (Math.abs(now.x - box.x) < 0.5 && Math.abs(now.y - box.y) < 0.5)) break;
      box = await this.inView(w, loc, target);
    }
    return { x: w.x + box.x, y: w.y + this.titleH + box.y, w: box.width, h: box.height };
  }

  /** A target's box, which must be within the visible part of its window. */
  private async inView(w: Win, loc: Awaited<ReturnType<Engine["visible"]>>, target: string) {
    // A page that re-renders (VS Code on its real clock, a React update) can
    // replace the element between one read and the next, so a missing box is
    // retried within the same window as finding the element.
    let box = await loc.boundingBox();
    for (const deadline = Date.now() + 3000; !box && Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 25));
      box = await loc.boundingBox();
    }
    if (!box) throw new Error(`reelscript: target "${target}" was found but never had a position on the page`);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (cx < 0 || cy < 0 || cx > w.width || cy > w.height) {
      throw new Error(
        `reelscript: target "${target}" is outside the visible part of the ${w.id} window; ` +
          (w.kind === "browser"
            ? `scroll to it first with demo.scroll(${JSON.stringify(target)})`
            : `bring it into view first (keys, or an editor command)`),
      );
    }
    return box;
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
    this.at = this.sources[index] ? `${this.sources[index]} (${action.kind})` : action.kind;
    this.dialogAnswer = action.kind === "cursor.click" ? (action.dialog ?? null) : null;
    // open() on an open terminal or editor applies what's passed and keeps the rest from the last open().
    if (action.kind === "terminal.open" || action.kind === "editor.open") {
      const id = action.kind === "terminal.open" ? "terminal" : "editor";
      const given = Object.fromEntries(Object.entries(action).filter(([, v]) => v !== undefined));
      if (this.windows.has(id)) action = { ...this.lastOpen.get(id), ...given } as typeof action;
      this.lastOpen.set(id, action);
    }
    switch (action.kind) {
      case "browser.goto": {
        const w = await this.ensureWindow("browser", "browser");
        this.focus(w);
        // A URL as is. A path from the root ("/pricing") is a page on the site
        // the browser is showing, as in a link and in mockAPI. Any other path
        // is a local page relative to the script, like every path in it.
        let url: string;
        if (/^[a-z][a-z0-9+.-]*:/i.test(action.url)) url = action.url;
        else if (action.url.startsWith("/")) {
          const site = /^https?:/.test(w.page.url()) && !this.local.isLocal(w.page.url()) ? w.page.url() : null;
          if (!site) {
            throw new Error(
              `reelscript: goto("${action.url}"): a path from the root is a page on the website the browser is showing, and it isn't showing one. ` +
                `For a page beside the script use "./${action.url.replace(/^\/+/, "")}"; for a site, the whole URL`,
            );
          }
          url = new URL(action.url, site).href;
        } else url = await this.local.url(new URL(action.url, pathToFileURL(this.baseDir + "/")).href); // keeps ?query and #hash; see LocalPages
        const response = await w.page.goto(url, { waitUntil: "load" });
        // The page's first render, and what it sets off (observers revealing what's on screen), before its clock moves.
        await w.page.evaluate(() => (window as unknown as { __reelscript_settle?: () => Promise<void> }).__reelscript_settle?.()).catch(() => {});
        // A page that's gone still loads (the site's error page), and a demo ending there would be filmed.
        if (response && action.status !== undefined) {
          if (response.status() !== action.status) warn(`goto("${action.url}") got HTTP ${response.status()}, not the ${action.status} the script expects\n  at ${this.at}`);
        } else if (response && response.status() >= 400) {
          // A local page that isn't there is a typo in the script, not a site's error page.
          if (this.local.isLocal(url)) throw new Error(`reelscript: goto("${action.url}"): there's no page at ${fileURLToPath(this.local.file(url).replace(/[?#].*$/, ""))}`);
          warn(`goto("${action.url}") got HTTP ${response.status()} from ${url}; the page shown may be an error page\n  at ${this.at}`);
        }
        w.url = url;
        return { end: start + (action.hold ?? action.settle ?? DEFAULTS.gotoSettle) };
      }
      case "browser.mockAPI": {
        // On the context, so it applies to every window and opens none.
        // A path ("/api/projects") matches it on any origin, with any query;
        // anything else is Playwright's URL glob ("**/api/projects*") or a whole URL.
        const { pattern, response, status = 200 } = action;
        const mock = { pattern, at: this.at, hits: 0 };
        this.mocks.push(mock);
        const byPath = /^\/(?!\/)/.test(pattern) && !/[*?{]/.test(pattern);
        const matcher = byPath ? (url: URL) => url.pathname === pattern : /^\/(?!\/)/.test(pattern) ? `**${pattern}` : pattern;
        await this.context.route(matcher, (route) => {
          mock.hits++;
          return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(response) });
        });
        return null;
      }
      case "browser.open": {
        const w = await this.ensureWindow("browser", "browser", action);
        this.focus(w);
        return { end: start + 300 };
      }
      case "cursor.moveTo": {
        const to = await this.resolvePoint(action.target, action.window);
        this.aimed =
          typeof action.target === "string" ? { selector: action.target, window: action.window ?? this.focusedId ?? "" } : null;
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
        if (this.aimed) await this.expectClickLands(w, this.aimed);
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
        const w = action.window ? this.window(action.window) : this.focused();
        if (w.kind === "terminal") {
          throw new Error(`reelscript: typing into the terminal window isn't shown; use demo.terminal.run() or terminal.print()`);
        }
        if (action.window) this.focus(w);
        if (action.target) {
          const field = await this.visible(w, action.target);
          await this.inView(w, field, action.target); // like moveTo: no silent jump to an off-screen field
          await field.focus();
          // A field that can't take the keyboard would leave the keys to whatever had it before.
          const refused = await field.evaluate((el) => {
            if ((el as HTMLInputElement).disabled || el.matches(":disabled")) return "it's disabled";
            if ((el as HTMLInputElement).readOnly) return "it's read-only";
            let active = document.activeElement as HTMLElement | null;
            while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement as HTMLElement;
            let inside = false;
            for (let n: Node | null = active; n && !inside; n = n.parentNode ?? ((n as ShadowRoot).host || null)) inside = n === el;
            // Where the keys land must take text: a button or link would treat a space as a click.
            const text =
              !!active &&
              (active.isContentEditable ||
                active.matches("textarea, input:not([type=button], [type=submit], [type=reset], [type=checkbox], [type=radio], [type=file], [type=range], [type=color], [type=image], [type=hidden])"));
            return inside && text ? null : "it can't take the keyboard (it isn't a text field)";
          });
          if (refused) throw new Error(`reelscript: can't type into "${action.target}": ${refused}`);
        } else if (w.kind === "editor") {
          await this.editorFocus(w);
        }
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
        const w = action.window ? this.window(action.window) : this.focused();
        if (w.kind === "terminal") {
          throw new Error(`reelscript: keys pressed in the terminal window aren't shown; use demo.terminal.run() or terminal.print()`);
        }
        if (action.window) this.focus(w);
        // A shortcut that edits text does what it does on a Mac, as the page believes it's on one (see macKeys).
        const mac = w.kind === "browser" && process.platform !== "darwin" ? macShortcut(action.key) : null;
        if (mac) await pressMacShortcut(w.page, w.cdp, mac);
        else await w.page.keyboard.press(action.key);
        return { end: start + 100 };
      }
      case "wait":
        return { end: start + action.ms };
      case "scroll": {
        const w = action.window ? this.window(action.window) : this.focused();
        if (w.kind !== "browser") {
          throw new Error(
            w.kind === "editor"
              ? `reelscript: demo.scroll() scrolls web pages; in the editor, use keys (demo.press("Meta+ArrowDown")) or demo.editor.command("Go to Line")`
              : `reelscript: demo.scroll() scrolls web pages; a terminal scrolls as its output grows`,
          );
        }
        this.aimed = null;
        const range: { from: number; to: number; fromX?: number; toX?: number } | null = action.target
          ? await (await this.present(w, action.target)).evaluate((el) => {
              // The nearest ancestor that scrolls down, and the nearest that
              // scrolls across (a carousel, a wide table, a board), or the page.
              // (No named helper functions in here; see expectClickLands.)
              let down: Element | null = null;
              let across: Element | null = null;
              for (let c = el.parentElement; c && (!down || !across); c = c.parentElement) {
                const cs = getComputedStyle(c);
                if (!down && (cs.overflowY === "auto" || cs.overflowY === "scroll") && c.scrollHeight > c.clientHeight) down = c;
                if (!across && (cs.overflowX === "auto" || cs.overflowX === "scroll") && c.scrollWidth > c.clientWidth) across = c;
              }
              const page = document.scrollingElement!;
              const g = window as unknown as { __reelscript_scroller: Element; __reelscript_scroller_x: Element };
              g.__reelscript_scroller = down ?? page;
              g.__reelscript_scroller_x = across ?? page;
              const r = el.getBoundingClientRect();
              const dr = down ? down.getBoundingClientRect() : { top: 0, height: window.innerHeight };
              const ar = across ? across.getBoundingClientRect() : { left: 0, width: window.innerWidth };
              const y = g.__reelscript_scroller;
              const x = g.__reelscript_scroller_x;
              // Centred in each, as far as each can scroll.
              const wantY = y.scrollTop + (r.top - dr.top) - ((down ? down.clientHeight : dr.height) - r.height) / 2;
              const wantX = x.scrollLeft + (r.left - ar.left) - ((across ? across.clientWidth : ar.width) - r.width) / 2;
              return {
                from: y.scrollTop,
                to: Math.max(0, Math.min(wantY, y.scrollHeight - y.clientHeight)),
                fromX: x.scrollLeft,
                toX: Math.max(0, Math.min(wantX, x.scrollWidth - x.clientWidth)),
              };
            })
          : await w.page.evaluate(([by, to]) => {
              // The page's scroller: the document, or, in an app whose document
              // doesn't scroll, the scrolling area with the most of it on screen.
              const doc = document.scrollingElement!;
              let box: Element | null = doc.scrollHeight > doc.clientHeight ? doc : null;
              let most = 0;
              for (const el of box ? [] : Array.from(document.querySelectorAll("*"))) {
                if (el.scrollHeight <= el.clientHeight + 1) continue;
                const oy = getComputedStyle(el).overflowY;
                if (oy !== "auto" && oy !== "scroll") continue;
                const r = el.getBoundingClientRect();
                const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
                if (area > most) {
                  most = area;
                  box = el;
                }
              }
              if (!box) return null;
              (window as unknown as { __reelscript_scroller: Element }).__reelscript_scroller = box;
              const want = to ?? box.scrollTop + (by ?? 0);
              return { from: box.scrollTop, to: Math.max(0, Math.min(want, box.scrollHeight - box.clientHeight)) };
            }, [action.by ?? null, action.to ?? null] as [number | null, number | null]);
        if (!range) throw new Error("reelscript: demo.scroll() found nothing on the page that scrolls");
        const across = range.toX !== undefined ? { from: range.fromX ?? 0, to: range.toX } : null;
        const dist = Math.max(Math.abs(range.to - range.from), across ? Math.abs(across.to - across.from) : 0);
        const dur = action.duration ?? clamp(Math.round(300 + dist * 0.6), 300, 1600);
        const ease = action.ease ?? "smooth";
        const setTo = (p: number) =>
          w.page.evaluate(
            ([y, x]) => {
              const g = window as unknown as { __reelscript_scroller: Element; __reelscript_scroller_x?: Element; __reelscript_settle?: () => Promise<void> };
              g.__reelscript_scroller.scrollTo({ top: y, behavior: "instant" });
              if (x !== null && g.__reelscript_scroller_x) g.__reelscript_scroller_x.scrollTo({ left: x, behavior: "instant" });
              // What the page does about the scroll (observers, listeners) lands before the clock moves on.
              return g.__reelscript_settle?.();
            },
            [lerp(range.from, range.to, p), across ? lerp(across.from, across.to, p) : null] as [number, number | null],
          );
        return {
          end: start + dur,
          onFrame: (t: number) => setTo(progress(t, start, dur, ease)),
          onEnd: () => setTo(1),
        };
      }
      case "waitFor": {
        // Off camera: the page's clock runs a frame at a time, with real
        // time between steps for the page to lay out and paint, until the
        // target shows. No frame is filmed and no video time passes.
        const w = action.window ? this.window(action.window) : this.focused();
        const all = w.page.locator(action.target);
        const deadline = Date.now() + (action.timeout ?? 15_000);
        while (!(await shownMatches(all)).length) {
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
        const workspace = action.workspace ? resolvePath(this.baseDir, action.workspace) : undefined;
        const config = { workspace, extensions: action.extensions, settings: action.settings, baseDir: this.baseDir };
        if (this.editorServer && !this.editorServer.matches(config)) {
          // Reopened on a different workspace, extensions or settings: start fresh.
          await this.editorServer.stop();
          this.editorServer = null;
        }
        if (!this.editorServer) {
          this.editorServer = new EditorServer();
          this.onStatus("starting code-server");
          await this.editorServer.start(config, this.onStatus);
        }
        // Each editor window is a new page, so it needs its own font route.
        await w.page.route("**/__reelscript/fonts/*", (route) => {
          const name = route.request().url().split("/").pop() ?? "";
          route.fulfill({ status: 200, contentType: "font/ttf", body: readFileSync(new URL(`../assets/fonts/${name}`, import.meta.url)) });
        });
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
        await w.page.keyboard.press(action.kind === "editor.openFile" ? "Meta+P" : "F1");
        let next = 0;
        let entered = false;
        const isFile = action.kind === "editor.openFile";
        const flush = async (t: number) => {
          let batch = "";
          while (next < chars.length && typeStart + next * msPerChar <= t) batch += chars[next++];
          if (batch) await w.page.keyboard.type(batch);
          if (!entered && t >= enterAt) {
            entered = true;
            await this.expectQuickInputMatch(w, text, isFile);
            await w.page.keyboard.press("Enter");
            await this.quickInputDone(w, text, isFile);
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
      case "window.close": {
        await this.closeWindow(this.window(action.window));
        return { end: start + 200 };
      }
      case "terminal.open": {
        const w = await this.ensureWindow("terminal", "terminal", action);
        this.focus(w);
        // Opening an open terminal starts it over with what's given, font included.
        const font = JSON.stringify([action.fontSize, action.lineHeight]);
        if (w.termRouted !== font) {
          if (w.termRouted !== null) await w.page.unroute(`${TERMINAL_URL}**`);
          const html = terminalPageHtml(action.fontSize, action.lineHeight);
          await w.page.route(`${TERMINAL_URL}**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
          w.termRouted = font;
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
        if (action.cols || action.rows) {
          // One without the other keeps the fitted size in the other direction.
          dims = await w.page.evaluate(
            ([cols, rows]) =>
              (window as unknown as { __rsTerm: { resize: (c: number, r: number) => { cols: number; rows: number } } }).__rsTerm.resize(cols, rows),
            [action.cols ?? dims!.cols, action.rows ?? dims!.rows] as const,
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
        const text = events.map((e) => e[1]).join("");
        const endsWithNewline = !text || /\n$/.test(text);
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
            if (typeof action.prompt === "string") w.termPrompt = action.prompt; // a new prompt from here on
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
        const text = events.map((e) => e[1]).join("");
        const endsWithNewline = !text || /\n$/.test(text);
        let nextEvent = 0;
        let prompted = false;
        const flush = async (t: number) => {
          let out = "";
          while (nextEvent < events.length && start + events[nextEvent][0] <= t) out += events[nextEvent++][1];
          await this.termWrite(w, out, !!action.events);
          if (action.prompt && !prompted && t >= lastOut + 150) {
            prompted = true;
            if (typeof action.prompt === "string") w.termPrompt = action.prompt;
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

  /**
   * Before Enter in Quick Open or the Command Palette, make sure VS Code
   * found what was typed. Without this, a renamed command or a missing file
   * would press Enter on whatever VS Code offered instead ("similar commands",
   * "No matching results") and the demo would pass while showing the wrong
   * thing. File search is asynchronous, so wait a little for results.
   */
  private async expectQuickInputMatch(w: Win, text: string, isFile: boolean): Promise<void> {
    // VS Code can still be registering extensions (their commands) or indexing
    // files when the script gets here, and an open palette doesn't refresh its
    // list. So if nothing matches after a moment, close it and ask again with
    // the same text; this all happens between frames, so nothing extra is filmed.
    const deadline = Date.now() + 10_000;
    let asked = Date.now();
    let label: string | null = null;
    for (;;) {
      label = await w.page.evaluate(() => {
        const row = document.querySelector(".quick-input-list .monaco-list-row.focused") ?? document.querySelector(".quick-input-list .monaco-list-row");
        return row?.getAttribute("aria-label") ?? null;
      });
      if (label && quickInputMatches(label, text, isFile)) return;
      if (Date.now() > deadline) break;
      if (Date.now() - asked > 1200) {
        await w.page.keyboard.press("Escape");
        await w.page.keyboard.press(isFile ? "Meta+P" : "F1");
        await w.page.keyboard.type(text);
        asked = Date.now();
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const what = isFile ? `Quick Open found no file named "${text}"` : `the Command Palette has no command named "${text}"`;
    let offered = "";
    if (label && !/^No matching/i.test(label)) {
      const row = label.split(", ")[0]; // "app.ts src" (a file and its folder) or "Format Document"
      const space = row.indexOf(" ");
      offered = ` (VS Code offered "${isFile && space > 0 ? `${row.slice(space + 1)}/${row.slice(0, space)}` : row}" instead)`;
    }
    throw new Error(`reelscript: ${what}${offered}`);
  }

  /**
   * editor.type() types at the caret. If keyboard focus is somewhere that
   * isn't text (the Explorer after clicking a file, say), the keys would
   * select files instead of typing; move it to the open file (⌘1, "focus
   * the first editor group"), or fail if there's none. VS Code may still be
   * opening the file it was just asked for and take focus back, so it must
   * stay in the editor a moment before typing starts. Quick Open and a
   * command's own prompt count as text.
   */
  private async editorFocus(w: Win): Promise<void> {
    const typable = () =>
      w.page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return !!el && (!!el.closest(".monaco-editor") || el.matches("input, textarea") || el.isContentEditable);
      });
    if (await typable()) return;
    let steadySince = 0;
    for (const deadline = Date.now() + 3000; Date.now() < deadline; ) {
      if (!(await typable())) {
        steadySince = 0;
        await w.page.keyboard.press("Meta+1");
      } else if (!steadySince) steadySince = Date.now();
      else if (Date.now() - steadySince >= 300) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (steadySince) return;
    throw new Error("reelscript: editor.type() has nowhere to type: no file is open in the editor (open one with editor.openFile())");
  }

  /**
   * After Enter, wait (on VS Code's real clock) until it has done what was
   * asked, so the next step never races it: for a file, its tab is active
   * and the caret is in it, and the Explorer, if it's showing, has revealed
   * it (expanding its folder moves the rows below, which the next click may
   * be aiming at); for a command, the palette has closed or moved on to the
   * command's own prompt (as "Go to Line" does).
   */
  private async quickInputDone(w: Win, text: string, isFile: boolean): Promise<void> {
    const name = text.split("/").pop() ?? text;
    const deadline = Date.now() + 10_000;
    let openedAt = 0;
    for (;;) {
      const state = await w.page.evaluate(
        ([isFile, name, typed]) => {
          const widget = document.querySelector(".quick-input-widget") as HTMLElement | null;
          const open = !!widget && getComputedStyle(widget).display !== "none";
          const input = document.querySelector(".quick-input-box input") as HTMLInputElement | null;
          if (!isFile) return !open || (input !== null && input.value !== typed) ? "done" : "waiting";
          if (open) return "waiting";
          const tab = document.querySelector(".tabs-container .tab.active");
          const inEditor = !!document.activeElement?.closest(".monaco-editor");
          if (!(tab?.getAttribute("aria-label") ?? "").includes(name) || !inEditor) return "waiting";
          const explorer = document.querySelector(".explorer-folders-view") as HTMLElement | null;
          if (!explorer || explorer.getBoundingClientRect().height === 0) return "done";
          const rows = Array.from(explorer.querySelectorAll(".monaco-list-row.selected"));
          return rows.some((r) => r.getAttribute("aria-label") === name) ? "done" : "opened";
        },
        [isFile, name, isFile ? text : `>${text}`] as [boolean, string, string],
      );
      if (state === "done") return;
      // A workspace set not to reveal files (explorer.autoReveal) never will; don't wait long for it.
      if (state === "opened") {
        openedAt ||= Date.now();
        if (Date.now() - openedAt > 2000) return;
      }
      if (Date.now() > deadline) {
        throw new Error(isFile ? `reelscript: VS Code didn't finish opening "${text}"` : `reelscript: VS Code didn't run "${text}"`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Time (ms) after which nothing is still animating or speaking. */
  pendingUntil(): number {
    const zoom = this.zoomAnim ? this.zoomAnim.start + this.zoomAnim.dur : 0;
    const follow = this.follow && this.attention ? this.attention.at + this.follow.hold + 900 : 0;
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
    const active = this.attention && t - this.attention.at < f.hold;
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
    if (!this.inContent(w, local)) return;
    // Only when the cursor (or the window under it) changed: a page's hover
    // state holds between moves, and each move is a round trip to the browser.
    const at = `${w.id}:${w.page.url()}:${Math.round(local.x)},${Math.round(local.y)}`;
    if (at === this.mouseAt) return;
    this.mouseAt = at;
    await w.page.mouse.move(local.x, local.y);
  }

  private mouseAt = "";

  // ------------------------------------------------------------ frames

  /**
   * Capture a window via CDP rather than page.screenshot(): Playwright's
   * screenshot waits for an in-page requestAnimationFrame, which is under
   * our control and slower; CDP grabs the current compositor frame directly.
   */
  private async capture(w: Win): Promise<Buffer> {
    return retryCapture(`the ${w.id} window`, async () => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the page's compositor stalled for 10s")), 10_000);
      });
      try {
        const { data } = await Promise.race([w.cdp.send("Page.captureScreenshot", { format: "png" }), timeout]);
        return Buffer.from(data, "base64");
      } finally {
        clearTimeout(timer);
      }
    });
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
    const page = w.kind === "browser" ? this.local.file(w.page.url()) : w.url; // a local page shows as the file it is
    const url = w.kind === "browser" && this.address ? this.address(page) : page;
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

/**
 * Which of a locator's matches a viewer could see, by index: a box, visible
 * itself, and nothing it's inside faded all the way out. Playwright counts
 * an element in an opacity: 0 container (a closed modal) as visible; a
 * target there would be filmed as an empty page. Anything fading in (above
 * 0) counts. The same rule decides the caret and MCP's inspect_page.
 */
async function shownMatches(all: Locator): Promise<number[]> {
  return all.evaluateAll((els) => {
    const out: number[] = [];
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      const r = el.getBoundingClientRect();
      if (!el.isConnected || r.width <= 0 || r.height <= 0 || getComputedStyle(el).visibility !== "visible") continue;
      let clear = true;
      for (let n: Element | null = el; n && clear; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host || null)) {
        if (getComputedStyle(n).opacity === "0") clear = false;
      }
      if (clear) out.push(i);
    }
    return out;
  });
}

/**
 * The browser window has no tabs, and a page Chromium opened in a new one
 * would never be seen: a link or window.open() that would open a new tab
 * or window opens in this one instead, as if the demo had switched to it.
 * Links are retargeted before the click's own navigation, so it happens on
 * the frame clock like any other.
 */
const ONE_TAB = String.raw`
(() => {
  const here = (t) => /^_(self|parent|top)$/i.test(t || "");
  // _top: from an iframe, the page takes the whole window, as a new tab would.
  const retarget = (el, attr) => {
    const t = el.getAttribute(attr) ?? document.querySelector("base[target]")?.getAttribute("target");
    if (t && !here(t)) el.setAttribute(attr, "_top");
  };
  document.addEventListener("click", (e) => {
    const link = e.composedPath().find((n) => n instanceof Element && n.matches("a[href], area[href]"));
    if (link) retarget(link, "target");
  }, true);
  document.addEventListener("submit", (e) => {
    if (e.target instanceof HTMLFormElement) retarget(e.target, "target");
    if (e.submitter && e.submitter.hasAttribute("formtarget")) retarget(e.submitter, "formtarget");
  }, true);
  const realOpen = window.open;
  window.open = function (url, target, features) {
    if (!url || here(target)) return realOpen.apply(this, arguments);
    const href = new URL(url, document.baseURI).href;
    try { window.top.location.assign(href); } catch { location.assign(href); }
    return window.top;
  };
})();
`;

/**
 * Whether a Quick Open or Command Palette row is what the script asked for.
 * VS Code's fuzzy search offers something for almost anything typed
 * ("app.ts" finds webapp.ts), so a file must match by name, and by folder
 * when one is given, and a command by its whole name, with or without its
 * category. Rows read "app.ts src, recently opened" and "View: Toggle Word Wrap, Alt+Z".
 */
export function quickInputMatches(label: string, text: string, isFile: boolean): boolean {
  if (/^No matching (results|commands)|similar commands$/i.test(label)) return false;
  const row = label.split(", ")[0];
  if (!isFile) {
    const name = row.toLowerCase();
    const want = text.trim().toLowerCase();
    return name === want || name.endsWith(`: ${want}`);
  }
  const path = text.trim().replace(/^\.\//, "");
  const slash = path.lastIndexOf("/");
  const base = path.slice(slash + 1);
  if (row !== base && !row.startsWith(`${base} `)) return false;
  if (slash < 0) return true;
  const dir = path.slice(0, slash);
  const folder = row.slice(base.length + 1);
  return folder === dir || folder.endsWith(`/${dir}`);
}

/**
 * Chromium sometimes refuses a screenshot while a heavy page is busy
 * ("Unable to capture screenshot"); a moment later it succeeds. Retry a few
 * times, then fail with a message that says what couldn't be captured.
 */
async function retryCapture<T>(what: string, attempt: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      return await attempt();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  const why = last instanceof Error ? last.message.split("\n")[0] : String(last);
  throw new Error(`reelscript: couldn't capture ${what}: ${why}`);
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

  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const menubar: Menubar =
    options.menubar === false
      ? false
      : {
          app: options.menubar?.app,
          clockText: options.menubar?.clockText ?? options.menubar?.clock ?? menubarClock(clockEpoch(options.clock ?? DEFAULT_CLOCK, timezone), timezone),
        };
  const engine = new Engine(viewport, options.desktop, themeName, options.deterministic ?? true, menubar, frameMs);
  if (options.onStatus) engine.onStatus = options.onStatus;
  engine.sources = options.sources ?? [];
  engine.timezone = options.timezone ?? DEFAULT_TIMEZONE;
  engine.epoch = clockEpoch(options.clock ?? DEFAULT_CLOCK, engine.timezone);
  engine.session = options.session;
  engine.setCamera(options.camera, actions);
  if (options.address) engine.address = options.address;
  if (options.baseDir) engine.baseDir = options.baseDir;
  const [width, height] = engine.desktop;

  const warningsAtStart = warningCount();
  // Before anything slow (synthesizing narration, first downloading its model): a format render can't write fails now.
  if (snapshot === undefined && options.out) checkOutputFormat(options.out);

  const where = (index: number, err: unknown): Error => {
    const e = err instanceof Error ? err : new Error(String(err));
    const loc = options.sources?.[index];
    if (loc && !e.message.includes(`\n  at ${loc}`)) e.message += `\n  at ${loc} (${actions[index]?.kind})`;
    return e;
  };

  // Narration is synthesized up front so clip durations can pace the timeline.
  const sayIndexes = actions.flatMap((a, i) => (a.kind === "say" ? [i] : []));
  const isGif = extname(options.out).toLowerCase() === ".gif";
  const check = options.check ?? false;
  const hasAudio = sayIndexes.length > 0 && snapshot === undefined && !isGif && !check;
  if (sayIndexes.length) {
    // A misspelt voice fails here, in check as in render, at its say() line.
    const tts = options.tts ?? kokoro();
    for (const i of sayIndexes) {
      const voice = voiceFor(tts, (actions[i] as Extract<Action, { kind: "say" }>).voice ?? options.voice);
      if (voice !== undefined && tts.voices && !tts.voices.includes(voice)) {
        throw where(i, new Error(`reelscript: unknown voice "${voice}". Voices: ${tts.voices.join(", ")}`));
      }
    }
  }
  if (sayIndexes.length && check) {
    // The real length when this line has been synthesized before (any render
    // or preview of it), so check paces the timeline as render will; otherwise
    // an estimate (~155 wpm), without loading the voice model.
    const tts = options.tts ?? kokoro();
    const clips = new Map<number, Clip>();
    for (const i of sayIndexes) {
      const a = actions[i] as Extract<Action, { kind: "say" }>;
      const text = applyPronunciations(a.text, options.pronunciations);
      const cached = cachedClip(tts, text, { voice: a.voice ?? options.voice, speed: a.speed });
      if (!cached) {
        // Render would synthesize this line: the engine must be able to run.
        try {
          await tts.ready?.();
        } catch (err) {
          throw where(i, err);
        }
      }
      const words = text.split(/\s+/).filter(Boolean).length;
      clips.set(i, cached ?? { file: "", seconds: Math.max(0.6, words / 2.6) });
    }
    engine.setClips(clips);
  } else if (sayIndexes.length) {
    const tts = options.tts ?? kokoro();
    options.onStatus?.(`synthesizing narration (${sayIndexes.length} clip${sayIndexes.length === 1 ? "" : "s"})`);
    const clips = new Map<number, Clip>();
    try {
      for (const i of sayIndexes) {
        const a = actions[i] as Extract<Action, { kind: "say" }>;
        const text = applyPronunciations(a.text, options.pronunciations);
        try {
          clips.set(i, await synthesizeClip(tts, text, { voice: a.voice ?? options.voice, speed: a.speed }));
        } catch (err) {
          throw where(i, err);
        }
      }
    } finally {
      // Release the voice model now: left loaded, it can crash the process on exit.
      await tts.dispose?.();
    }
    engine.setClips(clips);
    if (isGif && snapshot === undefined) options.onStatus?.("note: GIF output has no audio; narration is used for pacing only");
  }



  // Terminal output: declared in the script, or replayed from a recording.
  const termRuns = actions.flatMap((a, i) => (a.kind === "terminal.run" ? [i] : []));
  const recKeys = recordingKeys(actions as never);
  const termPrints = actions.flatMap((a, i) => (a.kind === "terminal.print" ? [i] : []));
  if (termRuns.length || termPrints.length) {
    const events = new Map<number, TermEvent[]>();
    for (const i of termPrints) {
      const a = actions[i] as Extract<Action, { kind: "terminal.print" }>;
      events.set(i, a.events ? playbackEvents(a.events, { speed: a.speed, maxGap: a.maxGap ?? a.maxGapMs }) : scriptedEvents(a.text ?? "", a.duration));
    }
    for (const i of termRuns) {
      const a = actions[i] as Extract<Action, { kind: "terminal.run" }>;
      if (a.events) {
        events.set(i, playbackEvents(a.events, { speed: a.speed, maxGap: a.maxGap ?? a.maxGapMs }));
        continue;
      }
      if (a.output !== undefined) {
        events.set(i, scriptedEvents(a.output, a.duration));
        continue;
      }
      const rec = options.recordingsDir ? loadRecording(options.recordingsDir, a.command, recKeys.get(i)) : null;
      if (!rec) {
        throw where(
          i,
          new Error(
            `reelscript: no recording for terminal command "${a.command}" in ${options.recordingsDir}.\n` +
              `  Declare its output with terminal.run(cmd, { output }), or record it:\n` +
              `  npx @reelscript/cli record <script>`,
          ),
        );
      }
      events.set(i, playbackEvents(rec.events, { speed: a.speed, maxGap: a.maxGap ?? a.maxGapMs }));
    }
    engine.setTerminalEvents(events);
  }

  // Encode beside the output under a hidden name, and replace the output only
  // once everything succeeded, so a failed render never destroys the last good one.
  const outExt = extname(options.out);
  const outBase = basename(options.out, outExt);
  const partial = join(dirname(options.out), `.${outBase}.partial${outExt}`);
  const videoPath = hasAudio ? join(dirname(options.out), `.${outBase}.video.partial.mp4`) : partial;
  let finished = false;
  const removePartials = async () => {
    await stopEncoders(); // first, or ffmpeg rewrites the file after it's removed
    for (const p of [partial, videoPath]) rmSync(p, { force: true });
  };
  const unregisterPartial = onInterrupt(removePartials);
  const encoder = snapshot === undefined && !check ? new Encoder({ out: videoPath, width, height, fps, gif: options.gif }) : null;

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
      await engine.syncMouse(); // in check too: hover menus must open as they do in a render
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
        const last = endAt !== null && t + frameMs >= endAt;
        // This is the video's last frame, so it's as long as a render would say (allowing for that rounding).
        const videoMs = last ? t + frameMs : Infinity;
        if (snapshot > videoMs + 5) {
          throw new Error(`reelscript: ${(snapshot / 1000).toFixed(2)}s is past the end of the demo, which is ${(videoMs / 1000).toFixed(2)}s long`);
        }
        if (t + frameMs / 2 >= snapshot || last) {
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
    // A mock nothing asked for is usually a pattern that doesn't match what the page requests.
    for (const m of snapshot === undefined ? engine.mocks : []) {
      if (m.hits) continue;
      warn(
        `mockAPI("${m.pattern}") never matched a request. ` +
          `A pattern is a path ("/api/projects"), a URL glob ("**/api/projects*"), or a whole URL\n  at ${m.at}`,
      );
    }
    await encoder?.finish();
    if (encoder) {
      if (hasAudio && engine.narration.length) {
        options.onStatus?.("mixing narration");
        await muxNarration(videoPath, engine.narration, partial);
        unlinkSync(videoPath);
      } else if (videoPath !== partial) {
        renameSync(videoPath, partial);
      }
      // Under --strict, a render with warnings fails, and like any failed render leaves the previous output in place.
      const warned = warningCount() - warningsAtStart;
      if (process.env.REELSCRIPT_STRICT && warned) {
        throw new Error(`reelscript: ${warned} warning${warned === 1 ? "" : "s"} above, and --strict makes a render with warnings fail; ${options.out} is unchanged`);
      }
      renameSync(partial, options.out);
    }
    finished = true;
  } finally {
    await engine.close();
    unregisterPartial();
    if (!finished) await removePartials();
  }

  if (isGif && snapshot === undefined && !check) {
    // What the GIF holds, not the frames captured for it.
    const gif = gifSize(width, height, options.gif);
    return { out: options.out, frames: Math.round((t / 1000) * gif.fps), durationMs: Math.round(t), width: gif.width, height: gif.height };
  }
  return { out: options.out, frames, durationMs: Math.round(t), width, height };
}
