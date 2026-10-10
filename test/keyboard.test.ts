import { test } from "node:test";
import assert from "node:assert/strict";
import { assignFingers, chordLabel, fingerFor, layout, resolveChar, resolveChord } from "../src/keyboard.js";

const mac = layout("mac");
const pc = layout("pc");

test("both layouts are complete keyboards: 14.5 units wide, every id once, the keys a script presses all there", () => {
  for (const lay of [mac, pc]) {
    assert.equal(lay.width, 14.5);
    const ids = lay.keys.map((k) => k.id);
    assert.equal(new Set(ids).size, ids.length, `${lay.name}: no key twice`);
    // The full-height rows each span the width; the bottom row does with its arrow cluster.
    for (const row of new Set(lay.keys.filter((k) => k.y < 4).map((k) => k.y))) {
      const span = lay.keys.filter((k) => k.y === row).reduce((w, k) => w + k.w, 0);
      assert.ok(Math.abs(span - 14.5) < 1e-9, `${lay.name}: row at ${row} spans ${span}`);
    }
    assert.equal(Math.max(...lay.keys.filter((k) => k.y >= 4).map((k) => k.x + k.w)), 14.5);
    for (const id of ["a", "z", "0", "Enter", "Space", "Escape", "F1", "F12", "ArrowUp", "ArrowRight", "ShiftLeft", "ShiftRight", "MetaLeft", "AltLeft", "ControlLeft", "Tab", "Backspace", "Backslash"]) {
      assert.ok(ids.includes(id), `${lay.name} has ${id}`);
    }
  }
  assert.ok(mac.keys.some((k) => k.id === "MetaRight") && !pc.keys.some((k) => k.id === "MetaRight"), "a Mac has two ⌘ keys, a PC one");
  assert.ok(pc.keys.some((k) => k.id === "ControlRight") && !mac.keys.some((k) => k.id === "ControlRight"));
  assert.equal(mac.keys.find((k) => k.id === "Enter")!.legend, "return");
  assert.equal(pc.keys.find((k) => k.id === "Backspace")!.legend, "Backspace");
});

function chord(c: string, lay = mac): { ids: string[]; label: string } | { missing: string } {
  const r = resolveChord(c, lay);
  if ("missing" in r) return r;
  return { ids: r.keys.map((k) => `${k.modifier ? "+" : ""}${k.id}`), label: r.label };
}

test("a Playwright key name or chord resolves to its keys, with modifiers held, or names what the layout hasn't got", () => {
  assert.deepEqual(chord("Meta+Shift+P"), { ids: ["+ShiftLeft", "+MetaLeft", "p"], label: "⇧ ⌘ P" });
  assert.deepEqual(chord("Control+Alt+Delete", pc), { ids: ["+ControlLeft", "+AltLeft", "Delete"], label: "Ctrl + Alt + Del" });
  assert.deepEqual(chord("Meta+K"), { ids: ["+MetaLeft", "k"], label: "⌘ K" });
  assert.deepEqual(chord("ControlOrMeta+S"), { ids: ["+MetaLeft", "s"], label: "⌘ S" });
  assert.deepEqual(chord("Enter"), { ids: ["Enter"], label: "↩" });
  assert.deepEqual(chord("Enter", pc), { ids: ["Enter"], label: "Enter" });
  assert.deepEqual(chord("ArrowDown"), { ids: ["ArrowDown"], label: "↓" });
  assert.deepEqual(chord("Escape"), { ids: ["Escape"], label: "esc" });
  assert.deepEqual(chord("Escape", pc), { ids: ["Escape"], label: "Esc" });
  assert.deepEqual(chord("Control+ArrowLeft", pc).label, "Ctrl + Left");
  assert.deepEqual(chord("F1"), { ids: ["F1"], label: "F1" });
  assert.deepEqual(chord("KeyA"), { ids: ["a"], label: "A" });
  assert.deepEqual(chord("Digit5"), { ids: ["5"], label: "5" });
  assert.deepEqual(chord("/"), { ids: ["Slash"], label: "/" });
  assert.deepEqual(chord("A"), { ids: ["+ShiftLeft", "a"], label: "⇧ A" }, "a bare capital is Shift and the key, as Playwright types it");
  assert.deepEqual(chord("!"), { ids: ["+ShiftLeft", "1"], label: "⇧ 1" });
  assert.deepEqual(chord("Shift++"), { ids: ["+ShiftLeft", "Equal"], label: "⇧ =" });
  assert.deepEqual(chord("Meta+F13"), { missing: "F13" });
  assert.deepEqual(chord("Hyper+K"), { missing: "Hyper" });
  assert.deepEqual(chord("Meta+Delete", mac), { missing: "Delete" }, "a Mac's delete key is Backspace");
  const all = resolveChord("Control+Shift+Alt+Meta+K", mac);
  assert.ok(!("missing" in all));
  assert.equal(all.label, "⌃ ⌥ ⇧ ⌘ K", "modifiers in Apple's order");
  assert.equal(chordLabel(all.keys, pc), "Ctrl + Alt + Shift + Win + K");
});

test("typed characters resolve to keys, shifted where a US keyboard shifts them; others are null", () => {
  const ids = (ch: string) => resolveChar(ch, mac)?.map((k) => `${k.modifier ? "+" : ""}${k.id}`) ?? null;
  assert.deepEqual(ids("h"), ["h"]);
  assert.deepEqual(ids("H"), ["+ShiftLeft", "h"]);
  assert.deepEqual(ids("!"), ["+ShiftLeft", "1"]);
  assert.deepEqual(ids(" "), ["Space"]);
  assert.deepEqual(ids("\n"), ["Enter"]);
  assert.deepEqual(ids("'"), ["Quote"]);
  assert.deepEqual(ids("é"), null);
  assert.deepEqual(ids("🙂"), null);
});

test("touch typing: each key has a hand and finger, and a chord's keys are spread so each hand has one place to be", () => {
  assert.deepEqual(fingerFor("f"), ["left", 1]);
  assert.deepEqual(fingerFor("j"), ["right", 1]);
  assert.deepEqual(fingerFor("a"), ["left", 4]);
  assert.deepEqual(fingerFor("p"), ["right", 4]);
  assert.deepEqual(fingerFor("Space"), ["left", 0]);
  const spread = (c: string, lay = mac) => {
    const r = resolveChord(c, lay);
    if ("missing" in r) throw new Error(c);
    return assignFingers(r.keys, lay).map((k) => `${k.hand[0]}${k.finger}:${k.id}`);
  };
  // Shift takes the other hand's little finger; ⌘ the other hand's thumb when the key is on the left.
  assert.deepEqual(spread("Meta+Shift+P"), ["l4:ShiftLeft", "l0:MetaLeft", "r4:p"]);
  assert.deepEqual(spread("Shift+A"), ["r4:ShiftRight", "l4:a"]);
  assert.deepEqual(spread("Meta+A"), ["r0:MetaRight", "l4:a"]);
  assert.deepEqual(spread("Meta+Shift+A"), ["r4:ShiftRight", "r0:MetaRight", "l4:a"]);
  // A PC has one Win key, so it stays with the left thumb even for a left-hand key.
  assert.deepEqual(spread("Meta+A", pc), ["l0:MetaLeft", "l4:a"]);
  assert.deepEqual(spread("Control+C", pc), ["r4:ControlRight", "l2:c"]);
});
