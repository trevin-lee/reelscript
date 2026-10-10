/**
 * Keyboard window: a keyboard, Mac or PC, with two hands over it, drawn in
 * 3D (Three.js in a Chromium page) and driven a frame at a time like every
 * other window. While it's open, every key a demo presses or types plays on
 * it: the keycap goes down, the finger that would press it does, and a
 * chord's label shows under the keys.
 *
 * This module is the part with no browser in it: the layouts, what a key
 * name or a typed character means on one, which finger presses what, and
 * the page that draws it all.
 */

export type KeyboardLayout = "mac" | "pc";
export const KEYBOARD_LAYOUTS: KeyboardLayout[] = ["mac", "pc"];

/** One keycap: where it is in key units (1u = one letter key's pitch), and what's printed on it. */
export interface KeyCap {
  id: string;
  /** Left edge and top edge, in units, from the keyboard's top left. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The main legend, and a smaller one above it (the shifted symbol on a number key). */
  legend: string;
  shifted?: string;
  /** A small name under a symbol, as Mac modifier keys have ("command" under ⌘). */
  sub?: string;
}

export interface Layout {
  name: KeyboardLayout;
  keys: KeyCap[];
  /** Overall size in units. */
  width: number;
  height: number;
}

const ROW_H = 1;
const FN_ROW_H = 0.62;

type Spec = [id: string, legend: string, w?: number, extra?: { shifted?: string; sub?: string; h?: number; y?: number }];

function row(y: number, h: number, specs: Spec[]): KeyCap[] {
  let x = 0;
  return specs.map(([id, legend, w = 1, extra = {}]) => {
    const cap: KeyCap = { id, x, y: y + (extra.y ?? 0), w, h: extra.h ?? h, legend };
    if (extra.shifted) cap.shifted = extra.shifted;
    if (extra.sub) cap.sub = extra.sub;
    x += w;
    return cap;
  });
}

const NUMBER_ROW: Spec[] = [
  ["Backquote", "`", 1, { shifted: "~" }],
  ["1", "1", 1, { shifted: "!" }],
  ["2", "2", 1, { shifted: "@" }],
  ["3", "3", 1, { shifted: "#" }],
  ["4", "4", 1, { shifted: "$" }],
  ["5", "5", 1, { shifted: "%" }],
  ["6", "6", 1, { shifted: "^" }],
  ["7", "7", 1, { shifted: "&" }],
  ["8", "8", 1, { shifted: "*" }],
  ["9", "9", 1, { shifted: "(" }],
  ["0", "0", 1, { shifted: ")" }],
  ["Minus", "-", 1, { shifted: "_" }],
  ["Equal", "=", 1, { shifted: "+" }],
];
const TOP_ROW: Spec[] = [
  ...["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"].map((k): Spec => [k, k.toUpperCase()]),
  ["BracketLeft", "[", 1, { shifted: "{" }],
  ["BracketRight", "]", 1, { shifted: "}" }],
  ["Backslash", "\\", 1, { shifted: "|" }],
];
const HOME_ROW: Spec[] = [
  ...["a", "s", "d", "f", "g", "h", "j", "k", "l"].map((k): Spec => [k, k.toUpperCase()]),
  ["Semicolon", ";", 1, { shifted: ":" }],
  ["Quote", "'", 1, { shifted: '"' }],
];
const BOTTOM_ROW: Spec[] = [
  ...["z", "x", "c", "v", "b", "n", "m"].map((k): Spec => [k, k.toUpperCase()]),
  ["Comma", ",", 1, { shifted: "<" }],
  ["Period", ".", 1, { shifted: ">" }],
  ["Slash", "/", 1, { shifted: "?" }],
];
const FKEYS: Spec[] = Array.from({ length: 12 }, (_, i): Spec => [`F${i + 1}`, `F${i + 1}`]);

/** The arrow cluster: left and right full height, up and down stacked in one key's space. */
function arrows(x: number, y: number): KeyCap[] {
  return [
    { id: "ArrowLeft", x, y: y + 0.5, w: 1, h: 0.5, legend: "◀" },
    { id: "ArrowUp", x: x + 1, y, w: 1, h: 0.5, legend: "▲" },
    { id: "ArrowDown", x: x + 1, y: y + 0.5, w: 1, h: 0.5, legend: "▼" },
    { id: "ArrowRight", x: x + 2, y: y + 0.5, w: 1, h: 0.5, legend: "▶" },
  ];
}

function build(name: KeyboardLayout): Layout {
  const mac = name === "mac";
  const keys: KeyCap[] = [];
  let y = 0;
  keys.push(...row(y, FN_ROW_H, [["Escape", "esc", 1.5], ...FKEYS, mac ? ["TouchId", "", 1] : ["Delete", "Del", 1]]));
  y += FN_ROW_H;
  keys.push(...row(y, ROW_H, [...NUMBER_ROW, ["Backspace", mac ? "delete" : "Backspace", 1.5]]));
  y += ROW_H;
  keys.push(...row(y, ROW_H, [["Tab", mac ? "tab" : "Tab", 1.5], ...TOP_ROW]));
  y += ROW_H;
  keys.push(...row(y, ROW_H, [["CapsLock", mac ? "caps lock" : "Caps Lock", 1.75], ...HOME_ROW, ["Enter", mac ? "return" : "Enter", 1.75]]));
  y += ROW_H;
  keys.push(...row(y, ROW_H, [["ShiftLeft", mac ? "shift" : "Shift", 2.25], ...BOTTOM_ROW, ["ShiftRight", mac ? "shift" : "Shift", 2.25]]));
  y += ROW_H;
  const bottom: Spec[] = mac
    ? [
        ["Fn", "fn", 1, { sub: "🌐" }],
        ["ControlLeft", "⌃", 1, { sub: "control" }],
        ["AltLeft", "⌥", 1, { sub: "option" }],
        ["MetaLeft", "⌘", 1.25, { sub: "command" }],
        ["Space", "", 5],
        ["MetaRight", "⌘", 1.25, { sub: "command" }],
        ["AltRight", "⌥", 1, { sub: "option" }],
      ]
    : [
        ["ControlLeft", "Ctrl", 1.25],
        ["Fn", "Fn", 1],
        ["MetaLeft", "⊞", 1.25],
        ["AltLeft", "Alt", 1.25],
        ["Space", "", 4.75],
        ["AltRight", "Alt", 1],
        ["ControlRight", "Ctrl", 1],
      ];
  const bottomKeys = row(y, ROW_H, bottom);
  keys.push(...bottomKeys);
  const after = bottomKeys[bottomKeys.length - 1];
  keys.push(...arrows(after.x + after.w, y));
  return { name, keys, width: 14.5, height: y + ROW_H };
}

const LAYOUTS: Record<KeyboardLayout, Layout> = { mac: build("mac"), pc: build("pc") };

export function layout(name: KeyboardLayout): Layout {
  return LAYOUTS[name];
}

// ---------------------------------------------------------------- what a key name means

/** Characters that need Shift on a US keyboard, by the key that gives them. */
const SHIFTED: Record<string, string> = {
  "~": "Backquote", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "Minus", "+": "Equal", "{": "BracketLeft", "}": "BracketRight", "|": "Backslash", ":": "Semicolon", '"': "Quote",
  "<": "Comma", ">": "Period", "?": "Slash",
};
/** Unshifted punctuation, by character. */
const PLAIN: Record<string, string> = {
  "`": "Backquote", "-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash",
  ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period", "/": "Slash", " ": "Space", "\n": "Enter", "\t": "Tab",
};
/** Playwright key names and codes that aren't the key's own id here. */
const ALIASES: Record<string, string> = {
  Esc: "Escape", Return: "Enter", Del: "Delete", Spacebar: "Space", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight",
  Backquote: "Backquote", Shift: "ShiftLeft", Control: "ControlLeft", Alt: "AltLeft", Meta: "MetaLeft", ControlOrMeta: "MetaLeft",
};

export interface KeyPress {
  id: string;
  /** Held through the main key's press: a modifier. */
  modifier: boolean;
}

export interface Chord {
  keys: KeyPress[];
  /** The chord as shown under the keyboard: "⌘ ⇧ P", or "Ctrl + Shift + P". */
  label: string;
}

/** The key a Playwright key name or code means, or null for one no layout has. */
function keyId(name: string): string | null {
  if (name in ALIASES) return ALIASES[name];
  if (/^Key[A-Z]$/.test(name)) return name[3].toLowerCase();
  if (/^Digit[0-9]$/.test(name)) return name[5];
  if (/^[a-zA-Z]$/.test(name)) return name.toLowerCase();
  if (/^[0-9]$/.test(name)) return name;
  if (name in PLAIN) return PLAIN[name];
  return name;
}

/**
 * What `press("Meta+Shift+P")` presses, on a layout: the modifiers held and
 * the key, each as the key it is there. A bare capital letter or a shifted
 * symbol ("A", "!") is Shift and the key, as Playwright types it. Returns
 * the name of a key the layout doesn't have instead.
 */
export function resolveChord(chord: string, lay: Layout): Chord | { missing: string } {
  const parts = chord.split("+");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.splice(-2, 2, "+"); // "Shift++" presses +
  const main = parts.pop()!;
  const mods = new Set<string>();
  for (const p of parts) {
    const id = ALIASES[p];
    if (!id || !/^(Shift|Control|Alt|Meta)Left$/.test(id)) return { missing: p };
    mods.add(id);
  }
  let mainId: string | null;
  if (main.length === 1 && main in SHIFTED) {
    mods.add("ShiftLeft");
    mainId = SHIFTED[main];
  } else if (/^[A-Z]$/.test(main) && parts.length === 0) {
    mods.add("ShiftLeft");
    mainId = main.toLowerCase();
  } else {
    mainId = keyId(main);
  }
  if (!mainId || !lay.keys.some((k) => k.id === mainId)) return { missing: main };
  const order = ["ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft"];
  const keys: KeyPress[] = [...mods].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((id) => ({ id, modifier: true }));
  keys.push({ id: mainId, modifier: false });
  return { keys, label: chordLabel(keys, lay) };
}

/** What typing one character presses: the key, with Shift for a capital or a shifted symbol; null for one the layout can't type. */
export function resolveChar(ch: string, lay: Layout): KeyPress[] | null {
  let id: string | undefined;
  let shift = false;
  if (ch in SHIFTED) {
    id = SHIFTED[ch];
    shift = true;
  } else if (/^[A-Z]$/.test(ch)) {
    id = ch.toLowerCase();
    shift = true;
  } else if (/^[a-z0-9]$/.test(ch)) id = ch;
  else if (ch in PLAIN) id = PLAIN[ch];
  if (!id || !lay.keys.some((k) => k.id === id)) return null;
  const keys: KeyPress[] = shift ? [{ id: "ShiftLeft", modifier: true }] : [];
  keys.push({ id, modifier: false });
  return keys;
}

const MAC_SYMBOLS: Record<string, string> = { ControlLeft: "⌃", AltLeft: "⌥", ShiftLeft: "⇧", MetaLeft: "⌘" };
const PC_NAMES: Record<string, string> = { ControlLeft: "Ctrl", AltLeft: "Alt", ShiftLeft: "Shift", MetaLeft: "Win" };
/** How a Mac writes a key in a shortcut; a PC writes its name. */
const MAC_KEY_SYMBOLS: Record<string, string> = {
  Enter: "↩", Escape: "esc", Backspace: "⌫", Delete: "⌦", Tab: "⇥", Space: "space", CapsLock: "caps lock",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
};
const PC_KEY_NAMES: Record<string, string> = { Escape: "Esc", Space: "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };

/** A chord as a viewer reads it: Mac symbols ("⇧ ⌘ P"), or PC names joined with + ("Ctrl + Shift + P"). */
export function chordLabel(keys: KeyPress[], lay: Layout): string {
  const mac = lay.name === "mac";
  const parts = keys.map(({ id, modifier }) => {
    if (modifier) return mac ? MAC_SYMBOLS[id] : PC_NAMES[id];
    if (mac && id in MAC_KEY_SYMBOLS) return MAC_KEY_SYMBOLS[id];
    if (!mac && id in PC_KEY_NAMES) return PC_KEY_NAMES[id];
    const cap = lay.keys.find((k) => k.id === id);
    return cap && cap.legend ? cap.legend : id;
  });
  return mac ? parts.join(" ") : parts.join(" + ");
}

// ---------------------------------------------------------------- which finger

export type Hand = "left" | "right";
/** 0 is the thumb, 4 the little finger. */
export type Finger = 0 | 1 | 2 | 3 | 4;

const ZONES: Record<string, [Hand, Finger]> = {};
const zone = (hand: Hand, finger: Finger, ids: string[]) => ids.forEach((id) => (ZONES[id] = [hand, finger]));
zone("left", 4, ["Backquote", "1", "q", "a", "z", "Escape", "F1", "Tab", "CapsLock", "ShiftLeft", "Fn", "ControlLeft"]);
zone("left", 3, ["2", "w", "s", "x", "F2"]);
zone("left", 2, ["3", "e", "d", "c", "F3"]);
zone("left", 1, ["4", "5", "r", "t", "f", "g", "v", "b", "F4", "F5"]);
zone("left", 0, ["MetaLeft", "AltLeft", "Space"]);
zone("right", 0, ["MetaRight", "AltRight"]);
zone("right", 1, ["6", "7", "y", "u", "h", "j", "n", "m", "F6", "F7", "ArrowLeft"]);
zone("right", 2, ["8", "i", "k", "Comma", "F8", "ArrowUp", "ArrowDown"]);
zone("right", 3, ["9", "o", "l", "Period", "F9", "ArrowRight"]);
zone("right", 4, ["0", "Minus", "Equal", "p", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Slash", "Enter", "Backspace", "Delete", "ShiftRight", "ControlRight", "TouchId", "F10", "F11", "F12"]);

/** The hand and finger that press a key when touch typing. */
export function fingerFor(id: string): [Hand, Finger] {
  return ZONES[id] ?? ["right", 1];
}

export interface Pressed {
  id: string;
  hand: Hand;
  finger: Finger;
  modifier: boolean;
}

/**
 * Which hand and finger take each key of a chord. A modifier goes to the
 * hand that isn't pressing the main key where it can (Shift's other side,
 * the other ⌘), so each hand has one place to be; a third key lands on a
 * hand that's already busy, with its thumb or little finger reaching.
 */
export function assignFingers(keys: KeyPress[], lay: Layout): Pressed[] {
  const main = keys.find((k) => !k.modifier) ?? keys[keys.length - 1];
  const [mainHand, mainFinger] = fingerFor(main.id);
  const has = (id: string) => lay.keys.some((k) => k.id === id);
  const taken = new Set<string>([`${mainHand}${mainFinger}`]);
  const out: Pressed[] = [];
  for (const k of keys) {
    if (!k.modifier) continue;
    let id = k.id;
    // Shift: the little finger of the other hand. ⌘ and ⌥: a thumb, the other hand's if the main key is on this one.
    if (id === "ShiftLeft") id = mainHand === "left" && has("ShiftRight") ? "ShiftRight" : "ShiftLeft";
    if (id === "MetaLeft" && mainHand === "left" && has("MetaRight")) id = "MetaRight";
    if (id === "AltLeft" && mainHand === "left" && has("AltRight") && !taken.has("right0")) id = "AltRight";
    if (id === "ControlLeft" && mainHand === "left" && has("ControlRight")) id = "ControlRight";
    let [hand, finger] = fingerFor(id);
    if (taken.has(`${hand}${finger}`)) {
      // Both thumbs wanted (⌘⌥ with a key on the right): the second goes to the little finger's side's neighbour.
      const other: Hand = hand === "left" ? "right" : "left";
      const swap = id.replace(/Left$/, "Right").replace(/^(\w+)Right$/, (m) => m) === id ? id.replace(/Right$/, "Left") : id.replace(/Left$/, "Right");
      if (has(swap) && !taken.has(`${other}${fingerFor(swap)[1]}`)) {
        id = swap;
        [hand, finger] = fingerFor(swap);
      }
    }
    taken.add(`${hand}${finger}`);
    out.push({ id, hand, finger, modifier: true });
  }
  out.push({ id: main.id, hand: mainHand, finger: mainFinger, modifier: false });
  return out;
}
