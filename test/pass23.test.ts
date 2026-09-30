import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { INSPECT_ELEMENTS } from "../src/mcp.js";
import { cacheDir } from "../src/tts.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");

function start(args: string[], cwd: string) {
  const child = spawn(process.execPath, ["--import", tsx, join(root, "src/cli.ts"), ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (d) => (output += d));
  child.stderr!.on("data", (d) => (output += d));
  const done = new Promise<{ code: number | null; output: string }>((resolve) => child.on("close", (code) => resolve({ code, output })));
  return { child, done, output: () => output };
}
const run = (args: string[], cwd: string) => start(args, cwd).done;

function demo(dir: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.ts"), `import { createDemo } from "@reelscript/cli";\n${body}\n`);
}

test("record interrupted part way leaves the recordings as they were", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p23-"));
  demo(dir, `const demo = createDemo();\nawait demo.terminal.open();\nawait demo.terminal.run("echo one");\nawait demo.terminal.run("sleep 3 && echo two");\nawait demo.render("out.mp4");`);
  assert.equal((await run(["record", "s.ts"], dir)).code, 0);
  const snapshot = () => Object.fromEntries(readdirSync(join(dir, "recordings")).map((f) => [f, readFileSync(join(dir, "recordings", f), "utf8")]));
  const before = snapshot();
  const again = start(["record", "s.ts"], dir);
  for (const until = Date.now() + 20_000; !/recording "sleep 3/.test(again.output()) && Date.now() < until; ) await new Promise((r) => setTimeout(r, 50));
  again.child.kill("SIGINT");
  const r = await again.done;
  assert.equal(r.code, 130, r.output);
  assert.deepEqual(snapshot(), before, "nothing overwritten");
});

test("a terminal bigger than its window says the rest is cut off", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p23-"));
  demo(dir, `const demo = createDemo({ viewport: [600, 300] });\nawait demo.terminal.open({ cols: 200, rows: 55, lineHeight: 1 });\nawait demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /warning: the terminal is 200×55, but its window shows \d+×\d+ at this font size, so the rest is cut off[\s\S]*s\.ts:3/);
});

test("inspect_page suggests one element per selector: an Edit in every row, Save beside Save draft", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<table>${["a", "b", "c"].map((r) => `<tr><td>${r}</td><td><button>Edit</button></td></tr>`).join("")}</table><button>Save</button><button>Save draft</button>`);
    const found = (await page.evaluate(INSPECT_ELEMENTS)) as { selector: string }[];
    assert.equal(found.length, 5);
    for (const f of found) assert.equal(await page.locator(f.selector).count(), 1, f.selector);
    assert.ok(found.some((f) => f.selector === 'button:text-is("Save")'));
  } finally {
    await browser.close();
  }
});

test("a click that lands on an error page is a warning at the line", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p23-"));
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/signup" ? 404 : 200, { "content-type": "text/html" });
    res.end(req.url === "/signup" ? "<h1>Not found</h1>" : `<a id=go href="/signup">Sign up</a>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    demo(dir, `const demo = createDemo({ viewport: [400, 200] });\nawait demo.browser.goto("http://127.0.0.1:${port}/");\nawait demo.cursor.moveTo("#go");\nawait demo.cursor.click();\nawait demo.wait(300);\nawait demo.render("out.mp4");`);
    const r = await run(["check", "--strict", "s.ts"], dir);
    assert.equal(r.code, 1);
    assert.match(r.output, /warning: the browser went to http:\/\/127\.0\.0\.1:\d+\/signup, which answered HTTP 404[\s\S]*s\.ts:5:\d+ \(cursor\.click\)/);
  } finally {
    server.close();
  }
});

test("an empty REELSCRIPT_CACHE is unset, not the working folder", () => {
  const before = process.env.REELSCRIPT_CACHE;
  process.env.REELSCRIPT_CACHE = "";
  try {
    assert.match(cacheDir(), /\.cache[\\/]reelscript$/);
  } finally {
    if (before === undefined) delete process.env.REELSCRIPT_CACHE;
    else process.env.REELSCRIPT_CACHE = before;
  }
});
