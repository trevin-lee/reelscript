import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

test("the page clock leaves the page's own control of its animations alone: pause, seek, finish, paused style", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript(clockShim(0));
    const page = await ctx.newPage();
    await page.setContent(`<style>@keyframes slide { to { transform: translateX(1000px) } } .b { width: 10px; height: 10px; animation: slide 10s linear }</style>
<div class=b id=held style="animation-play-state: paused"></div><div class=b id=moving></div><div id=w></div><div id=f></div><div id=s></div>`);
    const step = async (ms: number) => { for (let t = 0; t < ms; t += 50) await page.evaluate(() => (window as unknown as { __reelscript_advance: (n: number) => void }).__reelscript_advance(50)); };
    await page.evaluate(`window.aw = document.getElementById("w").animate([{ opacity: 1 }, { opacity: 0 }], { duration: 10000 });
window.af = document.getElementById("f").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 10000, fill: "forwards" });
window.as = document.getElementById("s").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 10000 });`);
    await step(1000);
    await page.evaluate(`aw.pause(); af.finish(); as.currentTime = 5000;`);
    const pausedAt = await page.evaluate(`aw.currentTime`);
    await step(1000);
    const seen = (await page.evaluate(`({
      held: new DOMMatrix(getComputedStyle(document.getElementById("held")).transform).e,
      moving: new DOMMatrix(getComputedStyle(document.getElementById("moving")).transform).e,
      paused: aw.currentTime,
      finished: getComputedStyle(document.getElementById("f")).opacity,
      seeked: as.currentTime,
    })`)) as Record<string, number | string>;
    assert.equal(seen.held, 0, "animation-play-state: paused holds it");
    assert.ok((seen.moving as number) > 150, `the one beside it moves: ${seen.moving}`);
    assert.equal(seen.paused, pausedAt, "a paused animation stays paused");
    assert.equal(seen.finished, "1", "a finished one stays at its end");
    assert.equal(seen.seeked, 6000, "a seek is where it goes on from");
    await page.evaluate(`aw.play()`);
    await step(500);
    assert.equal(await page.evaluate(`aw.currentTime`), (pausedAt as number) + 500, "and play() resumes it on the clock");
  } finally {
    await browser.close();
  }
});

test("scroll() goes to content that only appears once it's scrolled into view", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p19-"));
  writeFileSync(join(dir, "p.html"), `<div style="height:2000px">top</div><section id=pricing style="opacity:0;transition:opacity .3s;height:200px">Pricing</section>
<script>new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.style.opacity = 1))).observe(pricing);</script>`);
  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\nawait demo.browser.goto("./p.html");\nawait demo.scroll("#pricing");\nawait demo.wait(400);\nawait demo.cursor.moveTo("#pricing");\nawait demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\nawait demo.browser.goto("./p.html");\nawait demo.cursor.moveTo("#pricing");\nawait demo.render("out.mp4");`);
  const unscrolled = await run(["check", "s.ts"], dir);
  assert.equal(unscrolled.code, 1);
  assert.match(unscrolled.output, /"#pricing" is on the page but not visible[\s\S]*demo\.scroll\("#pricing"\) first/);
});

test("type() into a button fails; preview shows the first of two renders", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p19-"));
  writeFileSync(join(dir, "p.html"), `<button id=b onclick="this.textContent = 'clicked'">Load</button>`);
  demo(dir, `const demo = createDemo({ viewport: [300, 200] });\nawait demo.browser.goto("./p.html");\nawait demo.type("#b", "hi there");\nawait demo.render("out.mp4");`);
  const button = await run(["check", "s.ts"], dir);
  assert.equal(button.code, 1);
  assert.match(button.output, /can't type into "#b": it can't take the keyboard \(it isn't a text field\)/);
  demo(dir, `const demo = createDemo({ viewport: [300, 200], fps: 10, theme: "bare" });\nawait demo.browser.goto("data:text/html,hi");\nawait demo.wait(500);\nawait demo.render("out.mp4");\nawait demo.render("out.gif");`);
  const preview = await run(["preview", "s.ts", "--at", "0.2", "--out", "f.png"], dir);
  assert.equal(preview.code, 0, preview.output);
  assert.ok(existsSync(join(dir, "f.png")));
});

test("a local page is served over http: its modules load, its fetch reaches mockAPI, its cookies stick", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p19-"));
  writeFileSync(join(dir, "m.js"), `export const v = "module";`);
  writeFileSync(join(dir, "p.html"), `<p id=out>-</p><script type=module>import { v } from "./m.js"; const j = await (await fetch("/api/projects?page=2")).json(); document.cookie = "a=1; max-age=100"; out.textContent = [v, j.name, document.cookie].join(" ");</script>`);
  demo(dir, `const demo = createDemo({ viewport: [500, 200] });\ndemo.browser.mockAPI("/api/projects", { name: "Mocked" });\nawait demo.browser.goto("./p.html");\nawait demo.waitFor("text=module Mocked a=1", { timeout: 4000 });\nawait demo.render("out.mp4");`);
  const r = await run(["check", "--strict", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  demo(dir, `const demo = createDemo();\nawait demo.browser.goto("./nope.html");\nawait demo.render("out.mp4");`);
  const missing = await run(["check", "s.ts"], dir);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /goto\("\.\/nope\.html"\): there's no page at \S*nope\.html/);
});

test("opening an open terminal keeps what isn't passed", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p19-"));
  demo(dir, `import { writeFileSync } from "node:fs";
const demo = createDemo({ viewport: [700, 400] });
await demo.terminal.open({ prompt: "acme % ", cols: 60 });
await demo.terminal.open({ fontSize: 18 });
await demo.call(async ({ page }) => writeFileSync("seen.json", JSON.stringify(await page!.evaluate(() => [(window as any).__rsTerm.cols, document.querySelector(".xterm-rows > div")?.textContent?.trim(), getComputedStyle(document.querySelector(".xterm-rows")!).fontSize]))));
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")), [60, "acme %", "18px"]);
});

test("a script can say a warning's cause is meant: goto status, click dialog, run exitCode", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p19-"));
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/gone" ? 404 : 200, { "content-type": "text/html" });
    res.end(req.url === "/gone" ? "<h1>Not found</h1>" : `<button id=del onclick="out.textContent = confirm('Delete?') ? 'deleted' : 'kept'">Delete</button><p id=out>-</p>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    demo(dir, `const demo = createDemo({ viewport: [400, 200] });
await demo.browser.goto("${base}/gone", { status: 404 });
await demo.browser.goto("${base}/");
await demo.cursor.moveTo("#del");
await demo.cursor.click({ dialog: "dismiss" });
await demo.waitFor("text=kept", { timeout: 3000 });
await demo.render("out.mp4");`);
    const r = await run(["check", "--strict", "s.ts"], dir);
    assert.equal(r.code, 0, r.output);
    assert.doesNotMatch(r.output, /warning/);
  } finally {
    server.close();
  }
  demo(dir, `const demo = createDemo();\nawait demo.terminal.open();\nawait demo.terminal.run("sh -c 'exit 3'", { exitCode: 3 });\nawait demo.render("out.mp4");`);
  const rec = await run(["record", "--strict", "s.ts"], dir);
  assert.equal(rec.code, 0, rec.output);
});

test("under render --out, the video is there when render() returns, for the script to cut or caption", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p19-"));
  writeFileSync(join(dir, "x.mp4"), "the previous video");
  // As a script that post-processes its render does: use the file, then fail or not.
  const script = (fail: boolean) =>
    `import { statSync, writeFileSync } from "node:fs";\nconst demo = createDemo({ viewport: [300, 200], fps: 10, theme: "bare" });\n` +
    `await demo.browser.goto("data:text/html,hi");\nconst { out } = await demo.render("out.mp4");\n` +
    `writeFileSync("size.txt", String(statSync(out).size));\n${fail ? 'throw new Error("captioning failed");' : ""}`;
  demo(dir, script(true));
  const failed = await run(["render", "s.ts", "--out", "x.mp4"], dir);
  assert.equal(failed.code, 1);
  assert.ok(Number(readFileSync(join(dir, "size.txt"), "utf8")) > 1000, "the script read its video");
  assert.equal(readFileSync(join(dir, "x.mp4"), "utf8"), "the previous video", "and its failure put the previous one back");
  demo(dir, script(false));
  const ok = await run(["render", "s.ts", "--out", "x.mp4"], dir);
  assert.equal(ok.code, 0, ok.output);
  assert.equal(statSync(join(dir, "x.mp4")).size, Number(readFileSync(join(dir, "size.txt"), "utf8")));
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(".")), [], "nothing left beside it");
});

test("a run that fails leaves earlier output alone: render --out with two renders, record --strict", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p19-"));
  writeFileSync(join(dir, "x.mp4"), "the previous video");
  demo(dir, `const demo = createDemo({ viewport: [300, 200], fps: 10, theme: "bare" });\nawait demo.browser.goto("data:text/html,hi");\nawait demo.render("out.mp4");\nawait demo.render("out.gif");`);
  const out = await run(["render", "s.ts", "--out", "x.mp4"], dir);
  assert.equal(out.code, 1);
  assert.equal(readFileSync(join(dir, "x.mp4"), "utf8"), "the previous video");
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(".")), [], "and nothing left beside it");
  demo(dir, `const demo = createDemo();\nawait demo.terminal.open();\nawait demo.terminal.run("echo new");\nawait demo.terminal.run("ls /no-such-dir");\nawait demo.render("out.mp4");`);
  mkdirSync(join(dir, "recordings"), { recursive: true });
  const before = readdirSync(join(dir, "recordings"));
  const rec = await run(["record", "--strict", "s.ts"], dir);
  assert.equal(rec.code, 1);
  assert.match(rec.output, /--strict makes a run with warnings fail; the recordings are unchanged/);
  assert.deepEqual(readdirSync(join(dir, "recordings")), before);
});
