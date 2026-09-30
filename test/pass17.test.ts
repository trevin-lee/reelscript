import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { INSPECT_ELEMENTS } from "../src/mcp.js";

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

// A dialog closed the usual way: faded all the way out, still laid out.
const MODAL = `<button id=open onclick="modal.style.opacity = 1">New</button><div id=modal style="opacity:0"><input id=name placeholder="Project name"><button id=create>Create</button></div>`;

test("an element inside something faded all the way out isn't a target, and inspect_page doesn't list it", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p17-"));
  writeFileSync(join(dir, "p.html"), MODAL);
  demo(dir, `const demo = createDemo({ viewport: [400, 200] });\nawait demo.browser.goto("./p.html");\nawait demo.cursor.moveTo("#name");\nawait demo.render("out.mp4");`);
  const closed = await run(["check", "s.ts"], dir);
  assert.equal(closed.code, 1);
  assert.match(closed.output, /target "#name" was not found or never became visible[\s\S]*s\.ts:4/);
  demo(dir, `const demo = createDemo({ viewport: [400, 200] });\nawait demo.browser.goto("./p.html");\nawait demo.cursor.moveTo("#open");\nawait demo.cursor.click();\nawait demo.waitFor("#name", { timeout: 3000 });\nawait demo.type("#name", "Q3");\nawait demo.render("out.mp4");`);
  const opened = await run(["check", "s.ts"], dir);
  assert.equal(opened.code, 0, opened.output);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(MODAL);
    const listed = ((await page.evaluate(INSPECT_ELEMENTS)) as { selector: string }[]).map((e) => e.selector);
    assert.deepEqual(listed, ["#open"]);
  } finally {
    await browser.close();
  }
});

test("typing into a field that can't take the keyboard fails, saying why", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p17-"));
  writeFileSync(join(dir, "p.html"), `<input id=email><input id=name disabled><input id=ro readonly value=x><p id=box>text</p>`);
  for (const [target, why] of [["#name", "it's disabled"], ["#ro", "it's read-only"], ["#box", "it can't take the keyboard \\(it isn't a text field\\)"]]) {
    demo(dir, `const demo = createDemo({ viewport: [500, 200] });\nawait demo.browser.goto("./p.html");\nawait demo.type("#email", "ada@example.com");\nawait demo.type("${target}", "Ada");\nawait demo.render("out.mp4");`);
    const r = await run(["check", "s.ts"], dir);
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, new RegExp(`can't type into "${target}": ${why}[\\s\\S]*s\\.ts:5`));
  }
});

test("a cookie the page sets to expire in 30 days, by its pinned date, is kept", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p17-"));
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<button id=ok onclick="document.cookie = 'consent=yes; expires=' + new Date(Date.now() + 30 * 864e5).toUTCString(); out.textContent = document.cookie">Accept</button><p id=out>-</p>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    demo(dir, `const demo = createDemo({ viewport: [400, 200] });\nawait demo.browser.goto("http://127.0.0.1:${port}/");\nawait demo.cursor.moveTo("#ok");\nawait demo.cursor.click();\nawait demo.waitFor("text=consent=yes", { timeout: 3000 });\nawait demo.render("out.mp4");`);
    const r = await run(["check", "s.ts"], dir);
    assert.equal(r.code, 0, r.output);
  } finally {
    server.close();
  }
});

test("render --strict with warnings fails and leaves the previous video in place", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p17-"));
  demo(dir, `const demo = createDemo({ viewport: [300, 200], fps: 10, theme: "bare" });\nawait demo.browser.goto("data:text/html,hi");\nawait demo.render("out.mp4");`);
  assert.equal((await run(["render", "s.ts"], dir)).code, 0);
  const before = readFileSync(join(dir, "out.mp4"));
  const mtime = statSync(join(dir, "out.mp4")).mtimeMs;
  demo(dir, `const demo = createDemo({ viewport: [300, 200], fps: 10, theme: "bare" });\ndemo.browser.mockAPI("/api/never", {});\nawait demo.browser.goto("data:text/html,changed");\nawait demo.render("out.mp4");`);
  const strict = await run(["render", "--strict", "s.ts"], dir);
  assert.equal(strict.code, 1);
  assert.match(strict.output, /1 warning above, and --strict makes a render with warnings fail; \S*out\.mp4 is unchanged/);
  assert.equal(statSync(join(dir, "out.mp4")).mtimeMs, mtime);
  assert.ok(readFileSync(join(dir, "out.mp4")).equals(before));
});
