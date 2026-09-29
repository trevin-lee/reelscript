import type { Ease } from "./easing.js";
import type { BrowserContext, Page } from "playwright";

/** What demo.call(fn) receives. */
export interface CallContext {
  /** The focused window's page, if any window is open. */
  page?: Page;
  /** The browser context shared by browser and terminal windows. */
  context: BrowserContext;
}

/** A CSS selector, or an explicit point in page (viewport) coordinates. */
export type Target = string | { x: number; y: number };

export type Action =
  | { kind: "browser.goto"; url: string; hold?: number; /** @deprecated use hold */ settle?: number }
  | { kind: "browser.mockAPI"; pattern: string; response: unknown; status?: number }
  | { kind: "cursor.moveTo"; target: Target; ease?: Ease; duration?: number; window?: string }
  | { kind: "cursor.click"; button?: "left" | "right"; duration?: number }
  | { kind: "zoom.to"; target: Target; scale?: number; duration?: number; ease?: Ease; window?: string; within?: "window" }
  | { kind: "zoom.out"; duration?: number; ease?: Ease }
  | { kind: "type"; target?: string; text: string; wpm?: number; window?: string }
  | { kind: "press"; key: string }
  | { kind: "wait"; ms: number }
  | {
      kind: "scroll";
      /** Scroll until this element is in view (centered), or by / to a position on the page. */
      target?: string;
      by?: number;
      to?: number;
      duration?: number;
      ease?: Ease;
      window?: string;
    }
  | { kind: "waitFor"; target: string; window?: string; timeout?: number; settle?: number }
  | { kind: "say"; text: string; voice?: string; speed?: number }
  | { kind: "waitForNarration" }
  | { kind: "terminal.open"; title?: string; prompt?: string; fontSize?: number; lineHeight?: number; cols?: number; rows?: number; x?: number; y?: number; width?: number; height?: number }
  | {
      kind: "editor.open";
      /** Folder to open, relative to the script. */
      workspace?: string;
      /** Open VSX ids, .vsix paths, or extension folders, relative to the script. */
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
  | { kind: "window.close"; window: string }
  | { kind: "browser.open"; x?: number; y?: number; width?: number; height?: number }
  | { kind: "window.place"; window: string; x?: number; y?: number; width?: number; height?: number }
  | {
      kind: "terminal.run";
      command: string;
      /** Declared output. Omit to replay a recording made by `reelscript record`. */
      output?: string;
      /** Output as timed chunks, [ms, text], e.g. a recording made elsewhere. Played with `speed` and `maxGapMs`. */
      events?: [number, string][];
      /** Spread declared output over this many ms. */
      duration?: number;
      /** Typing speed for the command. */
      wpm?: number;
      /** Playback speed for recorded output. Default: 1 */
      speed?: number;
      /** Cap silences in recorded output, ms. Default: 700 */
      maxGap?: number;
      /** @deprecated Renamed to maxGap. */
      maxGapMs?: number;
      /** Show a new prompt after the output. Default: true */
      prompt?: boolean;
      /** Folder `reelscript record` runs the command in, relative to the script. Default: the script's folder */
      cwd?: string;
    }
  | { kind: "terminal.print"; text?: string; events?: [number, string][]; speed?: number; maxGap?: number; maxGapMs?: number; duration?: number; prompt?: boolean }
  | { kind: "call"; fn: (ctx: CallContext) => unknown };

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
