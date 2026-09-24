import type { Ease } from "./easing.js";

/** A CSS selector, or an explicit point in page (viewport) coordinates. */
export type Target = string | { x: number; y: number };

export type Action =
  | { kind: "browser.goto"; url: string; settle?: number }
  | { kind: "browser.mockAPI"; pattern: string; response: unknown; status?: number }
  | { kind: "cursor.moveTo"; target: Target; ease?: Ease; duration?: number; window?: string }
  | { kind: "cursor.click"; button?: "left" | "right" }
  | { kind: "zoom.to"; target: Target; scale?: number; duration?: number; ease?: Ease; window?: string }
  | { kind: "zoom.out"; duration?: number; ease?: Ease }
  | { kind: "type"; target?: string; text: string; wpm?: number }
  | { kind: "press"; key: string }
  | { kind: "wait"; ms: number }
  | { kind: "say"; text: string; voice?: string; speed?: number }
  | { kind: "waitForNarration" }
  | { kind: "terminal.open"; title?: string; prompt?: string; fontSize?: number; x?: number; y?: number; width?: number; height?: number }
  | {
      kind: "editor.open";
      /** Folder to open, relative to the script. */
      workspace?: string;
      /** Extension ids (Open VSX) or .vsix paths. */
      extensions?: string[];
      settings?: Record<string, unknown>;
      /** Show VS Code notification toasts. Default: false */
      notifications?: boolean;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }
  | { kind: "editor.openFile"; path: string; wpm?: number }
  | { kind: "editor.command"; command: string; wpm?: number }
  | { kind: "window.focus"; window: string }
  | { kind: "window.place"; window: string; x?: number; y?: number; width?: number; height?: number }
  | {
      kind: "terminal.run";
      command: string;
      /** Declared output. Omit to replay a recording made by `reelscript record`. */
      output?: string;
      /** Spread declared output over this many ms. */
      duration?: number;
      /** Typing speed for the command. */
      wpm?: number;
      /** Playback speed for recorded output. Default: 1 */
      speed?: number;
      /** Cap silences in recorded output, ms. Default: 700 */
      maxGapMs?: number;
    };

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
  /** silence between consecutive narration clips */
  narrationGapMs: 300,
  terminalPrompt: "~ % ",
  terminalTitle: "zsh",
};
