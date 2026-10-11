import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { DESK_DEFAULTS, DESK_URL, deskAsset, deskPageHtml } from "../src/desk.js";
import { assignFingers, layout, resolveChar, resolveChord } from "../src/keyboard.js";

// The hands on the keyboard, driven through the desk page itself: where each fingertip is, frame by frame.

async function deskPage(laptop: "mac" | "pc"): Promise<{ page: Page; close: () => Promise<void> }> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  await page.addInitScript("window.__name = (f) => f"); // tsx names the functions it compiles into evaluate()'s source
  await page.route(`${DESK_URL}**`, (route) => {
    const asset = deskAsset(new URL(route.request().url()).pathname);
    if (asset) return route.fulfill({ status: 200, contentType: asset.contentType, body: asset.body });
    return route.fulfill({ status: 200, contentType: "text/html", body: deskPageHtml({ ...DESK_DEFAULTS, laptop, labels: true, aspect: 1.5 }) });
  });
  await page.goto(DESK_URL);
  await page.waitForFunction(() => "__rsDesk" in window);
  await page.evaluate(() => (window as any).__rsDesk.ready);
  return { page, close: () => browser.close() };
}

type Tips = Record<"left" | "right", { root: number[]; tips: number[][] }>;
/** Poses the hands at each time (with no new events) and returns every hand's position and fingertips. */
function posesAt(page: Page, times: number[]): Promise<Tips[]> {
  return page.evaluate((times) => {
    const { hands, THREE } = (window as any).__rsDesk._debug;
    return times.map((t) => {
      (window as any).__rsDesk.render(t, [], { to: "keyboard" });
      const out: any = {};
      for (const h of Object.values(hands) as any[]) {
        h.root.updateMatrixWorld(true);
        out[h.side] = {
          root: h.root.position.toArray(),
          tips: h.chains.map((c: any) => c.joints[c.joints.length - 1].bone.getWorldPosition(new THREE.Vector3()).toArray()),
        };
      }
      return out;
    });
  }, times);
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test("hands: every key of a chord has its finger on it, on both laptops, thumbs on ⌘ and the space bar included", { timeout: 300_000 }, async () => {
  for (const laptop of ["mac", "pc"] as const) {
    const lay = layout(laptop);
    const { page, close } = await deskPage(laptop);
    try {
      const chords = ["Meta+Shift+P", "Meta+K", "Meta+Q", "Control+C", "Control+Shift+P", "Alt+Tab", "Meta+Backspace", "Escape", "Meta+Space", "Control+Space", "Shift+Tab", "Meta+ArrowUp", "Alt+F4"];
      let base = 0;
      for (const chord of chords) {
        base += 5000; // far enough apart that each chord is the hands' only event
        const keys = assignFingers((resolveChord(chord, lay) as any).keys, lay);
        const misses: string[] = await page.evaluate(([keys, base]) => {
          const { hands, THREE, keys: caps } = (window as any).__rsDesk._debug;
          (window as any).__rsDesk.render(-1, [{ at: base + 1000, hold: 300, keys, from: base + 500 }], { to: "keyboard" });
          (window as any).__rsDesk.render(base + 1100, [], { to: "keyboard" });
          return keys.flatMap((k: any) => {
            const h = hands[k.hand];
            h.root.updateMatrixWorld(true);
            const c = h.chains[k.finger];
            const tip = c.joints[c.joints.length - 1].bone.getWorldPosition(new THREE.Vector3());
            const box = new THREE.Box3().setFromObject(caps.get(k.id).mesh);
            const off = Math.hypot(Math.max(0, box.min.x - tip.x, tip.x - box.max.x), Math.max(0, box.min.z - tip.z, tip.z - box.max.z));
            return off > 0.05 ? [`${k.id} (${k.hand} ${k.finger}) is ${off.toFixed(2)} keys off`] : [];
          });
        }, [keys, base] as const);
        assert.deepEqual(misses, [], `${laptop} ${chord}`);
      }
    } finally {
      await close();
    }
  }
});

test("hands: nothing jumps between frames, however fast the typing and however the keys overlap", { timeout: 300_000 }, async () => {
  const lay = layout("mac");
  const { page, close } = await deskPage("mac");
  try {
    // A shortcut, then a capitalised phrase at 240 wpm: shifted letters on both hands, modifiers overlapping keys.
    const chord = resolveChord("Meta+Shift+P", lay) as any;
    const events: any[] = [{ at: 1000, hold: 90, keys: assignFingers(chord.keys, lay), from: 730 }];
    Array.from("Acme Q3 Launch, Ready?").forEach((c, i) => {
      const keys = resolveChar(c, lay);
      if (keys) events.push({ at: 2000 + i * 50, hold: 35, keys: assignFingers(keys, lay), from: 1730 });
    });
    await page.evaluate((ev) => (window as any).__rsDesk.render(-1, ev, { to: "keyboard" }), events);
    const times = Array.from({ length: 240 }, (_, i) => (i * 1000) / 60);
    const poses = await posesAt(page, times);
    let hand = 0, tip = 0;
    for (let i = 1; i < poses.length; i++) for (const side of ["left", "right"] as const) {
      hand = Math.max(hand, dist(poses[i - 1][side].root, poses[i][side].root));
      poses[i][side].tips.forEach((p, f) => (tip = Math.max(tip, dist(poses[i - 1][side].tips[f], p))));
    }
    // In key units, at 60 fps. A keystroke itself moves a fingertip about 0.6 in a frame; a hand that teleports moves 2 or more.
    assert.ok(hand < 0.6, `a hand moved ${hand.toFixed(2)} keys in one frame`);
    assert.ok(tip < 1, `a fingertip moved ${tip.toFixed(2)} keys in one frame`);
    // A frame is a function of its time, not of the frames before it (preview --at renders one frame alone).
    const again = await posesAt(page, [2300, 1000]);
    const direct = await posesAt(page, [1000, 2300]);
    assert.deepEqual(again[0], direct[1]);
    assert.deepEqual(again[1], direct[0]);
  } finally {
    await close();
  }
});

test("hands: palms face the keys and each thumb is on the inside, on both hands", { timeout: 120_000 }, async () => {
  const { page, close } = await deskPage("mac");
  try {
    const got = await page.evaluate(() => {
      const { hands, THREE } = (window as any).__rsDesk._debug;
      (window as any).__rsDesk.render(300, [], { to: "keyboard" });
      const out: any = {};
      for (const h of Object.values(hands) as any[]) {
        h.root.updateMatrixWorld(true);
        const model = h.root.children[0];
        const normal = h.palm.clone().applyQuaternion(model.getWorldQuaternion(new THREE.Quaternion()));
        const tip = (f: number) => h.chains[f].joints[h.chains[f].joints.length - 1].bone.getWorldPosition(new THREE.Vector3());
        out[h.side] = { normalY: normal.y, thumbX: tip(0).x, littleX: tip(4).x };
      }
      out.font = document.fonts.check("400 32px Inter") && document.fonts.check("500 32px Inter");
      return out;
    });
    for (const side of ["left", "right"] as const) assert.ok(got[side].normalY < -0.8, `the ${side} palm faces ${got[side].normalY > 0 ? "up" : "sideways"}`);
    assert.ok(got.left.thumbX > got.left.littleX, "the left thumb is on the outside: a mirrored hand");
    assert.ok(got.right.thumbX < got.right.littleX, "the right thumb is on the outside: a mirrored hand");
    assert.ok(got.font, "the key legends' font (Inter) isn't loaded");
  } finally {
    await close();
  }
});
