import sharp from "sharp";
import { readFileSync } from "node:fs";

/**
 * A theme turns a raw page screenshot into a "scene": the full frame that
 * gets zoomed and cursor-overlaid. `bare` is the page itself; `macos` puts
 * the page inside a browser window on a mocked macOS desktop.
 *
 * Chrome (wallpaper, menubar, window frame) is rendered as HTML by Chromium
 * using a font bundled with the package, so the same script produces the
 * same pixels on macOS, Linux, and in the container.
 */

export type ThemeName = "macos" | "bare";

export interface SceneLayout {
  width: number;
  height: number;
  /** Where the page screenshot lands inside the scene. */
  pageX: number;
  pageY: number;
  pageW: number;
  pageH: number;
}

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 3 | 4;
}

export interface SceneState {
  /** What the window is showing; picks the chrome style. */
  window: "browser" | "terminal";
  url: string;
  /** Title shown for terminal windows. */
  title: string;
}

/** Renders an HTML document of the given size to a PNG. Provided by the engine. */
export type HtmlRasterizer = (html: string, width: number, height: number) => Promise<Buffer>;

export interface Theme {
  layout(viewport: [number, number]): SceneLayout;
  /** Compose the scene (RGBA raw) from a PNG screenshot of the page. */
  compose(shot: Buffer, state: SceneState): Promise<RawImage>;
}

function even(n: number): number {
  return n % 2 === 0 ? n : n + 1;
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
  constructor(private viewport: [number, number]) {}

  layout(): SceneLayout {
    const [w, h] = this.viewport;
    return { width: even(w), height: even(h), pageX: 0, pageY: 0, pageW: w, pageH: h };
  }

  async compose(shot: Buffer): Promise<RawImage> {
    const l = this.layout();
    const { data, info } = await sharp(shot)
      .ensureAlpha()
      .resize(l.width, l.height, { fit: "contain", position: "left top", background: "#000" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: 4 };
  }
}

// ---------------------------------------------------------------- macos

const MENUBAR_H = 28;
const PAD_X = 72;
const GAP_TOP = 44;
const TITLE_H = 48;
const PAD_BOTTOM = 72;
const RADIUS = 12;

class MacosTheme implements Theme {
  private bg = new Map<string, Promise<{ base: RawImage; cornerBL: Buffer; cornerBR: Buffer }>>();

  constructor(
    private viewport: [number, number],
    private rasterize: HtmlRasterizer,
  ) {}

  layout(): SceneLayout {
    const [vw, vh] = this.viewport;
    const width = even(vw + PAD_X * 2);
    const pageY = MENUBAR_H + GAP_TOP + TITLE_H;
    const height = even(pageY + vh + PAD_BOTTOM);
    return { width, height, pageX: PAD_X, pageY, pageW: vw, pageH: vh };
  }

  private html(state: SceneState): string {
    const l = this.layout();
    const winX = l.pageX;
    const winY = l.pageY - TITLE_H;
    const winW = l.pageW;
    const winH = l.pageH + TITLE_H;
    const terminal = state.window === "terminal";
    const urlW = Math.min(560, Math.round(winW * 0.46));
    const titleBar = terminal
      ? `<div class="title term"><div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
         <div class="ttl">${escapeHtml(state.title)}</div></div>`
      : `<div class="title"><div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
         <div class="url">${escapeHtml(displayUrl(state.url))}</div></div>`;
    return `<!doctype html><html><head><meta charset="utf-8"><style>
${bundledFontFace()}
html, body { margin: 0; width: ${l.width}px; height: ${l.height}px; overflow: hidden;
  font-family: Inter, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
.wall { position: absolute; inset: 0;
  background: linear-gradient(135deg, #4f46e5 0%, #c2410c 55%, #f59e0b 100%); }
.glow { position: absolute; inset: 0;
  background: radial-gradient(80% 80% at 30% 20%, rgba(255,255,255,.22), rgba(255,255,255,0)); }
.menubar { position: absolute; left: 0; top: 0; right: 0; height: ${MENUBAR_H}px;
  background: rgba(255,255,255,.16); color: #fff; font-size: 13px;
  display: flex; align-items: center; justify-content: space-between; padding: 0 18px; }
.menubar b { font-weight: 600; }
.window { position: absolute; left: ${winX}px; top: ${winY}px; width: ${winW}px; height: ${winH}px;
  border-radius: ${RADIUS}px; background: ${terminal ? "#1c1c1e" : "#ffffff"}; overflow: hidden;
  box-shadow: 0 22px 48px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.25); }
.title { position: relative; height: ${TITLE_H}px; background: #f3f3f5; border-bottom: 1px solid #dcdce1; }
.title.term { background: #2c2c2e; border-bottom: 1px solid #3a3a3c; }
.lights { position: absolute; left: 16px; top: ${TITLE_H / 2 - 6}px; display: flex; gap: 8px; }
.lights i { display: block; width: 12px; height: 12px; border-radius: 50%; }
.url { position: absolute; left: 50%; top: 12px; transform: translateX(-50%);
  width: ${urlW}px; height: ${TITLE_H - 24}px; border-radius: 7px; background: #e6e6ea;
  color: #3f3f46; font-size: 12.5px; display: flex; align-items: center; justify-content: center;
  white-space: nowrap; overflow: hidden; }
.ttl { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: #a1a1a6; font-size: 13px; font-weight: 500; }
</style></head><body>
<div class="wall"></div><div class="glow"></div>
<div class="menubar"><b>reelscript</b><span>Tue Sep 23&nbsp;&nbsp;9:41 AM</span></div>
<div class="window">${titleBar}</div>
</body></html>`;
  }

  private assets(state: SceneState) {
    const key = `${state.window}|${state.url}|${state.title}`;
    let p = this.bg.get(key);
    if (!p) {
      p = (async () => {
        const l = this.layout();
        const png = await this.rasterize(this.html(state), l.width, l.height);
        const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const base: RawImage = { data, width: info.width, height: info.height, channels: 4 };
        const r = RADIUS;
        // Bottom-corner "covers": wallpaper patches masked to the area outside the
        // window's rounded corner, composited over the (rectangular) screenshot.
        const maskBL = `<svg xmlns="http://www.w3.org/2000/svg" width="${r}" height="${r}"><path d="M0 0 L0 ${r} L${r} ${r} A${r} ${r} 0 0 1 0 0 Z" fill="#fff"/></svg>`;
        const maskBR = `<svg xmlns="http://www.w3.org/2000/svg" width="${r}" height="${r}"><path d="M${r} 0 L${r} ${r} L0 ${r} A${r} ${r} 0 0 0 ${r} 0 Z" fill="#fff"/></svg>`;
        const corner = (left: number, mask: string) =>
          sharp(png)
            .extract({ left, top: l.pageY + l.pageH - r, width: r, height: r })
            .composite([{ input: Buffer.from(mask), blend: "dest-in" }])
            .png()
            .toBuffer();
        const [cornerBL, cornerBR] = await Promise.all([
          corner(l.pageX, maskBL),
          corner(l.pageX + l.pageW - r, maskBR),
        ]);
        return { base, cornerBL, cornerBR };
      })();
      this.bg.set(key, p);
    }
    return p;
  }

  async compose(shot: Buffer, state: SceneState): Promise<RawImage> {
    const l = this.layout();
    const { base, cornerBL, cornerBR } = await this.assets(state);
    const r = RADIUS;
    const { data, info } = await sharp(base.data, {
      raw: { width: base.width, height: base.height, channels: 4 },
    })
      .composite([
        { input: shot, left: l.pageX, top: l.pageY },
        { input: cornerBL, left: l.pageX, top: l.pageY + l.pageH - r },
        { input: cornerBR, left: l.pageX + l.pageW - r, top: l.pageY + l.pageH - r },
      ])
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: 4 };
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

export function createTheme(name: ThemeName, viewport: [number, number], rasterize: HtmlRasterizer): Theme {
  switch (name) {
    case "bare":
      return new BareTheme(viewport);
    case "macos":
      return new MacosTheme(viewport, rasterize);
    default:
      throw new Error(`reelscript: unknown theme "${name as string}"`);
  }
}
