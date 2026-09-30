import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { macShortcut } from "../src/macKeys.js";

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

test("editing shortcuts in a page's fields do what they do on a Mac, on every host", { timeout: 60_000 }, async () => {
  assert.deepEqual(macShortcut("Meta+A")?.commands, ["selectAll"]);
  assert.deepEqual(macShortcut("Alt+ArrowLeft")?.commands, ["moveWordLeft"]);
  assert.equal(macShortcut("Meta+K"), null, "not an editing shortcut: sent as it is");
  const dir = mkdtempSync(join(tmpdir(), "rs-p16-"));
  writeFileSync(join(dir, "p.html"), `<input id=f value="hello world">`);
  demo(dir, `import { writeFileSync } from "node:fs";
const demo = createDemo({ viewport: [400, 200] });
await demo.browser.goto("./p.html");
await demo.cursor.moveTo("#f");
await demo.cursor.click();
await demo.press("Meta+A");
await demo.type("#f", "X");
await demo.press("Alt+ArrowLeft");
await demo.type("#f", "Y");
await demo.call(async ({ page }) => writeFileSync("value.txt", await page!.inputValue("#f")));
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.equal(readFileSync(join(dir, "value.txt"), "utf8"), "YX", "select all, replaced; then a word back");
});

test("scroll(selector) brings a card in a sideways rail into view", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p16-"));
  const cards = Array.from({ length: 20 }, (_, i) => `<div id=c${i} style="flex:0 0 120px;height:80px;background:#ddd">card ${i}</div>`).join("");
  writeFileSync(join(dir, "p.html"), `<div id=rail style="display:flex;gap:10px;overflow-x:auto;width:380px">${cards}</div>`);
  demo(dir, `const demo = createDemo({ viewport: [400, 200] });\nawait demo.browser.goto("./p.html");\nawait demo.scroll("#c15");\nawait demo.cursor.moveTo("#c15");\nawait demo.cursor.click();\nawait demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
});

test("record runs a command at the size of the terminal the script fixes", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p16-"));
  demo(dir, `const demo = createDemo();\nawait demo.terminal.open({ cols: 50, rows: 12 });\nawait demo.terminal.run("echo $COLUMNS x $LINES");\nawait demo.render("out.mp4");`);
  const r = await run(["record", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  const rec = JSON.parse(readFileSync(join(dir, "recordings", readdirSync(join(dir, "recordings"))[0]), "utf8"));
  assert.match(rec.events.map((e: [number, string]) => e[1]).join(""), /50 x 12/);
});

test("check --strict fails a run that had warnings; without it they're only printed", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p16-"));
  demo(dir, `const demo = createDemo({ viewport: [300, 200] });\ndemo.browser.mockAPI("/api/never", {});\nawait demo.browser.goto("data:text/html,hi");\nawait demo.render("out.mp4");`);
  const plain = await run(["check", "s.ts"], dir);
  assert.equal(plain.code, 0, plain.output);
  assert.match(plain.output, /warning: mockAPI\("\/api\/never"\) never matched/);
  const strict = await run(["check", "--strict", "s.ts"], dir);
  assert.equal(strict.code, 1);
  assert.match(strict.output, /^reelscript: 1 warning above, and --strict makes a run with warnings fail$/m);
});

test("warmup refuses a misspelt part before downloading anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p16-"));
  const r = await run(["warmup", "narration", "narraton"], dir);
  assert.equal(r.code, 1);
  assert.match(r.output, /unknown warmup part "narraton" \(browser, narration, editor\)/);
  assert.doesNotMatch(r.output, /ready/, "nothing warmed up first");
});
