import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Scripts run from temporary folders, so load tsx from the repo, not the working directory.
const tsx = import.meta.resolve("tsx");
const acme = join(root, "examples/acme");

function cli(args: string[], cwd: string) {
  return new Promise<{ code: number | null; output: string; ms: number }>((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", tsx, join(root, "src/cli.ts"), ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code, output, ms: Date.now() - started }));
  });
}

function script(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `import { createDemo } from "@reelscript/cli";\n${body}\n`);
  return file;
}

test("a script that never calls render() fails instead of passing silently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-cli-"));
  script(dir, "s.ts", `const demo = createDemo();\nawait demo.browser.goto("data:text/html,hi");`);
  const r = await cli(["check", "s.ts"], dir);
  assert.equal(r.code, 1);
  assert.match(r.output, /finished without calling demo\.render\(\)/);
});

test("render output is relative to the script, and the process exits promptly", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-cli-"));
  script(join(dir, "demos"), "s.ts", `const demo = createDemo({ viewport: [400, 300], fps: 10 });\nawait demo.browser.goto("data:text/html,hi");\nawait demo.render("out/s.mp4");`);
  const r = await cli(["render", "demos/s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.ok(existsSync(join(dir, "demos/out/s.mp4")), "written beside the script");
  assert.ok(!existsSync(join(dir, "out")), "not relative to the working directory");
  const rendered = Number(/rendered in ([\d.]+)s/.exec(r.output)?.[1]) * 1000;
  assert.ok(r.ms - rendered < 5000, `exited ${r.ms - rendered}ms after rendering`);
});

test("a missing terminal recording names the script line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-cli-"));
  script(dir, "s.ts", `const demo = createDemo();\nawait demo.terminal.open();\nawait demo.terminal.run("echo never-recorded");\nawait demo.render("out.mp4");`);
  const r = await cli(["check", "s.ts"], dir);
  assert.equal(r.code, 1);
  assert.match(r.output, /no recording for terminal command "echo never-recorded"[\s\S]*s\.ts:4/);
});

test("check fails when Quick Open or the Command Palette can't find what the script typed", { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-cli-"));
  const run = (step: string) => {
    script(dir, "s.ts", `const demo = createDemo({ viewport: [1000, 640], fps: 30 });\nawait demo.editor.open({ workspace: ${JSON.stringify(acme)} });\nawait demo.editor.${step};\nawait demo.render("out.mp4");`);
    return cli(["check", "s.ts"], dir);
  };
  const goodFile = await run(`openFile("app.ts")`);
  assert.equal(goodFile.code, 0, goodFile.output);
  const badFile = await run(`openFile("no-such-file.ts")`);
  assert.equal(badFile.code, 1);
  assert.match(badFile.output, /Quick Open found no file matching "no-such-file\.ts"[\s\S]*s\.ts:4/);
  const badCommand = await run(`command("Acme: A Command That Was Renamed")`);
  assert.equal(badCommand.code, 1);
  assert.match(badCommand.output, /Command Palette has no command matching/);
});
