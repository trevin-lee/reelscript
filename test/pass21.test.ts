import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EDITOR_DEFAULT_SETTINGS } from "../src/editor.js";
import { asTyped } from "../src/renderer.js";

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

function demo(dir: string, body: string, file = "s.ts") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `import { createDemo } from "@reelscript/cli";\n${body}\n`);
}

test("Meta+K reaches the page as a Mac sends it, k, so a command palette opens; code in demo.call can name its helpers", { timeout: 60_000 }, async () => {
  assert.equal(asTyped("Meta+K"), "Meta+k");
  assert.equal(asTyped("Meta+Shift+K"), "Meta+Shift+K", "Shift keeps it upper case");
  assert.equal(asTyped("Enter"), "Enter");
  const dir = mkdtempSync(join(tmpdir(), "rs-p21-"));
  writeFileSync(join(dir, "p.html"), `<p id=out>-</p><script>addEventListener("keydown", (e) => { if (e.key === "k" && e.metaKey) out.textContent = "palette"; });</script>`);
  demo(dir, `import { writeFileSync } from "node:fs";
const demo = createDemo({ viewport: [400, 200] });
await demo.browser.goto("./p.html");
await demo.press("Meta+K");
await demo.waitFor("text=palette", { timeout: 3000 });
await demo.call(async ({ page }) => {
  const doubled = await page!.evaluate(() => {
    const double = (n: number) => n * 2;
    return double(21);
  });
  writeFileSync("doubled.txt", String(doubled));
});
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.equal(readFileSync(join(dir, "doubled.txt"), "utf8"), "42");
});

test("typed YAML lands as written: VS Code's own YAML settings don't turn auto-indent back on", () => {
  assert.deepEqual(EDITOR_DEFAULT_SETTINGS["[yaml]"], { "editor.autoIndent": "none" });
  assert.deepEqual(EDITOR_DEFAULT_SETTINGS["[dockercompose]"], { "editor.autoIndent": "none" });
});

test("a local page's paths from the root are its folder's, as a site's root would be", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p21-"));
  mkdirSync(join(dir, "site", "assets"), { recursive: true });
  writeFileSync(join(dir, "site", "assets", "app.css"), "h1 { color: rgb(1, 2, 3) }");
  writeFileSync(join(dir, "site", "index.html"), `<link rel=stylesheet href="/assets/app.css"><h1 id=h>Home</h1><a id=go href="/pricing.html">Pricing</a>`);
  writeFileSync(join(dir, "site", "pricing.html"), `<h1 id=p>Pricing</h1>`);
  demo(dir, `import { writeFileSync } from "node:fs";
const demo = createDemo({ viewport: [400, 200] });
await demo.browser.goto("./site/index.html");
await demo.call(async ({ page }) => writeFileSync("color.txt", await page!.evaluate(() => getComputedStyle(document.getElementById("h")!).color)));
await demo.cursor.moveTo("#go");
await demo.cursor.click();
await demo.waitFor("#p", { timeout: 3000 });
await demo.render("out.mp4");`);
  const r = await run(["check", "--strict", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.equal(readFileSync(join(dir, "color.txt"), "utf8"), "rgb(1, 2, 3)");
});

test("several scripts all run, each failure is reported, and the command says how many failed", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p21-"));
  for (const [name, target] of [["a", "#missing"], ["b", "#x"], ["c", "#missing"]]) {
    demo(dir, `const demo = createDemo();\nawait demo.browser.goto("data:text/html,<b id=x>x</b>");\nawait demo.cursor.moveTo("${target}");\nawait demo.render("out.mp4");`, `${name}.ts`);
  }
  const r = await run(["check", "a.ts", "b.ts", "c.ts"], dir);
  assert.equal(r.code, 1);
  assert.match(r.output, /a\.ts:4[\s\S]*check passed for b\.ts[\s\S]*c\.ts:4[\s\S]*^reelscript: 2 of 3 scripts failed$/m);
});

test("a voice engine that returns no audio fails at its line; clock: \"now\" is the real time", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p21-"));
  demo(dir, `const demo = createDemo({ tts: { id: "empty-" + Date.now(), synthesize: async () => ({ audio: new Float32Array(0), sampleRate: 24000 }) }, viewport: [300, 200], fps: 10, theme: "bare" });\nawait demo.browser.goto("data:text/html,hi");\ndemo.say("Hello.");\nawait demo.render("out.mp4");`);
  const empty = await run(["render", "s.ts"], dir);
  assert.equal(empty.code, 1);
  assert.match(empty.output, /returned no audio for "Hello\."[\s\S]*s\.ts:4:\d+ \(say\)/);
  demo(dir, `import { writeFileSync } from "node:fs";\nconst demo = createDemo({ clock: "now" });\nawait demo.browser.goto("data:text/html,hi");\nawait demo.call(async ({ page }) => writeFileSync("now.txt", String(await page!.evaluate(() => Date.now()))));\nawait demo.render("out.mp4");`);
  const now = await run(["check", "s.ts"], dir);
  assert.equal(now.code, 0, now.output);
  assert.ok(Math.abs(Number(readFileSync(join(dir, "now.txt"), "utf8")) - Date.now()) < 60_000, "within a minute of the real time");
});
