import sharp from "sharp";
import { readFileSync } from "node:fs";

/**
 * A theme draws the desktop: the wallpaper and menubar behind everything,
 * a frame (title bar, shadow, rounded corners) around each window, and the
 * mask that rounds a window's content. The engine composes these per frame.
 *
 * Chrome is rendered as HTML by Chromium with fonts bundled in the package,
 * so the same script produces the same pixels on every platform.
 */

export type ThemeName = "macos" | "bare";
export type WindowKind = "browser" | "terminal";

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 4;
}

/** A frame image plus where it sits relative to the window's frame origin. */
export interface FrameImage extends RawImage {
  dx: number;
  dy: number;
}

export interface WindowStyle {
  kind: WindowKind;
  /** Content size. */
  width: number;
  height: number;
  title: string;
  url: string;
  focused: boolean;
}

/** Renders an HTML document of the given size to a PNG. Provided by the engine. */
export type HtmlRasterizer = (html: string, width: number, height: number, transparent: boolean) => Promise<Buffer>;

export interface Theme {
  /** Height of a window's title bar (0 when windows have no chrome). */
  readonly titleHeight: number;
  /** Desktop size when the script doesn't set one, given the main window's content size. */
  defaultDesktop(viewport: [number, number]): [number, number];
  /** Frame origin for the first window opened. */
  mainPlacement(desktop: [number, number], content: [number, number]): { x: number; y: number };
  background(desktop: [number, number]): Promise<RawImage>;
  /** Window chrome, or null for none. */
  frame(style: WindowStyle): Promise<FrameImage | null>;
  /** Alpha mask applied to window content, or null for none. */
  contentMask(width: number, height: number): Promise<RawImage | null>;
}

function even(n: number): number {
  return n % 2 === 0 ? n : n + 1;
}

async function toRaw(png: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 4 };
}

// ---------------------------------------------------------------- font

let fontFace: string | null = null;

/** @font-face rule embedding the bundled Inter variable font. */
export function bundledFontFace(): string {
  if (!fontFace) {
    const ttf = readFileSync(new URL("../assets/fonts/InterVariable.ttf", import.meta.url));
    fontFace = `@font-face { font-family: "Inter"; font-weight: 100 900; font-style: normal;
      src: url(data:font/ttf;base64,${ttf.toString("base64")}) format("truetype"); }`;
  }
  return fontFace;
}

// ---------------------------------------------------------------- bare

class BareTheme implements Theme {
  readonly titleHeight = 0;
  private bg: RawImage | null = null;

  defaultDesktop(viewport: [number, number]): [number, number] {
    return [even(viewport[0]), even(viewport[1])];
  }

  mainPlacement(): { x: number; y: number } {
    return { x: 0, y: 0 };
  }

  async background([w, h]: [number, number]): Promise<RawImage> {
    if (!this.bg || this.bg.width !== w || this.bg.height !== h) {
      const data = Buffer.alloc(w * h * 4);
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      this.bg = { data, width: w, height: h, channels: 4 };
    }
    return this.bg;
  }

  async frame(): Promise<null> {
    return null;
  }

  async contentMask(): Promise<null> {
    return null;
  }
}

// ---------------------------------------------------------------- macos

const MENUBAR_H = 28;
const PAD_X = 72;
const GAP_TOP = 44;
const TITLE_H = 48;
const PAD_BOTTOM = 72;
const RADIUS = 12;
/** Room around a frame for its drop shadow. */
const SHADOW_PAD = 64;

class MacosTheme implements Theme {
  readonly titleHeight = TITLE_H;
  private bgCache = new Map<string, Promise<RawImage>>();
  private frameCache = new Map<string, Promise<FrameImage>>();
  private maskCache = new Map<string, Promise<RawImage>>();

  constructor(private rasterize: HtmlRasterizer) {}

  defaultDesktop([vw, vh]: [number, number]): [number, number] {
    return [even(vw + PAD_X * 2), even(MENUBAR_H + GAP_TOP + TITLE_H + vh + PAD_BOTTOM)];
  }

  mainPlacement([dw]: [number, number], [w]: [number, number]): { x: number; y: number } {
    return { x: Math.round((dw - w) / 2), y: MENUBAR_H + GAP_TOP };
  }

  private css(): string {
    return `${bundledFontFace()}
html, body { margin: 0; overflow: hidden; font-family: Inter, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }`;
  }

  background(desktop: [number, number]): Promise<RawImage> {
    const [w, h] = desktop;
    const key = `${w}x${h}`;
    let p = this.bgCache.get(key);
    if (!p) {
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${this.css()}
html, body { width: ${w}px; height: ${h}px; }
.wall { position: absolute; inset: 0; background: linear-gradient(135deg, #4f46e5 0%, #c2410c 55%, #f59e0b 100%); }
.glow { position: absolute; inset: 0; background: radial-gradient(80% 80% at 30% 20%, rgba(255,255,255,.22), rgba(255,255,255,0)); }
.menubar { position: absolute; left: 0; top: 0; right: 0; height: ${MENUBAR_H}px; background: rgba(255,255,255,.16);
  color: #fff; font-size: 13px; display: flex; align-items: center; justify-content: space-between; padding: 0 18px; }
.menubar b { font-weight: 600; }
</style></head><body>
<div class="wall"></div><div class="glow"></div>
<div class="menubar"><b>reelscript</b><span>Tue Sep 23&nbsp;&nbsp;9:41 AM</span></div>
</body></html>`;
      p = this.rasterize(html, w, h, false).then(toRaw);
      this.bgCache.set(key, p);
    }
    return p;
  }

  frame(style: WindowStyle): Promise<FrameImage> {
    const key = JSON.stringify(style);
    let p = this.frameCache.get(key);
    if (!p) {
      const { kind, width, height, focused } = style;
      const W = width + SHADOW_PAD * 2;
      const H = height + TITLE_H + SHADOW_PAD * 2;
      const terminal = kind === "terminal";
      const urlW = Math.min(560, Math.round(width * 0.46));
      const lights = focused
        ? ["#ff5f57", "#febc2e", "#28c840"]
        : terminal
          ? ["#5a5a5e", "#5a5a5e", "#5a5a5e"]
          : ["#d4d4d8", "#d4d4d8", "#d4d4d8"];
      const bar = terminal
        ? `<div class="ttl">${escapeHtml(style.title)}</div>`
        : `<div class="url">${escapeHtml(displayUrl(style.url))}</div>`;
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${this.css()}
html, body { width: ${W}px; height: ${H}px; background: transparent; }
.window { position: absolute; left: ${SHADOW_PAD}px; top: ${SHADOW_PAD}px; width: ${width}px; height: ${height + TITLE_H}px;
  border-radius: ${RADIUS}px; background: ${terminal ? "#1c1c1e" : "#ffffff"}; overflow: hidden;
  box-shadow: ${focused ? "0 22px 48px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.25)" : "0 12px 28px rgba(0,0,0,.28), 0 1px 4px rgba(0,0,0,.2)"}; }
.title { position: relative; height: ${TITLE_H}px; background: ${terminal ? "#2c2c2e" : "#f3f3f5"};
  border-bottom: 1px solid ${terminal ? "#3a3a3c" : "#dcdce1"}; }
.lights { position: absolute; left: 16px; top: ${TITLE_H / 2 - 6}px; display: flex; gap: 8px; }
.lights i { display: block; width: 12px; height: 12px; border-radius: 50%; }
.url { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); width: ${urlW}px; height: ${TITLE_H - 24}px;
  border-radius: 7px; background: #e6e6ea; color: ${focused ? "#3f3f46" : "#8e8e93"}; font-size: 12.5px;
  display: flex; align-items: center; justify-content: center; white-space: nowrap; overflow: hidden; }
.ttl { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: ${focused ? "#a1a1a6" : "#6e6e73"}; font-size: 13px; font-weight: 500; }
</style></head><body>
<div class="window"><div class="title">
  <div class="lights"><i style="background:${lights[0]}"></i><i style="background:${lights[1]}"></i><i style="background:${lights[2]}"></i></div>
  ${bar}
</div></div>
</body></html>`;
      p = this.rasterize(html, W, H, true)
        .then(toRaw)
        .then((img) => ({ ...img, dx: -SHADOW_PAD, dy: -SHADOW_PAD }));
      this.frameCache.set(key, p);
    }
    return p;
  }

  contentMask(width: number, height: number): Promise<RawImage> {
    const key = `${width}x${height}`;
    let p = this.maskCache.get(key);
    if (!p) {
      const r = RADIUS;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <path d="M0 0 H${width} V${height - r} A${r} ${r} 0 0 1 ${width - r} ${height} H${r} A${r} ${r} 0 0 1 0 ${height - r} Z" fill="#fff"/>
      </svg>`;
      p = sharp(Buffer.from(svg)).png().toBuffer().then(toRaw);
      this.maskCache.set(key, p);
    }
    return p;
  }
}

function displayUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("file://")) return url.split("/").pop() ?? url;
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function createTheme(name: ThemeName, rasterize: HtmlRasterizer): Theme {
  switch (name) {
    case "bare":
      return new BareTheme();
    case "macos":
      return new MacosTheme(rasterize);
    default:
      throw new Error(`reelscript: unknown theme "${name as string}"`);
  }
}
