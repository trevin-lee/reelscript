import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createDemo } from "../src/index.js";
import { resolveFfmpeg } from "../src/encoder.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", tsx, join(root, "src/cli.ts"), ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let output = "";
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code, output }));
  });
}

function demo(dir: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.ts"), `import { createDemo } from "@reelscript/cli";\n${body}\n`);
}

/** A frame's pixels, and the mean difference between two frames over a region. */
async function pixels(file: string) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}
function diff(a: Awaited<ReturnType<typeof pixels>>, b: Awaited<ReturnType<typeof pixels>>, region: { left: number; top: number; width: number; height: number }) {
  let sum = 0;
  for (let y = region.top; y < region.top + region.height; y++) {
    for (let x = region.left; x < region.left + region.width; x++) {
      const i = (y * a.width + x) * a.channels;
      for (let c = 0; c < 3; c++) sum += Math.abs(a.data[i + c] - b.data[i + c]);
    }
  }
  return sum / (region.width * region.height * 3);
}

test("the keyboard window and the desk views queue like any window and view, and their options are checked where they're given", () => {
  const d = createDemo({ desk: { laptop: "pc", hands: false, surface: "rgb(30, 30, 34)" }, wallpaper: "#101418" });
  d.keyboard.open({ labels: false, x: 10, y: 20 });
  d.desk.to("wide", { duration: 500 });
  d.desk.to("float", { orbit: -30, tilt: 10, distance: 1.2 });
  d.desk.to("wide", { hands: false });
  d.desk.to("float", { ipad: false, orbit: 360 });
  d.desk.lid(0, { duration: 900 });
  d.desk.out();
  d.keyboard.place({ width: 400 });
  d.keyboard.close();
  assert.deepEqual(d.getTimeline(), [
    { kind: "keyboard.open", labels: false, x: 10, y: 20 },
    { kind: "desk.to", view: "wide", duration: 500 },
    { kind: "desk.to", view: "float", orbit: -30, tilt: 10, distance: 1.2 },
    { kind: "desk.to", view: "wide", hands: false },
    { kind: "desk.to", view: "float", ipad: false, orbit: 360 },
    { kind: "desk.lid", degrees: 0, duration: 900 },
    { kind: "desk.out" },
    { kind: "window.place", window: "keyboard", width: 400 },
    { kind: "window.close", window: "keyboard" },
  ]);
  assert.throws(() => d.desk.to("side" as never), /unknown view "side" \(use "screen", "wide", "keys", "float"\)/);
  assert.throws(() => d.desk.to("wide", { tilt: 90 }), /tilt must be degrees from -30 to 80, not 90/);
  assert.throws(() => d.desk.to("wide", { tilt: -40 }), /tilt must be degrees from -30 to 80, not -40/);
  assert.throws(() => d.desk.to("wide", { distance: 0.1 }), /distance must be from 0\.3 to 4/);
  assert.throws(() => createDemo().desk.to("float", { hands: true }), /the hands are never in the "float" view/);
  assert.throws(() => createDemo({ desk: { hands: false, sleeve: "navy" } }), /desk sleeve colours the hands, which hands: false leaves out/);
  assert.throws(() => d.desk.to("wide", { orbit: "left" as never }), /orbit must be a number/);
  assert.throws(() => d.desk.to("wide", { hands: "no" as never }), /hands must be true or false/);
  assert.throws(() => d.desk.to("float", { ipad: 0 as never }), /ipad must be true or false/);
  assert.throws(() => d.desk.out({ orbit: 10 } as never), /orbit/);
  assert.throws(() => d.desk.lid(150), /degrees must be from 0 \(shut\) to 135/);
  // Nothing is quietly ignored: an iPad outside "float", hands the desk hasn't got, focus on a window that takes no typing.
  assert.throws(() => d.desk.to("wide", { ipad: false }), /ipad is for the "float" view/);
  assert.throws(() => createDemo({ desk: { hands: false } }).desk.to("wide", { hands: true }), /hands: true needs the desk's hands/);
  assert.equal((d.keyboard as unknown as { focus?: unknown }).focus, undefined, "the keyboard window has no focus()");
  assert.throws(() => d.desk.lid(undefined as never), /degrees/);
  assert.throws(() => createDemo({ desk: { backdrop: "nope nope" } }), /desk backdrop must be a CSS colour/);
  // A colour is a real one: a typo the page would quietly ignore fails here.
  assert.throws(() => createDemo({ desk: { handColor: "blurple" } }), /desk handColor must be a CSS colour, not "blurple"/);
  assert.throws(() => createDemo({ desk: { surface: "walnut" } }), /desk surface must be a CSS colour \(or "oak"\)/);
  assert.throws(() => createDemo({ wallpaper: "blurple" }), /wallpaper must be a CSS colour or gradient, or an image file's path/);
  for (const ok of [{ desk: { surface: "oak", sleeve: "RebeccaPurple", backdrop: "oklch(70% 0.1 250)", handColor: "#c8a080" } }, { wallpaper: "linear-gradient(#000, #fff)" }, { wallpaper: "hsl(220 30% 20%)" }])
    assert.doesNotThrow(() => createDemo(ok as never), JSON.stringify(ok));
  assert.throws(() => d.press("a", { window: "keyboard" as never }), /unknown window "keyboard"/);
  assert.throws(() => d.desk.to("wide", { duration: -1 }), /duration must be a number, 0 or more/);
  assert.throws(() => createDemo({ desk: { laptop: "amiga" as never } }), /unknown desk laptop "amiga" \(use "mac" or "pc"\)/);
  assert.throws(() => createDemo({ desk: { hads: true } as never }), /hads/);
  assert.throws(() => createDemo({ desk: { handColor: "not a colour" } }), /desk handColor must be a CSS colour/);
  assert.throws(() => createDemo({ theme: "bare", wallpaper: "#000" }), /the bare theme draws no desktop, so wallpaper does nothing there/);
});

test("check: the keyboard window never takes typing; a key the laptop hasn't got fails at the line; a character it can't type is a warning", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-desk-"));
  const page = `data:text/html,<input id=f autofocus>`;
  demo(
    dir,
    `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("${page}");\ndemo.keyboard.open();\ndemo.type("#f", "ok");\ndemo.press("Meta+K");\n` +
      `demo.call(async ({ page }) => { const v = await page!.inputValue("#f"); if (v !== "ok") throw new Error("typed elsewhere: " + JSON.stringify(v)); });\nawait demo.render("out.mp4");`,
  );
  const ok = await run(["check", "--strict", "s.ts"], dir);
  assert.equal(ok.code, 0, ok.output);

  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("${page}");\ndemo.keyboard.open();\ndemo.press("Meta+F13");\nawait demo.render("out.mp4");`);
  const missing = await run(["check", "s.ts"], dir);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /press\("Meta\+F13"\): the Mac keyboard on the desk has no "F13" key[\s\S]*s\.ts:5/);

  // In a desk view the camera is the desk's: zoom.to() would zoom the picture inside the laptop's screen.
  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("${page}");\ndemo.desk.to("wide", { duration: 200 });\ndemo.zoom.to("#f");\nawait demo.render("out.mp4");`);
  const zoomed = await run(["check", "s.ts"], dir);
  assert.equal(zoomed.code, 1);
  assert.match(zoomed.output, /zoom\.to\(\) zooms the flat desktop, and a desk view is on[\s\S]*s\.ts:5/);
  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("${page}");\ndemo.desk.to("wide", { duration: 200 });\ndemo.zoom.out();\nawait demo.render("out.mp4");`);
  const unzoomed = await run(["check", "s.ts"], dir);
  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("${page}");\ndemo.desk.to("wide", { duration: 200 });\ndemo.wait(300);\ndemo.desk.out();\ndemo.zoom.to("#f");\nawait demo.render("out.mp4");`);
  const landing = await run(["check", "s.ts"], dir);
  assert.equal(landing.code, 1);
  assert.match(landing.output, /desk\.out\(\) is still flying back to it \(until [\d.]+s\); wait for it to land first[\s\S]*s\.ts:7/);
  assert.equal(unzoomed.code, 1);
  assert.match(unzoomed.output, /zoom\.out\(\) zooms the flat desktop, and a desk view is on[\s\S]*s\.ts:5/);

  // Keys pressed with the lid down in a desk view are under it: a warning at each such line. On the flat desktop the
  // laptop's screen is the frame, plainly on: the keyboard window shows the lid open, and there's nothing to warn of.
  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("${page}");\ndemo.desk.to("wide", { duration: 0 });\ndemo.desk.lid(0, { duration: 0 });\ndemo.type("#f", "hi");\nawait demo.render("out.mp4");`);
  const shut = await run(["check", "s.ts"], dir);
  assert.equal(shut.code, 0, shut.output);
  assert.match(shut.output, /the laptop's lid is down \(0°\), so the keys pressed here are under it[\s\S]*s\.ts:6/);
  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("${page}");\ndemo.keyboard.open();\ndemo.desk.lid(0, { duration: 0 });\ndemo.type("#f", "hi");\nawait demo.render("out.mp4");`);
  const flatShut = await run(["check", "--strict", "s.ts"], dir);
  assert.equal(flatShut.code, 0, flatShut.output);

  // The PC laptop's platform: pages see Windows and answer its shortcuts, on every host (a Mac host included, where
  // Playwright would give a Mac's editing): Control+A selects all, Ctrl+K reaches the app as Ctrl.
  demo(
    dir,
    `const demo = createDemo({ viewport: [400, 300], desk: { laptop: "pc" } });\ndemo.browser.goto("data:text/html,<input id=f value='hello world'><script>addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='k')document.title='ctrl k'})</script>");\n` +
      `demo.cursor.moveTo("#f");\ndemo.cursor.click();\ndemo.press("Control+A");\ndemo.type("#f", "X");\ndemo.press("Control+K");\n` +
      `demo.call(async ({ page }) => { const r = await page!.evaluate("[document.querySelector('#f').value, document.title, navigator.platform].join('|')"); if (r !== "X|ctrl k|Win32") throw new Error("not a PC: " + r); });\nawait demo.render("out.mp4");`,
  );
  const pc = await run(["check", "s.ts"], dir);
  assert.equal(pc.code, 0, pc.output);

  // Typing into a field the panel covers, or moving to it, is a warning at the line: it'd be filmed behind the panel.
  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("data:text/html,<input id=f style='position:fixed;right:6px;bottom:6px'>");\ndemo.keyboard.open();\ndemo.type("#f", "hi");\nawait demo.render("out.mp4");`);
  const hidden = await run(["check", "s.ts"], dir);
  assert.equal(hidden.code, 0, hidden.output);
  assert.match(hidden.output, /"#f" is under the keyboard window, which covers it on screen[\s\S]*s\.ts:5/);

  // The panel stays in front, as it's drawn, even after another window is focused: a click under it lands on it.
  const corner = `data:text/html,<button id=b style='position:fixed;right:4px;bottom:4px'>b</button>`;
  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("${corner}");\ndemo.keyboard.open();\ndemo.browser.focus();\ndemo.cursor.moveTo("#b");\ndemo.cursor.click();\nawait demo.render("out.mp4");`);
  const covered = await run(["check", "s.ts"], dir);
  assert.equal(covered.code, 1);
  assert.match(covered.output, /would land on the keyboard window[^\n]*move it \(demo\.keyboard\.place\(\)\) or close it[\s\S]*s\.ts:7/);

  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("${page}");\ndemo.press("Meta+Delete");\nawait demo.render("out.mp4");`);
  assert.equal((await run(["check", "s.ts"], dir)).code, 0, "with no keyboard window or desk view, any key goes");

  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("${page}");\ndemo.keyboard.open();\ndemo.type("#f", "café");\nawait demo.render("out.mp4");`);
  const warned = await run(["check", "--strict", "s.ts"], dir);
  assert.equal(warned.code, 1);
  assert.match(warned.output, /the keyboard on the desk has no key for "é", so typing it isn't shown there[\s\S]*s\.ts:5/);
});

test("renders: the keyboard panel shows a key going down, a desk view starts from the flat frame, and both render the same every time", { timeout: 1_500_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-desk-"));
  demo(
    dir,
    `const demo = createDemo({ viewport: [420, 280], fps: 6, desk: { laptop: process.env.LAPTOP } });\ndemo.browser.goto("data:text/html,<input id=f autofocus>");\n` +
      `demo.keyboard.open();\ndemo.wait(400);\ndemo.press("Meta+Shift+P");\ndemo.wait(600);\ndemo.desk.to("wide", { duration: 800 });\ndemo.wait(1000);\nawait demo.render(process.env.OUT ?? "out.mp4");`,
  );
  // Panel: lower right, 42% of the desktop wide. Before the chord and on it, the panel changes and the page doesn't.
  const before = join(dir, "before.png"), on = join(dir, "on.png");
  for (const [out, at] of [[before, "0.5"], [on, "1.4"]] as const) {
    const r = await run(["preview", "s.ts", "--at", at, "--out", out], dir, { LAPTOP: "mac" });
    assert.equal(r.code, 0, r.output);
  }
  const a = await pixels(before), b = await pixels(on);
  const panelW = Math.min(560, Math.round(a.width * 0.42)), panelH = Math.round(panelW * 0.45);
  const panel = { left: a.width - panelW - 24, top: a.height - panelH - 24, width: panelW, height: panelH };
  assert.ok(diff(a, b, panel) > 2, "the panel changed as the chord was pressed");
  assert.ok(diff(a, b, { left: 80, top: 80, width: 200, height: 100 }) < 0.5, "the page didn't");
  // A desk view's first frame is the flat frame on the laptop's screen, filling the frame: nearly the same picture.
  const flat = join(dir, "flat.png"), fly = join(dir, "fly.png");
  for (const [out, at] of [[flat, "1.3"], [fly, "1.4"]] as const) {
    const r = await run(["preview", "s.ts", "--at", at, "--out", out], dir, { LAPTOP: "mac" });
    assert.equal(r.code, 0, r.output);
  }
  const c = await pixels(flat), d = await pixels(fly);
  assert.ok(diff(c, d, { left: 0, top: 0, width: c.width, height: c.height }) < 12, "a frame into the flight, the desk still looks like the flat frame");
  // The same every time, for both laptops.
  for (const laptop of ["mac", "pc"]) {
    for (const out of ["a.mp4", "b.mp4"]) {
      const r = await run(["render", "s.ts"], dir, { OUT: out, LAPTOP: laptop });
      assert.equal(r.code, 0, r.output);
    }
    execFileSync(resolveFfmpeg(), ["-v", "error", "-i", "a.mp4", "-i", "b.mp4", "-lavfi", "[0:v][1:v]psnr=stats_file=psnr.log", "-f", "null", "-"], { cwd: dir });
    const worst = Math.min(
      ...readFileSync(join(dir, "psnr.log"), "utf8").trim().split("\n").map((l) => {
        const v = /psnr_avg:(\S+)/.exec(l)?.[1];
        return v === "inf" || !v ? Infinity : Number(v);
      }),
    );
    assert.ok(worst >= 40, `${laptop}: every frame the same to the eye (40 dB): worst ${worst} dB`);
  }
});

test("the wallpaper is a colour, a gradient, or an image relative to the script; a missing image names the createDemo line", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-desk-"));
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } }).png().toFile(join(dir, "bg.png"));
  const corner = async (wallpaper: string) => {
    demo(dir, `const demo = createDemo({ viewport: [300, 200], wallpaper: ${JSON.stringify(wallpaper)} });\ndemo.browser.goto("data:text/html,hi");\nawait demo.render("out.mp4");`);
    const r = await run(["preview", "s.ts", "--out", "w.png"], dir);
    assert.equal(r.code, 0, r.output);
    const p = await pixels(join(dir, "w.png"));
    const i = ((p.height - 6) * p.width + 6) * p.channels;
    return [p.data[i], p.data[i + 1], p.data[i + 2]];
  };
  const [r, g, b] = await corner("#102030");
  assert.ok(Math.abs(r - 16) <= 2 && Math.abs(g - 32) <= 2 && Math.abs(b - 48) <= 2, `a colour: ${[r, g, b]}`);
  const [r2, g2] = await corner("bg.png");
  assert.ok(r2 > 240 && g2 < 15, `an image: ${[r2, g2]}`);
  demo(dir, `const demo = createDemo({ viewport: [300, 200], wallpaper: "nope.png" });\ndemo.browser.goto("data:text/html,hi");\nawait demo.render("out.mp4");`);
  const bad = await run(["check", "s.ts"], dir);
  assert.equal(bad.code, 1);
  assert.match(bad.output, /there's no wallpaper image at [^\n]*nope\.png[\s\S]*s\.ts:2[^\n]*\(createDemo\)/);
});

test("desk views: a flight begun mid-flight carries on from where it was, float shows the demo on both devices, and the lid closes over it", { timeout: 1_200_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-float-"));
  // A page in one loud colour, so the screens are easy to count.
  demo(
    dir,
    `const demo = createDemo({ viewport: [360, 240], fps: 30 });\ndemo.browser.goto("data:text/html,<body style='background:%23e0218a;margin:0'>");\n` +
      `demo.wait(300);\ndemo.desk.to("wide", { duration: 1000 });\ndemo.wait(500);\ndemo.desk.to("float", { duration: 1000 });\ndemo.wait(1600);\n` +
      `demo.desk.lid(0, { duration: 600 });\ndemo.wait(900);\nawait demo.render("out.mp4");`,
  );
  const r = await run(["render", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  mkdirSync(join(dir, "f"));
  execFileSync(resolveFfmpeg(), ["-v", "error", "-i", "out.mp4", join("f", "%04d.png")], { cwd: dir });
  const files = (await import("node:fs")).readdirSync(join(dir, "f")).sort();
  const frames = await Promise.all(files.map((f) => pixels(join(dir, "f", f))));
  const whole = { left: 0, top: 0, width: frames[0].width, height: frames[0].height };
  // Nothing jumps: each step between frames is in line with the steps beside it (the old flight restarted from
  // where the first was heading, a jump of a whole shot).
  const steps = frames.slice(1).map((f, i) => diff(frames[i], f, whole));
  for (let i = 1; i < steps.length - 1; i++) {
    assert.ok(steps[i] <= 1.8 * Math.max(steps[i - 1], steps[i + 1]) + 1.5, `frame ${i + 1} jumps: ${steps.slice(i - 1, i + 2).map((s) => s.toFixed(1)).join(", ")}`);
  }
  // The float view settled (before the lid moves): the backdrop round the edges, the page's colour on two screens.
  const magenta = (p: (typeof frames)[0], from: number, to: number) => {
    let n = 0;
    for (let y = 0; y < p.height; y++) for (let x = Math.round(p.width * from); x < Math.round(p.width * to); x++) {
      const i = (y * p.width + x) * p.channels;
      if (p.data[i] > 170 && p.data[i + 1] < 90 && p.data[i + 2] > 90 && p.data[i + 2] < 190) n++;
    }
    return n / (p.width * p.height);
  };
  const settled = frames[Math.round(30 * (0.3 + 0.5 + 1.6)) - 2], shut = frames[frames.length - 1];
  const corner = settled.data.subarray(0, 3);
  assert.ok(corner[0] > 150 && Math.abs(corner[0] - corner[2]) < 30, `the float view's backdrop is a light grey, not ${[...corner]}`);
  assert.ok(magenta(settled, 0, 0.55) > 0.02, "the laptop's screen shows the demo");
  assert.ok(magenta(settled, 0.6, 1) > 0.02, "the iPad's screen shows the demo");
  // Shut, the laptop's screen is gone; the iPad's is still there.
  assert.ok(magenta(shut, 0, 0.5) < 0.01, "the laptop's screen is hidden by its lid");
  assert.ok(magenta(shut, 0.6, 1) > 0.02, "the iPad still shows the demo");
});
