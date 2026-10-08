import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPronunciations } from "../src/tts.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", tsx, join(root, "src/cli.ts"), ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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

test("demo.check() is a run for reelscript check only; render, preview and record need demo.render()", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p15-"));
  demo(dir, `const demo = createDemo({ viewport: [300, 200] });\nawait demo.browser.goto("data:text/html,hi");\nawait demo.check();`);
  assert.equal((await run(["check", "s.ts"], dir)).code, 0);
  for (const args of [["render", "s.ts", "--out", "o.mp4"], ["preview", "s.ts", "--out", "o.png"], ["record", "s.ts"]]) {
    const r = await run(args, dir);
    assert.equal(r.code, 1, `${args[0]}: ${r.output}`);
    assert.match(r.output, /demo\.check\(\) only checks, and this isn't reelscript check; end the script with demo\.render\(path\)[\s\S]*s\.ts:4/);
  }
  assert.ok(!existsSync(join(dir, "o.mp4")) && !existsSync(join(dir, "o.png")));
});

test("a script that renders twice records each command once, and can't share one --out", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p15-"));
  demo(dir, `const demo = createDemo({ viewport: [300, 200], fps: 10 });\nawait demo.terminal.open();\nawait demo.terminal.run("echo run >> runs.log");\nawait demo.render("out.mp4");\nawait demo.render("out.gif");`);
  const r = await run(["record", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.equal(readFileSync(join(dir, "runs.log"), "utf8"), "run\n", "the command ran once");
  const out = await run(["render", "s.ts", "--out", "x.mp4"], dir);
  assert.equal(out.code, 1, out.output);
  assert.match(out.output, /calls render\(\) more than once, and --out names one video[\s\S]*s\.ts:6:\d+ \(render\)/);
});

test("the output format is refused before narration is synthesized", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p15-"));
  demo(dir, `const demo = createDemo({ tts: { id: "slow", synthesize: async () => { throw new Error("synthesized first"); } } });\nawait demo.browser.goto("data:text/html,hi");\ndemo.say("Hello.");\nawait demo.render("out/x.mov");`);
  const r = await run(["render", "s.ts"], dir);
  assert.equal(r.code, 1);
  assert.match(r.output, /can't render to .*x\.mov/);
  assert.doesNotMatch(r.output, /synthesized first/);
});

test("misspelt names inside camera, menubar and gif fail too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p15-"));
  for (const [options, message] of [
    ["{ camera: { scal: 2 } }", /camera: unknown option "scal" \(did you mean "scale"\?\)/],
    ["{ menubar: { clok: \"9:41\" } as never }", /menubar: unknown option "clok" \(did you mean "clock"\?\)/],
    ["{ gif: { widht: 500 } as never }", /gif: unknown option "widht" \(did you mean "width"\?\)/],
  ] as const) {
    demo(dir, `const demo = createDemo(${options});\nawait demo.render("out.mp4");`);
    const r = await run(["check", "s.ts"], dir);
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, message);
  }
});

test("scroll({ by }) and scroll({ to }) move an app's own scrolling area when the page itself doesn't scroll", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p15-"));
  const rows = Array.from({ length: 60 }, (_, i) => `<p id=r${i} style="height:40px;margin:0">row ${i}</p>`).join("");
  writeFileSync(join(dir, "p.html"), `<body style="margin:0;height:100vh;overflow:hidden"><nav style="height:40px">app</nav><main id=main style="height:calc(100vh - 40px);overflow:auto">${rows}</main></body>`);
  demo(dir, `import { appendFileSync } from "node:fs";
const demo = createDemo({ viewport: [400, 300] });
const top = () => demo.call(async ({ page }) => appendFileSync("tops.txt", (await page!.evaluate(() => document.getElementById("main")!.scrollTop)) + "\\n"));
await demo.browser.goto("./p.html");
await demo.scroll({ by: 600 });
await top();
await demo.scroll("#r50");
await top();
await demo.scroll({ to: 0 });
await top();
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  const [by, toRow, toTop] = readFileSync(join(dir, "tops.txt"), "utf8").trim().split("\n").map(Number);
  assert.equal(by, 600);
  assert.ok(toRow > 1500, `scrolled to row 50: ${toRow}`);
  assert.equal(toTop, 0);
  writeFileSync(join(dir, "flat.html"), "<p>nothing scrolls</p>");
  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\nawait demo.browser.goto("./flat.html");\nawait demo.scroll({ by: 600 });\nawait demo.render("out.mp4");`);
  const flat = await run(["check", "s.ts"], dir);
  assert.equal(flat.code, 1);
  assert.match(flat.output, /found nothing on the page that scrolls[\s\S]*s\.ts:4/);
});

test("cache clear takes several parts, and refuses a misspelt one before removing anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p15-"));
  const cache = join(dir, "cache");
  for (const part of ["tts", "extensions"]) {
    mkdirSync(join(cache, part), { recursive: true });
    writeFileSync(join(cache, part, "x"), "x");
  }
  const env = { REELSCRIPT_CACHE: cache };
  const bad = await run(["cache", "clear", "extensions", "bogus"], dir, env);
  assert.equal(bad.code, 1);
  assert.match(bad.output, /unknown cache part "bogus"/);
  assert.ok(existsSync(join(cache, "extensions", "x")), "nothing removed");
  const both = await run(["cache", "clear", "narration-clips", "extensions"], dir, env);
  assert.equal(both.code, 0, both.output);
  assert.ok(!existsSync(join(cache, "tts")) && !existsSync(join(cache, "extensions")));
});

test("login names a missing web address; pronunciations respell whole words", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p15-"));
  const r = await run(["login", "./app.html"], dir);
  assert.equal(r.code, 1);
  assert.match(r.output, /^reelscript: login takes the web address of your app's sign-in page, like https:\/\/app\.example\.com\/login, not "\.\/app\.html"$/m);
  assert.equal(applyPronunciations("PostgreSQL speaks SQL.", { SQL: "sequel" }), "PostgreSQL speaks sequel.");
  assert.equal(applyPronunciations("Reelscript's clock", { Reelscript: "Reel script" }), "Reel script's clock");
});
