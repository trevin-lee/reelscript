import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");

function run(args: string[], cwd: string) {
  return new Promise<{ code: number | null; output: string; ms: number }>((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", tsx, join(root, "src/cli.ts"), ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code, output, ms: Date.now() - started }));
  });
}

function demo(dir: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.ts"), `import { createDemo } from "@reelscript/cli";\n${body}\n`);
}

const recording = (dir: string) => JSON.parse(readFileSync(join(dir, "recordings", readdirSync(join(dir, "recordings"))[0]), "utf8"));

test("record stops a command that keeps running once its output shows `until`, as meant", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p20-"));
  demo(dir, `const demo = createDemo();\nawait demo.terminal.open();\nawait demo.terminal.run("echo starting; echo ready on :3000; sleep 600", { until: "ready on", prompt: false });\nawait demo.render("out.mp4");`);
  const r = await run(["record", "--strict", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.ok(r.ms < 20_000, `stopped once ready, not at the two-minute limit: ${r.ms}ms`);
  const rec = recording(dir);
  assert.equal(rec.stoppedAtUntil, true);
  assert.match(rec.events.map((e: [number, string]) => e[1]).join(""), /ready on :3000/);
});

test("a recorded command doesn't see the settings reelscript passes itself", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p20-"));
  demo(dir, `const demo = createDemo();\nawait demo.terminal.open();\nawait demo.terminal.run("env | grep -c '^REELSCRIPT_RECORD\\\\|^REELSCRIPT_SCRIPT' || true");\nawait demo.render("out.mp4");`);
  const r = await run(["record", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.equal(recording(dir).events.map((e: [number, string]) => e[1]).join("").trim(), "0");
});

test("check --strict catches a recording of a command that failed, unless the run's exitCode says it's meant", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p20-"));
  demo(dir, `const demo = createDemo();\nawait demo.terminal.open();\nawait demo.terminal.run("sh -c 'echo broke; exit 3'");\nawait demo.render("out.mp4");`);
  assert.equal((await run(["record", "s.ts"], dir)).code, 0, "plain record saves it, with a warning");
  const strict = await run(["check", "--strict", "s.ts"], dir);
  assert.equal(strict.code, 1);
  assert.match(strict.output, /the recording of "sh -c 'echo broke; exit 3'" shows it exiting with code 3 \(give the run \{ exitCode: 3 \} if that's meant\)[\s\S]*s\.ts:4/);
  demo(dir, `const demo = createDemo();\nawait demo.terminal.open();\nawait demo.terminal.run("sh -c 'echo broke; exit 3'", { exitCode: 3 });\nawait demo.render("out.mp4");`);
  const meant = await run(["check", "--strict", "s.ts"], dir);
  assert.equal(meant.code, 0, meant.output);
});

test("scroll(selector) takes the first visible match, like every target, and warns when several are", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p20-"));
  writeFileSync(join(dir, "p.html"), `<nav style="display:none"><a>Pricing</a></nav><div style="height:2000px"></div><a id=p>Pricing</a><div style="height:600px"></div><b class=x>x</b><b class=x>x</b>`);
  demo(dir, `const demo = createDemo({ viewport: [400, 300] });\nawait demo.browser.goto("./p.html");\nawait demo.scroll("text=Pricing");\nawait demo.cursor.moveTo("#p");\nawait demo.scroll(".x");\nawait demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /warning: "\.x" matches 2 visible elements in the browser window; using the first[^\n]*\n {2}at s\.ts:6:\d+ \(scroll\)/);
});

test("MCP inspect_page says a local page isn't there", { timeout: 60_000 }, async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/cli.ts", "mcp"], cwd: root, env: process.env as Record<string, string>, stderr: "pipe" });
  const client = new Client({ name: "reelscript-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const r = await client.callTool({ name: "inspect_page", arguments: { url: "examples/nope.html", screenshot: false } });
    assert.equal(r.isError, true);
    assert.match((r.content as { text?: string }[])[0].text ?? "", /there's no page at \S*examples\/nope\.html/);
  } finally {
    await client.close();
  }
});
