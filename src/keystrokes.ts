/**
 * The keystroke overlay: a pill near the bottom of the frame naming each
 * shortcut as it's pressed ("⇧ ⌘ P"), drawn over the finished frame, so a
 * zoom, the follow camera or a desk view never moves or crops it. Which
 * presses it shows, how a chord reads, and its HTML live here; the renderer
 * notes the presses and draws the pill.
 */
import { chordParts, resolveChord, type Layout } from "./keyboard.js";

export type KeystrokePosition = "bottom" | "bottom-left" | "bottom-right" | "top" | { x: number; y: number };

export interface KeystrokeOptions {
  /**
   * Which presses show: "chords" (a key with ⌘, Ctrl or ⌥, or a key such as
   * Enter, Escape, Tab, an arrow or an F key), or "all" (every press()).
   * Typing never shows: the text is on screen already. Default: "chords"
   */
  show?: "chords" | "all";
  /**
   * Where the pill sits: "bottom", "bottom-left", "bottom-right", "top", or
   * { x, y }, its centre in the video's pixels. Default: "bottom"
   */
  position?: KeystrokePosition;
  /** How long each stays up after its key goes down, ms. Default: 1000 */
  hold?: number;
  /** CSS added after the defaults, to restyle it: `.keystrokes` is the pill, `.key` each key in it. */
  css?: string;
}

export const KEYSTROKE_DEFAULTS = { show: "chords" as const, position: "bottom" as KeystrokePosition, hold: 1000, css: "" };
export const KEYSTROKE_POSITIONS = ["bottom", "bottom-left", "bottom-right", "top"];

/** A shortcut pressed at `at`, its keys as the viewer reads them. */
export interface Keystroke {
  at: number;
  keys: string[];
}

const SPECIAL = /^(Enter|Escape|Tab|Backspace|Delete|Insert|Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End|F\d{1,2})$/;

/** A chord's parts: its modifiers and its key ("Shift++" is Shift and +). */
function split(chord: string): { mods: string[]; key: string } {
  const parts = chord.split("+");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.splice(-2, 2, "+");
  const key = parts.pop()!;
  return { mods: parts, key };
}

/** Whether a press shows, given the overlay's `show`: a shortcut, rather than a key that only types. */
export function showsAsKeystroke(chord: string, show: "chords" | "all"): boolean {
  if (show === "all") return true;
  const { mods, key } = split(chord);
  return mods.some((m) => m !== "Shift") || SPECIAL.test(key);
}

/** How a viewer reads a chord on the laptop's keyboard; a key the laptop hasn't got is named as the script names it. */
export function keystrokeKeys(chord: string, lay: Layout): string[] {
  const resolved = resolveChord(chord, lay);
  if (!("missing" in resolved)) return chordParts(resolved.keys, lay);
  const mac = lay.name === "mac";
  const names: Record<string, string> = mac
    ? { Meta: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧", ControlOrMeta: "⌘" }
    : { Meta: "Win", Control: "Ctrl", Alt: "Alt", Shift: "Shift", ControlOrMeta: "Ctrl" };
  const { mods, key } = split(chord);
  return [...mods.map((m) => names[m] ?? m), key];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** The pill, as a page: sized to the video, centred in a strip `height` tall, its background see-through. */
export function keystrokeHtml(keys: string[], videoHeight: number, fontFace: string, css: string): { html: string; height: number } {
  const size = Math.round(Math.min(40, Math.max(16, videoHeight * 0.03)));
  const height = size * 5;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace}
html, body { margin: 0; height: ${height}px; background: transparent; overflow: hidden; }
body { display: flex; align-items: center; justify-content: center; font-family: Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; }
.keystrokes { display: flex; gap: ${Math.round(size * 0.32)}px; padding: ${Math.round(size * 0.42)}px; border-radius: ${Math.round(size * 0.7)}px;
  background: rgba(22, 22, 26, 0.86); box-shadow: 0 ${Math.round(size * 0.3)}px ${Math.round(size * 0.9)}px rgba(0, 0, 0, 0.28); }
.key { min-width: ${Math.round(size * 1.1)}px; padding: ${Math.round(size * 0.22)}px ${Math.round(size * 0.42)}px; box-sizing: border-box;
  border-radius: ${Math.round(size * 0.36)}px; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.16);
  color: #fff; font-size: ${size}px; font-weight: 600; line-height: 1.2; text-align: center; }
${css}
</style></head><body><div class="keystrokes">${keys.map((k) => `<div class="key">${escapeHtml(k)}</div>`).join("")}</div></body></html>`;
  return { html, height };
}

/** The pill's top-left corner in the video, for its size, the video's, and `position`. */
export function keystrokePlace(position: KeystrokePosition, w: number, h: number, W: number, H: number): { left: number; top: number } {
  const margin = Math.round(H * 0.05);
  if (typeof position === "object") return { left: Math.round(position.x - w / 2), top: Math.round(position.y - h / 2) };
  const top = position === "top" ? margin : H - margin - h;
  const left = position === "bottom-left" ? margin : position === "bottom-right" ? W - margin - w : Math.round((W - w) / 2);
  return { left, top };
}

/** How visible a keystroke is at `t`: fading in as its keys go down, held, fading out; 0 once the next one shows. */
export function keystrokeOpacity(strokes: Keystroke[], hold: number, t: number): { stroke: Keystroke; opacity: number } | null {
  const FADE_IN = 90, FADE_OUT = 220;
  let current: Keystroke | null = null;
  for (const s of strokes) if (s.at - FADE_IN <= t) current = s;
  if (!current) return null;
  const end = current.at + hold;
  if (t > end + FADE_OUT) return null;
  const opacity = t < current.at ? (t - (current.at - FADE_IN)) / FADE_IN : t > end ? 1 - (t - end) / FADE_OUT : 1;
  return { stroke: current, opacity: Math.max(0, Math.min(1, opacity)) };
}
