import type { Ease } from "./easing.js";

/** A CSS selector, or an explicit point in page (viewport) coordinates. */
export type Target = string | { x: number; y: number };

export type Action =
  | { kind: "browser.goto"; url: string; settle?: number }
  | { kind: "browser.mockAPI"; pattern: string; response: unknown; status?: number }
  | { kind: "cursor.moveTo"; target: Target; ease?: Ease; duration?: number }
  | { kind: "cursor.click"; button?: "left" | "right" }
  | { kind: "zoom.to"; target: Target; scale?: number; duration?: number; ease?: Ease }
  | { kind: "zoom.out"; duration?: number; ease?: Ease }
  | { kind: "type"; target?: string; text: string; wpm?: number }
  | { kind: "press"; key: string }
  | { kind: "wait"; ms: number };

export type ActionKind = Action["kind"];

export const DEFAULTS = {
  fps: 60,
  viewport: [1280, 800] as [number, number],
  /** ms the page is shown after a goto before the next action */
  gotoSettle: 400,
  clickDuration: 180,
  typeWpm: 300,
  zoomScale: 1.6,
  zoomDuration: 700,
  /** frames appended after the last action so the ending doesn't feel clipped */
  tailMs: 500,
};
