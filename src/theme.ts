import sharp from "sharp";

/**
 * A theme turns a raw page screenshot into a "scene": the full frame that
 * gets zoomed and cursor-overlaid. `bare` is the page itself; `macos` puts
 * the page inside a browser window on a mocked macOS desktop.
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
  url: string;
}

export interface Theme {
  layout(viewport: [number, number]): SceneLayout;
  /** Compose the scene (RGBA raw) from a PNG screenshot of the page. */
  compose(shot: Buffer, state: SceneState): Promise<RawImage>;
}

function even(n: number): number {
  return n % 2 === 0 ? n : n + 1;
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

  constructor(private viewport: [number, number]) {}

  layout(): SceneLayout {
    const [vw, vh] = this.viewport;
    const width = even(vw + PAD_X * 2);
    const pageY = MENUBAR_H + GAP_TOP + TITLE_H;
    const height = even(pageY + vh + PAD_BOTTOM);
    return { width, height, pageX: PAD_X, pageY, pageW: vw, pageH: vh };
  }

  private svg(state: SceneState): string {
    const l = this.layout();
    const winX = l.pageX;
    const winY = l.pageY - TITLE_H;
    const winW = l.pageW;
    const winH = l.pageH + TITLE_H;
    const urlW = Math.min(560, Math.round(winW * 0.46));
    const urlX = winX + Math.round((winW - urlW) / 2);
    const urlY = winY + 12;
    const url = escapeXml(displayUrl(state.url));
    const font = `font-family="-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif"`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${l.width}" height="${l.height}">
  <defs>
    <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4f46e5"/>
      <stop offset="0.55" stop-color="#c2410c"/>
      <stop offset="1" stop-color="#f59e0b"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.3" cy="0.2" r="0.8">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="22"/>
      <feOffset dx="0" dy="22" result="s"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.55"/></feComponentTransfer>
    </filter>
    <clipPath id="win"><rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${RADIUS}"/></clipPath>
  </defs>

  <rect width="100%" height="100%" fill="url(#wall)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>

  <!-- menubar -->
  <rect x="0" y="0" width="${l.width}" height="${MENUBAR_H}" fill="#ffffff" fill-opacity="0.16"/>
  <text x="18" y="19" ${font} font-size="13" font-weight="700" fill="#fff"></text>
  <text x="38" y="19" ${font} font-size="13" font-weight="600" fill="#fff">reelscript</text>
  <text x="${l.width - 18}" y="19" ${font} font-size="13" fill="#fff" text-anchor="end">Tue Sep 23  9:41 AM</text>

  <!-- window shadow + body -->
  <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${RADIUS}" fill="#000" filter="url(#shadow)"/>
  <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" rx="${RADIUS}" fill="#ffffff"/>

  <!-- title bar -->
  <g clip-path="url(#win)">
    <rect x="${winX}" y="${winY}" width="${winW}" height="${TITLE_H}" fill="#f3f3f5"/>
    <rect x="${winX}" y="${winY + TITLE_H - 1}" width="${winW}" height="1" fill="#dcdce1"/>
  </g>
  <circle cx="${winX + 22}" cy="${winY + TITLE_H / 2}" r="6" fill="#ff5f57"/>
  <circle cx="${winX + 42}" cy="${winY + TITLE_H / 2}" r="6" fill="#febc2e"/>
  <circle cx="${winX + 62}" cy="${winY + TITLE_H / 2}" r="6" fill="#28c840"/>

  <!-- url pill -->
  <rect x="${urlX}" y="${urlY}" width="${urlW}" height="${TITLE_H - 24}" rx="7" fill="#e6e6ea"/>
  <text x="${urlX + urlW / 2}" y="${urlY + 16}" ${font} font-size="12.5" fill="#3f3f46" text-anchor="middle">${url}</text>
</svg>`;
  }

  private assets(state: SceneState) {
    const key = state.url;
    let p = this.bg.get(key);
    if (!p) {
      p = (async () => {
        const l = this.layout();
        const png = await sharp(Buffer.from(this.svg(state))).png().toBuffer();
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

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function createTheme(name: ThemeName, viewport: [number, number]): Theme {
  switch (name) {
    case "bare":
      return new BareTheme(viewport);
    case "macos":
      return new MacosTheme(viewport);
    default:
      throw new Error(`reelscript: unknown theme "${name as string}"`);
  }
}
