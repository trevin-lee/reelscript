import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function demo(dir: string, body: string, file = "s.ts") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `import { createDemo } from "@reelscript/cli";\n${body}\n`);
}

test("Math.random is seeded, and Intl and Temporal tell the page's time", { timeout: 60_000 }, async () => {
  const epoch = Date.UTC(2025, 8, 23, 9, 41);
  const browser = await chromium.launch();
  try {
    const seen: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const ctx = await browser.newContext({ timezoneId: "UTC" });
      await ctx.addInitScript(clockShim(epoch));
      const page = await ctx.newPage();
      await page.setContent("<p>x</p>");
      seen.push(
        await page.evaluate(`[
          [Math.random(), Math.random(), Math.random()],
          new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(),
          new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).formatToParts().map((p) => p.value).join(""),
          typeof Temporal === "undefined" ? "2025-09-23" : String(Temporal.Now.plainDateISO("UTC")),
        ]`),
      );
      await ctx.close();
    }
    assert.deepEqual(seen[0], seen[1], "the same random numbers on every page load");
    const [, intl, parts, temporal] = seen[0] as [number[], string, string, string];
    assert.deepEqual([intl, parts, temporal], ["Sep 23, 2025", "9/23/2025", "2025-09-23"]);
  } finally {
    await browser.close();
  }
});

test("editor.type() after clicking a file in the Explorer types into the file; with none open it fails", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p13-"));
  mkdirSync(join(dir, "ws"), { recursive: true });
  writeFileSync(join(dir, "ws", "app.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "ws", "server.ts"), "export const s = 2;\n");
  demo(dir, `import { writeFileSync } from "node:fs";
const demo = createDemo({ viewport: [1000, 640] });
await demo.editor.open({ workspace: "ws" });
await demo.cursor.moveTo(demo.editor.file("app.ts"));
await demo.cursor.click();
await demo.editor.type("ZZZ");
// VS Code redraws on its own real clock, a moment after the keys land: wait for the text (it never comes if the keys went to the Explorer).
await demo.call(async ({ page }) => {
  let text = "";
  for (const until = Date.now() + 3000; Date.now() < until && !text.startsWith("ZZZ"); await new Promise((r) => setTimeout(r, 50))) {
    text = (await page!.evaluate(() => document.querySelector(".monaco-editor .view-lines")?.textContent ?? "")).replace(/[\u200b-\u200d\u00a0]/g, " ");
  }
  writeFileSync("text.txt", text);
});
await demo.render("out.mp4");`);
  const typed = await run(["check", "s.ts"], dir);
  assert.equal(typed.code, 0, typed.output);
  assert.match(readFileSync(join(dir, "text.txt"), "utf8"), /^ZZZexport const a/, "into app.ts, not the Explorer (where s would select server.ts)");
  demo(dir, `const demo = createDemo({ viewport: [1000, 640] });\nawait demo.editor.open({ workspace: "ws" });\nawait demo.editor.type("hello");\nawait demo.render("out.mp4");`, "none.ts");
  const none = await run(["check", "none.ts"], dir);
  assert.equal(none.code, 1);
  assert.match(none.output, /editor\.type\(\) has nowhere to type: no file is open[\s\S]*none\.ts:4:\d+ \(type\)/);
});

test("the browser is Chrome on a Mac on every host", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p13-"));
  writeFileSync(join(dir, "p.html"), "<p>hi</p>");
  demo(dir, `import { writeFileSync } from "node:fs";
const demo = createDemo({ viewport: [400, 300] });
await demo.browser.goto("./p.html");
await demo.call(async ({ page }) => writeFileSync("ua.json", JSON.stringify(await page!.evaluate(\`(async () => [navigator.userAgent, navigator.platform, navigator.userAgentData?.platform, (await navigator.userAgentData?.getHighEntropyValues(["platform"]))?.platform])()\`))));
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  const [ua, platform, uaPlatform, highPlatform] = JSON.parse(readFileSync(join(dir, "ua.json"), "utf8"));
  assert.match(ua, /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\) .* Chrome\/\d+\.0\.0\.0 Safari/);
  assert.doesNotMatch(ua, /Headless/);
  assert.equal(platform, "MacIntel");
  if (uaPlatform !== undefined) assert.deepEqual([uaPlatform, highPlatform], ["macOS", "macOS"]);
});

test("a misspelt option name fails where it's written, with the name it's probably meant to be", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p13-"));
  demo(dir, `const demo = createDemo({ viewPort: [640, 400] } as never);\nawait demo.render("out.mp4");`);
  const create = await run(["check", "s.ts"], dir);
  assert.equal(create.code, 1);
  assert.match(create.output, /unknown option "viewPort" \(did you mean "viewport"\?\)[\s\S]*s\.ts:2:\d+ \(createDemo\)/);
  demo(dir, `const demo = createDemo();\nawait demo.browser.goto("data:text/html,<b id=r>r</b>");\nawait demo.cursor.moveTo("#r", { ease: "snappy", duraton: 3000 } as never);\nawait demo.render("out.mp4");`);
  const move = await run(["check", "s.ts"], dir);
  assert.equal(move.code, 1);
  assert.match(move.output, /unknown option "duraton" \(did you mean "duration"\?\)[\s\S]*s\.ts:4:\d+ \(cursor\.moveTo\)/);
});

test("opening an open terminal starts it over with what's given, its font included", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p13-"));
  demo(dir, `import { writeFileSync } from "node:fs";
const demo = createDemo({ viewport: [700, 400] });
const sizes: string[] = [];
const measure = () => demo.call(async ({ page }) => { sizes.push(await page!.evaluate(() => getComputedStyle(document.querySelector(".xterm-rows")!).fontSize)); });
await demo.terminal.open({ fontSize: 12 });
await measure();
await demo.terminal.open({ fontSize: 28 });
await measure();
await demo.call(() => writeFileSync("sizes.json", JSON.stringify(sizes)));
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "sizes.json"), "utf8")), ["12px", "28px"]);
});

test("a voice engine of your own has its own default voice", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p13-"));
  demo(dir, `import { appendFileSync } from "node:fs";
const silence = (voice?: string) => { appendFileSync("voices.txt", String(voice) + "\\n"); return { audio: new Float32Array(2400), sampleRate: 24000 }; };
const listed = { id: "listed-" + Date.now(), voices: ["nova", "onyx"], synthesize: async (_t: string, o: { voice?: string }) => silence(o.voice) };
const open = { id: "open-" + Date.now(), synthesize: async (_t: string, o: { voice?: string }) => silence(o.voice) };
for (const tts of [listed, open]) {
  const demo = createDemo({ tts, viewport: [300, 200], fps: 10, theme: "bare" });
  await demo.browser.goto("data:text/html,hi");
  demo.say("Hello.");
  await demo.waitForNarration();
  await demo.render("out.mp4");
}`);
  const r = await run(["render", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.doesNotMatch(r.output, /af_heart/);
  assert.deepEqual(readFileSync(join(dir, "voices.txt"), "utf8").trim().split("\n"), ["nova", "undefined"], "its first voice, or none for it to choose");
});

test("goto('/path') is a page on the site the browser is showing; with no site it says so", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p13-"));
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/pricing" ? "<h1 id=pricing>Pricing</h1>" : "<h1>Home</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    demo(dir, `const demo = createDemo({ viewport: [400, 300] });\nawait demo.browser.goto("http://127.0.0.1:${port}/");\nawait demo.browser.goto("/pricing");\nawait demo.waitFor("#pricing", { timeout: 5000 });\nawait demo.render("out.mp4");`);
    const onSite = await run(["check", "s.ts"], dir);
    assert.equal(onSite.code, 0, onSite.output);
    demo(dir, `const demo = createDemo({ viewport: [400, 300] });\nawait demo.browser.goto("/app.html");\nawait demo.render("out.mp4");`);
    const noSite = await run(["check", "s.ts"], dir);
    assert.equal(noSite.code, 1);
    assert.match(noSite.output, /goto\("\/app\.html"\): a path from the root is a page on the website the browser is showing[\s\S]*"\.\/app\.html"[\s\S]*s\.ts:3:\d+/);
  } finally {
    server.close();
  }
});
