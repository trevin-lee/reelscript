/**
 * Keys that edit text do so through the platform: on a Mac, Chromium turns
 * Meta+A into "selectAll" and Alt+ArrowLeft into "moveWordLeft", and
 * Playwright sends those commands only when it runs on macOS. The desktop is
 * a Mac on every host, so reelscript sends them itself elsewhere, and a
 * shortcut does in a web page's field what it does on a Mac, in the
 * container as in a local preview.
 *
 * The table is Playwright's macEditingCommands (Apache-2.0), from Chromium's
 * and WebKit's Mac key bindings, without the commands that insert text
 * (typing does that).
 */
import type { CDPSession, Page } from "playwright";

export const MAC_EDITING_COMMANDS: Record<string, string[]> = {
  "Backspace": ["deleteBackward"],
  "Escape": ["cancelOperation"],
  "ArrowUp": ["moveUp"],
  "ArrowDown": ["moveDown"],
  "ArrowLeft": ["moveLeft"],
  "ArrowRight": ["moveRight"],
  "F5": ["complete"],
  "Delete": ["deleteForward"],
  "Home": ["scrollToBeginningOfDocument"],
  "End": ["scrollToEndOfDocument"],
  "PageUp": ["scrollPageUp"],
  "PageDown": ["scrollPageDown"],
  "Shift+Backspace": ["deleteBackward"],
  "Shift+Escape": ["cancelOperation"],
  "Shift+ArrowUp": ["moveUpAndModifySelection"],
  "Shift+ArrowDown": ["moveDownAndModifySelection"],
  "Shift+ArrowLeft": ["moveLeftAndModifySelection"],
  "Shift+ArrowRight": ["moveRightAndModifySelection"],
  "Shift+F5": ["complete"],
  "Shift+Delete": ["deleteForward"],
  "Shift+Home": ["moveToBeginningOfDocumentAndModifySelection"],
  "Shift+End": ["moveToEndOfDocumentAndModifySelection"],
  "Shift+PageUp": ["pageUpAndModifySelection"],
  "Shift+PageDown": ["pageDownAndModifySelection"],
  "Shift+Numpad5": ["delete"],
  "Control+Tab": ["selectNextKeyView"],
  "Control+KeyA": ["moveToBeginningOfParagraph"],
  "Control+KeyB": ["moveBackward"],
  "Control+KeyD": ["deleteForward"],
  "Control+KeyE": ["moveToEndOfParagraph"],
  "Control+KeyF": ["moveForward"],
  "Control+KeyH": ["deleteBackward"],
  "Control+KeyK": ["deleteToEndOfParagraph"],
  "Control+KeyL": ["centerSelectionInVisibleArea"],
  "Control+KeyN": ["moveDown"],
  "Control+KeyO": ["moveBackward"],
  "Control+KeyP": ["moveUp"],
  "Control+KeyT": ["transpose"],
  "Control+KeyV": ["pageDown"],
  "Control+KeyY": ["yank"],
  "Control+Backspace": ["deleteBackwardByDecomposingPreviousCharacter"],
  "Control+ArrowUp": ["scrollPageUp"],
  "Control+ArrowDown": ["scrollPageDown"],
  "Control+ArrowLeft": ["moveToLeftEndOfLine"],
  "Control+ArrowRight": ["moveToRightEndOfLine"],
  "Shift+Control+Tab": ["selectPreviousKeyView"],
  "Shift+Control+KeyA": ["moveToBeginningOfParagraphAndModifySelection"],
  "Shift+Control+KeyB": ["moveBackwardAndModifySelection"],
  "Shift+Control+KeyE": ["moveToEndOfParagraphAndModifySelection"],
  "Shift+Control+KeyF": ["moveForwardAndModifySelection"],
  "Shift+Control+KeyN": ["moveDownAndModifySelection"],
  "Shift+Control+KeyP": ["moveUpAndModifySelection"],
  "Shift+Control+KeyV": ["pageDownAndModifySelection"],
  "Shift+Control+Backspace": ["deleteBackwardByDecomposingPreviousCharacter"],
  "Shift+Control+ArrowUp": ["scrollPageUp"],
  "Shift+Control+ArrowDown": ["scrollPageDown"],
  "Shift+Control+ArrowLeft": ["moveToLeftEndOfLineAndModifySelection"],
  "Shift+Control+ArrowRight": ["moveToRightEndOfLineAndModifySelection"],
  "Alt+Backspace": ["deleteWordBackward"],
  "Alt+Escape": ["complete"],
  "Alt+ArrowUp": ["moveBackward","moveToBeginningOfParagraph"],
  "Alt+ArrowDown": ["moveForward","moveToEndOfParagraph"],
  "Alt+ArrowLeft": ["moveWordLeft"],
  "Alt+ArrowRight": ["moveWordRight"],
  "Alt+Delete": ["deleteWordForward"],
  "Alt+PageUp": ["pageUp"],
  "Alt+PageDown": ["pageDown"],
  "Shift+Alt+Backspace": ["deleteWordBackward"],
  "Shift+Alt+Escape": ["complete"],
  "Shift+Alt+ArrowUp": ["moveParagraphBackwardAndModifySelection"],
  "Shift+Alt+ArrowDown": ["moveParagraphForwardAndModifySelection"],
  "Shift+Alt+ArrowLeft": ["moveWordLeftAndModifySelection"],
  "Shift+Alt+ArrowRight": ["moveWordRightAndModifySelection"],
  "Shift+Alt+Delete": ["deleteWordForward"],
  "Shift+Alt+PageUp": ["pageUp"],
  "Shift+Alt+PageDown": ["pageDown"],
  "Control+Alt+KeyB": ["moveWordBackward"],
  "Control+Alt+KeyF": ["moveWordForward"],
  "Control+Alt+Backspace": ["deleteWordBackward"],
  "Shift+Control+Alt+KeyB": ["moveWordBackwardAndModifySelection"],
  "Shift+Control+Alt+KeyF": ["moveWordForwardAndModifySelection"],
  "Shift+Control+Alt+Backspace": ["deleteWordBackward"],
  "Meta+NumpadSubtract": ["cancel"],
  "Meta+Backspace": ["deleteToBeginningOfLine"],
  "Meta+ArrowUp": ["moveToBeginningOfDocument"],
  "Meta+ArrowDown": ["moveToEndOfDocument"],
  "Meta+ArrowLeft": ["moveToLeftEndOfLine"],
  "Meta+ArrowRight": ["moveToRightEndOfLine"],
  "Shift+Meta+NumpadSubtract": ["cancel"],
  "Shift+Meta+Backspace": ["deleteToBeginningOfLine"],
  "Shift+Meta+ArrowUp": ["moveToBeginningOfDocumentAndModifySelection"],
  "Shift+Meta+ArrowDown": ["moveToEndOfDocumentAndModifySelection"],
  "Shift+Meta+ArrowLeft": ["moveToLeftEndOfLineAndModifySelection"],
  "Shift+Meta+ArrowRight": ["moveToRightEndOfLineAndModifySelection"],
  "Meta+KeyA": ["selectAll"],
  "Meta+KeyC": ["copy"],
  "Meta+KeyX": ["cut"],
  "Meta+KeyV": ["paste"],
  "Meta+KeyZ": ["undo"],
  "Shift+Meta+KeyZ": ["redo"],
};

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
type Modifier = keyof typeof MODIFIER_BITS;
const NAMED_KEYS: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
};

export interface MacShortcut {
  modifiers: Modifier[];
  key: string;
  code: string;
  keyCode: number;
  commands: string[];
}

/** A chord like "Meta+Shift+ArrowLeft" as its modifiers, key, and what it does to text on a Mac; null if it doesn't edit text. */
export function macShortcut(chord: string): MacShortcut | null {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const modifiers = parts.filter((p): p is Modifier => p in MODIFIER_BITS);
  if (modifiers.length !== parts.length) return null;
  let code: string;
  let keyCode: number;
  if (/^[a-z]$/i.test(key)) [code, keyCode] = [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
  else if (/^[0-9]$/.test(key)) [code, keyCode] = [`Digit${key}`, key.charCodeAt(0)];
  else if (key in NAMED_KEYS) [code, keyCode] = [key, NAMED_KEYS[key]];
  else return null;
  const order: Modifier[] = ["Shift", "Control", "Alt", "Meta"];
  const commands = MAC_EDITING_COMMANDS[[...order.filter((m) => modifiers.includes(m)), code].join("+")];
  if (!commands) return null;
  const letter = /^[a-z]$/i.test(key) ? (modifiers.includes("Shift") ? key.toUpperCase() : key.toLowerCase()) : key;
  return { modifiers, key: letter, code, keyCode, commands };
}

/** Press a Mac editing shortcut with its commands, as Chromium on a Mac handles it. */
export async function pressMacShortcut(page: Page, cdp: CDPSession, s: MacShortcut): Promise<void> {
  for (const m of s.modifiers) await page.keyboard.down(m);
  const modifiers = s.modifiers.reduce((bits, m) => bits | MODIFIER_BITS[m], 0);
  const event = { modifiers, key: s.key, code: s.code, windowsVirtualKeyCode: s.keyCode, nativeVirtualKeyCode: s.keyCode };
  try {
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event, commands: s.commands });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  } finally {
    for (const m of [...s.modifiers].reverse()) await page.keyboard.up(m);
  }
}
