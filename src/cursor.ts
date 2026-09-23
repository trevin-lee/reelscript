import sharp from "sharp";

/**
 * Cursor + click-feedback sprites, rasterized from SVG and cached by size.
 * Coordinates: the sprite's hotspot (arrow tip) is at (hx, hy).
 */

export interface Sprite {
  data: Buffer; // PNG
  width: number;
  height: number;
  hx: number;
  hy: number;
}

const ARROW_VIEW = { w: 20, h: 26 };

function arrowSvg(px: number): string {
  const s = px / ARROW_VIEW.h;
  const w = Math.ceil(ARROW_VIEW.w * s);
  const h = Math.ceil(ARROW_VIEW.h * s);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${ARROW_VIEW.w} ${ARROW_VIEW.h}">
  <defs>
    <filter id="sh" x="-30%" y="-30%" width="180%" height="180%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="0.9"/>
      <feOffset dx="0.4" dy="1.1" result="b"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.45"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <path filter="url(#sh)" d="M1.5 1.5 L1.5 20.5 L6.2 16 L9.8 23.6 L13.2 22.1 L9.6 14.6 L16.5 14.6 Z"
        fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
</svg>`;
}

const cache = new Map<string, Promise<Sprite>>();

export function cursorSprite(heightPx: number): Promise<Sprite> {
  const px = Math.max(8, Math.round(heightPx));
  const key = `arrow:${px}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const svg = arrowSvg(px);
      const { data, info } = await sharp(Buffer.from(svg)).png().toBuffer({ resolveWithObject: true });
      const s = px / ARROW_VIEW.h;
      return { data, width: info.width, height: info.height, hx: 1.5 * s, hy: 1.5 * s };
    })();
    cache.set(key, p);
  }
  return p;
}

/** Translucent ring that expands from the click point. */
export function rippleSprite(radius: number, opacity: number): Promise<Sprite> {
  const r = Math.max(2, Math.round(radius));
  const o = Math.round(opacity * 20) / 20;
  const key = `ripple:${r}:${o}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const d = r * 2 + 4;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}">
        <circle cx="${d / 2}" cy="${d / 2}" r="${r}" fill="#3b82f6" fill-opacity="${o * 0.35}"
                stroke="#3b82f6" stroke-opacity="${o}" stroke-width="2"/>
      </svg>`;
      const { data, info } = await sharp(Buffer.from(svg)).png().toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height, hx: d / 2, hy: d / 2 };
    })();
    cache.set(key, p);
  }
  return p;
}
