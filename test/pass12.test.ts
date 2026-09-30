import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { INSPECT_ELEMENTS } from "../src/mcp.js";
import { createDemo } from "../src/index.js";

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

test("inspect_page suggests selectors that find text fields, and never shows what's typed in them", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<input placeholder="Search projects"><label>Notes <textarea></textarea></label><input type=password placeholder="Password" value="hunter2"><button>Go</button>`);
    const found = (await page.evaluate(INSPECT_ELEMENTS)) as { tag: string; selector: string; label: string }[];
    assert.doesNotMatch(JSON.stringify(found), /hunter2/, "no password in the output");
    const selectors = found.map((e) => e.selector);
    assert.deepEqual([...selectors].sort(), ['button:text-is("Go")', 'input[placeholder="Password"]', 'input[placeholder="Search projects"]', 'label:has-text("Notes") >> textarea']);
    for (const s of selectors) assert.equal(await page.locator(s).count(), 1, `${s} finds its element`);
  } finally {
    await browser.close();
  }
});

test("a script without top-level await runs in a project that isn't an ES module one", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p12-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cjs", version: "1.0.0" }));
  demo(dir, `async function main() {\n  const demo = createDemo({ viewport: [300, 200] });\n  await demo.browser.goto("data:text/html,hi");\n  await demo.render("out.mp4");\n}\nmain();`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /check passed for s\.ts/);
});

test("record --prune with a script that has no terminal commands", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p12-"));
  demo(dir, `const demo = createDemo();\nawait demo.browser.goto("data:text/html,hi");\nawait demo.render("out.mp4");`);
  const r = await run(["record", "s.ts", "--prune"], dir);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /pruned 0 unused recordings/);
});

test("mockAPI takes a path for any origin and query, and warns about a mock nothing asked for", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p12-"));
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<p id=out>loading</p><script>fetch("/api/projects?page=2").then((r) => r.json()).then((j) => { out.textContent = j.name; });</script>`);
    } else {
      res.writeHead(500);
      res.end("{}"); // the live backend, which the demo mustn't see
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    demo(dir, `const demo = createDemo({ viewport: [300, 200] });
demo.browser.mockAPI("/api/projects", { name: "Mocked" });
demo.browser.mockAPI("/api/never", {});
await demo.browser.goto("http://127.0.0.1:${port}/");
await demo.waitFor("text=Mocked", { timeout: 5000 });
await demo.render("out.mp4");`);
    const r = await run(["check", "s.ts"], dir);
    assert.equal(r.code, 0, r.output);
    assert.equal(r.output.match(/warning: mockAPI\("\/api\/never"\) never matched a request/g)?.length, 1, r.output);
    assert.match(r.output, /never matched a request[^\n]*\n {2}at s\.ts:4:\d+ \(browser\.mockAPI\)/);
    assert.doesNotMatch(r.output, /mockAPI\("\/api\/projects"\) never matched/);
  } finally {
    server.close();
  }
});

test("the CLI names a missing script, part or value instead of silently doing something else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p12-"));
  demo(dir, `const demo = createDemo();\nawait demo.render("out.mp4");`);
  for (const [args, message] of [
    [["render"], /^reelscript: render needs a script$/m],
    [["cache", "foo"], /^reelscript: unknown cache command "foo"/m],
    [["cache", "clear"], /^reelscript: cache clear needs a part: .*editor.*, or all$/m],
    [["render", "s.ts", "--out"], /^reelscript: --out needs a value$/m],
    [["preview", "s.ts", "--at"], /^reelscript: --at needs a value$/m],
    [["record", "s.ts", "--prune=no"], /^reelscript: --prune takes no value$/m],
  ] as const) {
    const r = await run([...args], dir);
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.output}`);
    assert.match(r.output, message);
  }
});

test("a terminal can fix only its columns, or only its rows", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p12-"));
  demo(dir, `import { writeFileSync } from "node:fs";
const demo = createDemo({ viewport: [900, 500] });
await demo.terminal.open({ cols: 60 });
await demo.call(async ({ page }) => writeFileSync("dims.json", JSON.stringify(await page!.evaluate(() => { const t = (window as any).__rsTerm; return [t.cols, t.rows]; }))));
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  const [cols, rows] = JSON.parse(readFileSync(join(dir, "dims.json"), "utf8"));
  assert.equal(cols, 60);
  assert.ok(rows > 10, `rows still fit the window: ${rows}`);
});

test("check fails when the voice engine can't run for a line render would synthesize", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p12-"));
  demo(dir, `const demo = createDemo({ tts: { id: "broken", voices: ["v"], synthesize: async () => { throw new Error("unreachable"); }, ready: async () => { throw new Error("reelscript: this engine isn't installed"); } }, voice: "v" });
await demo.browser.goto("data:text/html,hi");
demo.say("Hello there.");
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /this engine isn't installed[\s\S]*s\.ts:4:\d+ \(say\)/);
});

test("editor.file() finds a folder with a space in its name", () => {
  const selector = createDemo().editor.file("My Folder/app.ts");
  assert.equal(selector, `.explorer-folders-view .monaco-list-row[aria-label="app.ts"]:has([class~="my"][class~="folder-name-dir-icon"])`);
});
