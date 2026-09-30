import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { clockShim } from "../src/clock.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");

function run(args: string[], cwd: string) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", tsx, join(root, "src/cli.ts"), ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
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

async function withClock<T>(html: string, fn: (page: import("playwright").Page, advance: (ms: number) => Promise<void>) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 500, height: 300 } });
    await ctx.addInitScript(clockShim(0));
    const page = await ctx.newPage();
    await page.setContent(html);
    const advance = (ms: number) => page.evaluate((ms) => (window as unknown as { __reelscript_advance: (n: number) => void }).__reelscript_advance(ms), ms);
    return await fn(page, advance);
  } finally {
    await browser.close();
  }
}

test("the page clock follows Web Animations the page reverses, slows, or replays", { timeout: 60_000 }, async () => {
  await withClock(`<div id=a style="width:50px;height:50px;background:red"></div>`, async (page, advance) => {
    const make = (opts: string) => page.evaluate(`window.anim = document.getElementById("a").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, fill: "both" }); ${opts}`);
    const opacity = () => page.evaluate(() => Number(getComputedStyle(document.getElementById("a")!).opacity));
    // reversed halfway: goes back down, and ends closed
    await make("");
    await advance(16);
    for (let i = 0; i < 30; i++) await advance(1000 / 60); // ~500ms
    const mid = await opacity();
    await page.evaluate(() => (window as unknown as { anim: Animation }).anim.reverse());
    for (let i = 0; i < 12; i++) await advance(1000 / 60); // 200ms back
    assert.ok((await opacity()) < mid - 0.1, "reverse() goes backwards on the frame clock");
    for (let i = 0; i < 60; i++) await advance(1000 / 60);
    assert.ok((await opacity()) < 0.05, "a reversed animation ends at its start");
    // half speed
    await make("window.anim.playbackRate = 0.5;");
    await advance(16);
    for (let i = 0; i < 30; i++) await advance(1000 / 60); // 500ms of page time
    const half = await opacity();
    assert.ok(half > 0.18 && half < 0.32, `playbackRate 0.5 is about 0.25 at 500ms, got ${half}`);
    // replayed after finishing: back on the frame clock
    for (let i = 0; i < 120; i++) await advance(1000 / 60);
    await page.evaluate(() => { const a = (window as unknown as { anim: Animation }).anim; a.playbackRate = 1; a.currentTime = 0; a.play(); });
    await advance(1000 / 60);
    await new Promise((r) => setTimeout(r, 300)); // real time passes, page time doesn't
    const replay = await opacity();
    assert.ok(replay < 0.1, `a replayed animation waits for the frame clock, got ${replay}`);
  });
});

test("the text caret is drawn on the frame clock: solid after typing, then blinking", { timeout: 60_000 }, async () => {
  await withClock(`<input id=f style="font:20px sans-serif;margin:40px;width:300px" value="hello">`, async (page, advance) => {
    await page.focus("#f");
    const start = await page.evaluate(() => (document.getElementById("f") as HTMLInputElement).selectionStart);
    assert.equal(start, 0, "focus() leaves the caret at the start");
    await page.evaluate(() => (document.getElementById("f") as HTMLInputElement).setSelectionRange(5, 5)); // after "hello"
    const caret = () =>
      page.evaluate(() => {
        const el = [...document.querySelectorAll("div[aria-hidden=true]")].find((d) => (d as HTMLElement).style.position === "fixed") as HTMLElement | undefined;
        return el && el.style.display !== "none" ? { left: parseFloat(el.style.left), height: parseFloat(el.style.height) } : null;
      });
    await advance(16);
    const on = await caret();
    assert.ok(on && on.height > 10, "drawn right after focus");
    const field = await page.evaluate(() => document.getElementById("f")!.getBoundingClientRect().left);
    assert.ok(on!.left > field + 40, "after the text, not at the field's edge");
    for (let i = 0; i < 36; i++) await advance(1000 / 60); // ~600ms
    assert.equal(await caret(), null, "blinks off after half a second");
    for (let i = 0; i < 30; i++) await advance(1000 / 60); // ~1100ms
    assert.ok(await caret(), "and back on");
    const caretColor = await page.evaluate(() => getComputedStyle(document.getElementById("f")!).caretColor);
    assert.match(caretColor, /rgba\(0, 0, 0, 0\)|transparent/, "Chromium's own caret is hidden");
  });
});

test("a misspelt choice fails where the script sets it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p8-"));
  demo(dir, `const demo = createDemo();\nawait demo.browser.goto("data:text/html,<b id=b>b</b>");\nawait demo.cursor.moveTo("#b", { ease: "smoth" });\nawait demo.render("out.mp4");`);
  const ease = await run(["check", "s.ts"], dir);
  assert.equal(ease.code, 1);
  assert.match(ease.output, /unknown ease "smoth" \(use "smooth"[\s\S]*s\.ts:4/);
  demo(dir, `const demo = createDemo({ camera: "manaul" as never });\nawait demo.render("out.mp4");`);
  const camera = await run(["check", "s.ts"], dir);
  assert.equal(camera.code, 1);
  assert.match(camera.output, /unknown camera "manaul"/);
});

test("keys can't go to the terminal window, and record needs its cwd to exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p8-"));
  demo(dir, `const demo = createDemo();\nawait demo.terminal.open();\nawait demo.press("y");\nawait demo.render("out.mp4");`);
  const press = await run(["check", "s.ts"], dir);
  assert.equal(press.code, 1);
  assert.match(press.output, /terminal window aren't shown; use demo\.terminal\.run\(\)[\s\S]*s\.ts:4/);
  demo(dir, `const demo = createDemo();\nawait demo.terminal.open();\nawait demo.terminal.run("ls", { cwd: "nope" });\nawait demo.render("out.mp4");`);
  const rec = await run(["record", "s.ts"], dir);
  assert.equal(rec.code, 1);
  assert.match(rec.output, /the folder "nope" for "ls" doesn't exist[\s\S]*s\.ts:4/);
});

test("an extension folder beside the script can be named without ./", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p8-"));
  cpSync(join(root, "examples/acme-ext"), join(dir, "acme-ext"), { recursive: true });
  cpSync(join(root, "examples/acme"), join(dir, "acme"), { recursive: true });
  demo(dir, `const demo = createDemo({ viewport: [900, 600] });\nawait demo.editor.open({ workspace: "acme", extensions: ["acme-ext"] });\nawait demo.editor.command("Acme: Deploy to Production");\nawait demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
});
