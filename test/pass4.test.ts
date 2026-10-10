import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");
const acme = join(root, "examples/acme");
const { resolveFfmpeg } = await import("../src/encoder.js");
const ffmpeg = resolveFfmpeg(); // the bundled one, as renders use; CI has no system ffmpeg

function run(args: string[], cwd: string, env: Record<string, string> = {}, onOutput?: (all: string, child: ReturnType<typeof spawn>) => void) {
  return new Promise<{ code: number | null; signal: string | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", tsx, join(root, "src/cli.ts"), ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const on = (d: Buffer) => {
      output += d;
      onOutput?.(output, child);
    };
    child.stdout!.on("data", on);
    child.stderr!.on("data", on);
    child.on("close", (code, signal) => resolve({ code, signal, output }));
  });
}

function demo(dir: string, body: string, name = "s.ts") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `import { createDemo } from "@reelscript/cli";\n${body}\n`);
}

const tall = "data:text/html," + encodeURIComponent(`<body style="margin:0;font:16px sans-serif"><div style="height:1500px">top</div><button id=below>below</button><div style="height:600px"></div></body>`);

test("a target out of view fails with a hint, and scroll() brings it into view", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p4-"));
  demo(dir, `const demo = createDemo({ viewport: [600, 400] });\nawait demo.browser.goto(${JSON.stringify(tall)});\nawait demo.cursor.moveTo("#below");\nawait demo.cursor.click();\nawait demo.render("out.mp4");`);
  const bad = await run(["check", "s.ts"], dir);
  assert.equal(bad.code, 1);
  assert.match(bad.output, /"#below" is outside the visible part of the browser window; scroll to it first with demo\.scroll\("#below"\)[\s\S]*s\.ts:4/);
  demo(dir, `const demo = createDemo({ viewport: [600, 400] });\nawait demo.browser.goto(${JSON.stringify(tall)});\nawait demo.scroll("#below");\nawait demo.cursor.moveTo("#below");\nawait demo.cursor.click();\nawait demo.scroll({ to: 0 });\nawait demo.render("out.mp4");`);
  const good = await run(["check", "s.ts"], dir);
  assert.equal(good.code, 0, good.output);
});

test("a click fails when another window or an overlay covers its target", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p4-"));
  const page = "data:text/html," + encodeURIComponent(`<body style="margin:0"><button id=b style="position:absolute;left:560px;top:420px">b</button></body>`);
  demo(dir, `const demo = createDemo({ viewport: [800, 600] });\nawait demo.browser.goto(${JSON.stringify(page)});\nawait demo.terminal.open({ x: 400, y: 300, width: 700, height: 500 });\nawait demo.cursor.moveTo("#b", { window: "browser" });\nawait demo.cursor.click();\nawait demo.render("out.mp4");`);
  const covered = await run(["check", "s.ts"], dir);
  assert.equal(covered.code, 1);
  assert.match(covered.output, /would land on the terminal window[\s\S]*demo\.browser\.focus\(\)[\s\S]*s\.ts:6/);

  const overlay = "data:text/html," + encodeURIComponent(`<body style="margin:0"><button id=b style="margin:100px">b</button><div style="position:fixed;inset:0;background:rgba(0,0,0,.4)"></div></body>`);
  demo(dir, `const demo = createDemo({ viewport: [800, 600] });\nawait demo.browser.goto(${JSON.stringify(overlay)});\nawait demo.cursor.moveTo("#b");\nawait demo.cursor.click();\nawait demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 1);
  assert.match(r.output, /something else in the browser window covers "#b"/);
});

test("scrolling renders the same frames every time", { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p4-"));
  demo(dir, `const demo = createDemo({ viewport: [500, 320], fps: 20, theme: "bare" });\nawait demo.browser.goto(${JSON.stringify(tall)});\nawait demo.scroll({ by: 700 });\nawait demo.press("PageDown");\nawait demo.wait(300);\nawait demo.press("Home");\nawait demo.wait(300);\nawait demo.render("out/s.mp4");`);
  const hashes: string[] = [];
  for (let i = 0; i < 2; i++) {
    const r = await run(["render", "s.ts"], dir);
    assert.equal(r.code, 0, r.output);
    hashes.push(execSync(`"${ffmpeg}" -v error -i out/s.mp4 -f framemd5 -`, { cwd: dir }).toString().replace(/^#.*\n/gm, ""));
  }
  assert.equal(hashes[0], hashes[1]);
});

test("the page clock advances inside iframes", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p4-"));
  const inner = encodeURIComponent(`<script>setTimeout(() => { document.body.dataset.fired = "yes"; }, 200)</script>`);
  const outer = "data:text/html," + encodeURIComponent(`<iframe id=f src="data:text/html,${inner}"></iframe>`);
  demo(dir, `const demo = createDemo();
await demo.browser.goto(${JSON.stringify(outer)});
await demo.wait(500);
await demo.call(async ({ page }) => {
  const frame = page!.frames().find((f) => f !== page!.mainFrame());
  const fired = await frame!.evaluate(() => document.body.dataset.fired);
  if (fired !== "yes") throw new Error("iframe timer never fired");
});
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
});

test("a misspelt voice fails check at its say() line", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p4-"));
  demo(dir, `const demo = createDemo();\nawait demo.browser.goto("data:text/html,hi");\ndemo.say("Hello.", { voice: "af_hart" });\nawait demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 1);
  assert.match(r.output, /unknown voice "af_hart"[\s\S]*s\.ts:4/);
});

test("Ctrl-C during an editor check stops VS Code and leaves nothing behind", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p4-"));
  const tmp = mkdtempSync(join(tmpdir(), "rs-int-"));
  demo(dir, `const demo = createDemo();\nawait demo.editor.open({ workspace: ${JSON.stringify(acme)} });\nawait demo.wait(60000);\nawait demo.render("out.mp4");`);
  let sent = false;
  const r = await run(["render", "s.ts"], dir, { TMPDIR: tmp }, (all, child) => {
    if (!sent && /starting code-server/.test(all)) {
      sent = true;
      setTimeout(() => child.kill("SIGINT"), 4000);
    }
  });
  assert.ok(sent, r.output);
  assert.equal(r.code, 130, r.output);
  await new Promise((res) => setTimeout(res, 500));
  const left = execSync("ps -A -o command").toString().split("\n").filter((l) => l.includes(tmp));
  assert.deepEqual(left, [], "no code-server processes left");
  const leftover = readdirSync(tmp).filter((f) => f.startsWith("reelscript-editor-"));
  assert.deepEqual(leftover, [], `no temp folders left; found:\n${leftover.map((f) => execSync(`find "${join(tmp, f)}" -maxdepth 4`).toString()).join("")}\n${r.output}`);
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".partial")), [], "no partial output left");
});

test("cache: a models folder you chose can be cleared; a code-server you pointed at can't", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p4-"));
  const models = join(dir, "models");
  const kokoro = join(models, "onnx-community", "Kokoro-82M-v1.0-ONNX");
  mkdirSync(kokoro, { recursive: true });
  writeFileSync(join(kokoro, "m.onnx"), "x");
  const env = { REELSCRIPT_CACHE: join(dir, "cache"), REELSCRIPT_MODELS: models, REELSCRIPT_CODE_SERVER: "/usr/bin/true" };
  const list = await run(["cache"], dir, env);
  assert.doesNotMatch(list.output, /narration .*built in/);
  assert.equal((await run(["cache", "clear", "narration"], dir, env)).code, 0);
  assert.ok(!existsSync(kokoro), "the voice model is removed");
  assert.ok(existsSync(models), "the folder you chose stays");
  const editor = await run(["cache", "clear", "editor"], dir, env);
  assert.equal(editor.code, 1);
  assert.match(editor.output, /isn't reelscript's to clear here \(REELSCRIPT_CODE_SERVER/);
});

test("renamed options work, and the old names still do", async () => {
  const { createDemo } = await import("../src/index.js");
  const d = createDemo({ camera: { hold: 800 } });
  const events: [number, string][] = [[0, "y"]];
  d.terminal.run("x", { events, maxGap: 300 });
  d.terminal.run("x", { events, maxGapMs: 300 });
  await d.browser.goto("data:text/html,hi", { hold: 100 });
  await d.browser.goto("data:text/html,hi", { settle: 100 });
  const t = d.getTimeline();
  assert.equal((t[0] as { maxGap?: number }).maxGap, 300);
  assert.equal((t[1] as { maxGapMs?: number }).maxGapMs, 300);
});

test("clean-up registered after an interrupt began still runs before exit", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-late-"));
  const marker = join(dir, "cleaned");
  const prog = join(dir, "p.mts");
  writeFileSync(
    prog,
    `import { onInterrupt } from ${JSON.stringify(join(root, "src/cleanup.ts"))};
import { writeFileSync } from "node:fs";
onInterrupt(() => new Promise((r) => setTimeout(r, 200)));
process.on("SIGINT", () => {
  // Something finishing its start-up just after the interrupt began:
  setTimeout(() => onInterrupt(() => writeFileSync(${JSON.stringify(marker)}, "yes")), 50);
});
console.log("ready");
setInterval(() => {}, 1000);
`,
  );
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, ["--import", tsx, prog], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (d) => {
      if (String(d).includes("ready")) child.kill("SIGINT");
    });
    child.on("close", (c) => resolve(c));
  });
  assert.equal(code, 130);
  assert.ok(existsSync(marker), "the late clean-up ran");
});
