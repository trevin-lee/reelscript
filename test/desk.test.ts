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
  const d = createDemo({ desk: { laptop: "pc", hands: false, handColor: "#c8a080", surface: "rgb(30, 30, 34)" }, wallpaper: "#101418" });
  d.keyboard.open({ labels: false, x: 10, y: 20 });
  d.desk.to("desk", { duration: 500 });
  d.desk.out();
  d.keyboard.place({ width: 400 });
  d.keyboard.close();
  assert.deepEqual(d.getTimeline(), [
    { kind: "keyboard.open", labels: false, x: 10, y: 20 },
    { kind: "desk.to", view: "desk", duration: 500 },
    { kind: "desk.out" },
    { kind: "window.place", window: "keyboard", width: 400 },
    { kind: "window.close", window: "keyboard" },
  ]);
  assert.throws(() => d.desk.to("side" as never), /unknown view "side" \(use "screen", "desk", "keyboard"\)/);
  assert.throws(() => d.press("a", { window: "keyboard" as never }), /unknown window "keyboard"/);
  assert.throws(() => d.desk.to("desk", { duration: -1 }), /duration must be a number, 0 or more/);
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

  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("${page}");\ndemo.keyboard.open();\ndemo.press("Meta+Delete");\nawait demo.render("out.mp4");`);
  const missing = await run(["check", "s.ts"], dir);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /press\("Meta\+Delete"\): the Mac keyboard on the desk has no "Delete" key[\s\S]*s\.ts:5/);

  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("${page}");\ndemo.press("Meta+Delete");\nawait demo.render("out.mp4");`);
  assert.equal((await run(["check", "s.ts"], dir)).code, 0, "with no keyboard window or desk view, any key goes");

  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("${page}");\ndemo.keyboard.open();\ndemo.type("#f", "café");\nawait demo.render("out.mp4");`);
  const warned = await run(["check", "--strict", "s.ts"], dir);
  assert.equal(warned.code, 1);
  assert.match(warned.output, /the keyboard on the desk has no key for "é", so typing it isn't shown there[\s\S]*s\.ts:5/);
});

test("renders: the keyboard panel shows a key going down, a desk view starts from the flat frame, and both render the same every time", { timeout: 600_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-desk-"));
  demo(
    dir,
    `const demo = createDemo({ viewport: [420, 280], fps: 10, desk: { laptop: process.env.LAPTOP } });\ndemo.browser.goto("data:text/html,<input id=f autofocus>");\n` +
      `demo.keyboard.open();\ndemo.wait(400);\ndemo.press("Meta+Shift+P");\ndemo.wait(600);\ndemo.desk.to("desk", { duration: 800 });\ndemo.wait(1000);\nawait demo.render(process.env.OUT ?? "out.mp4");`,
  );
  // Panel: lower right, 42% of the desktop wide. Before the chord and on it, the panel changes and the page doesn't.
  const before = join(dir, "before.png"), on = join(dir, "on.png");
  for (const [out, at] of [[before, "0.5"], [on, "1.1"]] as const) {
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
