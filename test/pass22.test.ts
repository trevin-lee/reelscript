import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

test("a goto nothing answers says so, and in the container what localhost is", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p22-"));
  demo(dir, `const demo = createDemo();\nawait demo.browser.goto("http://localhost:39999");\nawait demo.render("out.mp4");`);
  const here = await run(["check", "s.ts"], dir);
  assert.equal(here.code, 1);
  assert.match(here.output, /goto\("http:\/\/localhost:39999"\): nothing is answering at localhost:39999\. Is the app running\?\n {2}at s\.ts:3:\d+ \(browser\.goto\)/);
  const container = await run(["check", "s.ts"], dir, { REELSCRIPT_BUILTIN: "/opt/reelscript/builtin" });
  assert.match(container.output, /In the container, localhost is the container itself: reach an app on your machine at host\.docker\.internal/);
});

test("typing while the terminal has focus says how to name the field's window", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p22-"));
  demo(dir, `const demo = createDemo();\nawait demo.browser.goto("data:text/html,<input id=f>");\nawait demo.terminal.open();\nawait demo.type("#f", "hi");\nawait demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 1);
  assert.match(r.output, /name the window the field is in: demo\.type\(target, text, \{ window: "browser" \}\)[\s\S]*s\.ts:5/);
});
