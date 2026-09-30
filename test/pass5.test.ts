import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordCommand } from "../src/terminal.js";

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

function demo(dir: string, body: string, name = "s.ts") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `import { createDemo } from "@reelscript/cli";\n${body}\n`);
}

test("a command run twice, or in two folders, gets its own recording each time", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p5-"));
  mkdirSync(join(dir, "a"));
  mkdirSync(join(dir, "b"));
  writeFileSync(join(dir, "a", "in-a.txt"), "");
  writeFileSync(join(dir, "b", "in-b.txt"), "");
  demo(dir, `const demo = createDemo();
await demo.terminal.open();
await demo.terminal.run("ls");
await demo.terminal.run("touch new-file.txt");
await demo.terminal.run("ls");
await demo.terminal.run("ls", { cwd: "a" });
await demo.terminal.run("ls", { cwd: "b" });
await demo.render("out.mp4");`);
  const r = await run(["record", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  const recs = readdirSync(join(dir, "recordings")).map((f) => JSON.parse(readFileSync(join(dir, "recordings", f), "utf8")));
  assert.equal(recs.length, 5, "one recording per run");
  const outputs = recs.filter((x) => x.command === "ls").map((x) => x.events.map((e: [number, string]) => e[1]).join(""));
  assert.equal(outputs.filter((o) => o.includes("new-file.txt")).length, 1, "only the second ls sees the new file");
  assert.ok(outputs.some((o) => o.includes("in-a.txt")) && outputs.some((o) => o.includes("in-b.txt")));
  // and replay picks each one: check passes with every recording present
  assert.equal((await run(["check", "s.ts"], dir)).code, 0);
});

test("record's time limit stops everything the command started", { timeout: 30_000 }, async () => {
  const started = Date.now();
  const rec = await recordCommand(`cd . && node -e "console.log('up'); setInterval(() => {}, 1000)"`, { timeoutMs: 1500 });
  assert.ok(rec.timedOut);
  assert.ok(Date.now() - started < 6000, `took ${Date.now() - started}ms`);
  const rec2 = await recordCommand("echo start; sleep 20", { timeoutMs: 1500 });
  assert.ok(rec2.timedOut && Date.now() - started < 12_000);
});

test("check rejects what render would: the demo's voice, a custom engine's voices, the output format", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p5-"));
  demo(dir, `const demo = createDemo({ voice: "af_bela" });\nawait demo.browser.goto("data:text/html,hi");\ndemo.say("Hi.");\nawait demo.render("out.mp4");`);
  const voice = await run(["check", "s.ts"], dir);
  assert.equal(voice.code, 1);
  assert.match(voice.output, /unknown voice "af_bela"/);

  demo(dir, `const tts = { id: "mine", voices: ["nova"], async synthesize() { return { audio: new Float32Array(2400), sampleRate: 24000 }; } };
const demo = createDemo({ tts });\nawait demo.browser.goto("data:text/html,hi");\ndemo.say("Hi.", { voice: "nova" });\nawait demo.render("out.mp4");`);
  const custom = await run(["check", "s.ts"], dir);
  assert.equal(custom.code, 0, custom.output);

  demo(dir, `const demo = createDemo();\nawait demo.browser.goto("data:text/html,hi");\nawait demo.render("out/demo.mov");`);
  const mov = await run(["check", "s.ts"], dir);
  assert.equal(mov.code, 1);
  assert.match(mov.output, /can't render to .*demo\.mov/);
});

test("scroll() says it's for web pages when aimed at the terminal", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p5-"));
  demo(dir, `const demo = createDemo();\nawait demo.terminal.open();\nawait demo.scroll({ by: 500 });\nawait demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 1);
  assert.match(r.output, /demo\.scroll\(\) scrolls web pages[\s\S]*s\.ts:4/);
});

test("cache clear narration removes only the voice model from a folder you chose", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p5-"));
  const models = join(dir, "models");
  mkdirSync(join(models, "onnx-community", "Kokoro-82M-v1.0-ONNX"), { recursive: true });
  writeFileSync(join(models, "onnx-community", "Kokoro-82M-v1.0-ONNX", "model.onnx"), "x");
  mkdirSync(join(models, "other-project"));
  writeFileSync(join(models, "other-project", "weights.bin"), "keep me");
  const r = await run(["cache", "clear", "all"], dir, { REELSCRIPT_CACHE: join(dir, "cache"), REELSCRIPT_MODELS: models });
  assert.equal(r.code, 0, r.output);
  assert.ok(!existsSync(join(models, "onnx-community", "Kokoro-82M-v1.0-ONNX")));
  assert.ok(existsSync(join(models, "other-project", "weights.bin")), "unrelated files are kept");
});

test("the CLI is strict about arguments and renders every script it's given", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p5-"));
  for (const n of ["a", "b"]) demo(dir, `const demo = createDemo({ viewport: [300, 200], fps: 10 });\nawait demo.browser.goto("data:text/html,${n}");\nawait demo.render("out/${n}.mp4");`, `${n}.ts`);
  const both = await run(["render", "a.ts", "b.ts"], dir);
  assert.equal(both.code, 0, both.output);
  assert.ok(existsSync(join(dir, "out/a.mp4")) && existsSync(join(dir, "out/b.mp4")));
  const unknown = await run(["render", "a.ts", "--output", "x.mp4"], dir);
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /render has no --output option \(it takes --out, --strict\)/);
  const outTwo = await run(["render", "a.ts", "b.ts", "--out", "x.mp4"], dir);
  assert.equal(outTwo.code, 1);
  const help = await run(["render", "a.ts", "--help"], dir);
  assert.equal(help.code, 0);
  assert.match(help.output, /usage:/);
  const jpg = await run(["preview", "a.ts", "--out", "f.jpg"], dir);
  assert.equal(jpg.code, 1);
});
