import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Scripts run from temporary folders, so load tsx from the repo, not the working directory.
const tsx = import.meta.resolve("tsx");
const acme = join(root, "examples/acme");

function cli(args: string[], cwd: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; output: string; ms: number; afterRender: number }>((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", tsx, join(root, "src/cli.ts"), ...args], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let renderedAt = 0; // when "rendered in" was printed: start-up time (slow on a cold install) isn't exit time
    const seen = (d: Buffer) => {
      output += d;
      if (!renderedAt && /rendered in/.test(output)) renderedAt = Date.now();
    };
    child.stdout!.on("data", seen);
    child.stderr!.on("data", seen);
    child.on("close", (code) => resolve({ code, output, ms: Date.now() - started, afterRender: renderedAt ? Date.now() - renderedAt : NaN }));
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
  assert.ok(r.afterRender < 5000, `exited ${r.afterRender}ms after rendering`);
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
  assert.match(badFile.output, /Quick Open found no file named "no-such-file\.ts"[\s\S]*s\.ts:4/);
  // VS Code's fuzzy search offers src/app.ts for "pp.ts"; that isn't the file asked for.
  const nearFile = await run(`openFile("pp.ts")`);
  assert.equal(nearFile.code, 1);
  assert.match(nearFile.output, /Quick Open found no file named "pp\.ts" \(VS Code offered "src\/app\.ts" instead\)/);
  const badCommand = await run(`command("Acme: A Command That Was Renamed")`);
  assert.equal(badCommand.code, 1);
  assert.match(badCommand.output, /Command Palette has no command named/);
});

test("an unsupported output format fails up front instead of hanging", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-cli-"));
  script(dir, "s.ts", `const demo = createDemo({ viewport: [300, 200], fps: 10 });\nawait demo.browser.goto("data:text/html,hi");\nawait demo.render("out/s.webm");`);
  const r = await cli(["render", "s.ts"], dir);
  assert.equal(r.code, 1);
  assert.match(r.output, /can't render to .*s\.webm.*\.mp4 or \.gif/);
});

test("demo.type fails like other targets when its selector is missing", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-cli-"));
  script(dir, "s.ts", `const demo = createDemo();\nawait demo.browser.goto("data:text/html,<input id=a>");\nawait demo.type("#missing", "x");\nawait demo.render("out.mp4");`);
  const r = await cli(["check", "s.ts"], dir);
  assert.equal(r.code, 1);
  assert.match(r.output, /reelscript: target "#missing" was not found[\s\S]*s\.ts:4/);
  assert.ok(r.ms < 20_000, `took ${r.ms}ms`);
});

test("demo.check() called from a script counts as its run", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-cli-"));
  script(dir, "s.ts", `const demo = createDemo({ verbose: false });\nawait demo.browser.goto("data:text/html,hi");\nawait demo.check();`);
  const r = await cli(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.doesNotMatch(r.output, /check passed/, "verbose: false is quiet");
});

test("record runs commands in the script's folder, or a run's cwd", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-cli-"));
  mkdirSync(join(dir, "demos", "app"), { recursive: true });
  script(join(dir, "demos"), "s.ts", `const demo = createDemo();\nawait demo.terminal.open();\nawait demo.terminal.run("pwd");\nawait demo.terminal.run("pwd -P", { cwd: "app" });\nawait demo.render("out.mp4");`);
  const r = await cli(["record", "demos/s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  const recs = readdirSync(join(dir, "demos", "recordings")).map((f) => JSON.parse(readFileSync(join(dir, "demos", "recordings", f), "utf8")));
  const out = (cmd: string) => recs.find((x) => x.command === cmd).events.map((e: [number, string]) => e[1]).join("").trim();
  assert.match(out("pwd"), /\/demos$/);
  assert.match(out("pwd -P"), /\/demos\/app$/);
});

test("cache: names match warmup, and a custom code-server binary doesn't break the listing", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-cli-"));
  // Every folder in /tmp: a contributor's own REELSCRIPT_MODELS mustn't be what "clear narration" clears.
  const env = { REELSCRIPT_CACHE: join(dir, "cache"), REELSCRIPT_MODELS: join(dir, "models"), REELSCRIPT_CODE_SERVER: "/usr/bin/true" };
  const list = await cli(["cache"], dir, env);
  assert.equal(list.code, 0, list.output);
  assert.match(list.output, /editor .*REELSCRIPT_CODE_SERVER: \/usr\/bin\/true/);
  assert.match(list.output, /^\s+narration\s/m);
  const clear = await cli(["cache", "clear", "narration"], dir, env);
  assert.equal(clear.code, 0, clear.output);
});

test("editor: type lands in the editor, it reopens on a new workspace, and stopping leaves no processes", { timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-cli-"));
  mkdirSync(join(dir, "other"));
  writeFileSync(join(dir, "other", "notes.txt"), "second workspace\n");
  const tmp = mkdtempSync(join(tmpdir(), "rs-proc-")); // code-server's temp folders go here, so we can look for leftovers
  script(dir, "s.ts", `const demo = createDemo({ viewport: [1000, 640], fps: 30 });
await demo.browser.goto("data:text/html,<input id=a>");
await demo.editor.open({ workspace: ${JSON.stringify(acme)} });
await demo.editor.openFile("app.ts");
await demo.browser.focus();
await demo.editor.type("ZZZ");
await demo.call(async ({ page }) => {
  // VS Code paints on real time, so give the last keystroke a moment to show.
  await page!
    .waitForFunction(() => (document.querySelector(".monaco-editor .view-lines")?.textContent ?? "").includes("ZZZ"), undefined, { timeout: 5000 })
    .catch(() => { throw new Error("editor.type didn't reach the editor"); });
});
await demo.editor.close();
await demo.editor.open({ workspace: "other" });
await demo.editor.openFile("notes.txt");
await demo.render("out.mp4");`);
  const r = await cli(["check", "s.ts"], dir, { TMPDIR: tmp });
  assert.equal(r.code, 0, r.output);
  const left = execSync("ps -A -o command").toString().split("\n").filter((l) => l.includes(tmp));
  assert.deepEqual(left, [], "no code-server processes left running");
  assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith("reelscript-editor-")), [], "no temp folders left behind");
});

test("the page clock keeps Date() without new and Date subclasses working", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-cli-"));
  for (const deterministic of [true, false]) {
    script(dir, "s.ts", `const demo = createDemo({ deterministic: ${deterministic} });
await demo.browser.goto("data:text/html,hi");
await demo.call(async ({ page }) => {
  // A string, so the TypeScript compiler adds no helpers the page doesn't have.
  const r = await page!.evaluate(\`(() => {
    class Stamp extends Date { label() { return "stamp"; } }
    const s = new Stamp();
    return { str: typeof Date(), year: new Date().getFullYear(), sub: s instanceof Stamp && s.label() === "stamp", isDate: new Date() instanceof Date };
  })()\`) as { str: string; year: number; sub: boolean; isDate: boolean };
  if (r.str !== "string" || r.year !== 2025 || !r.sub || !r.isDate) throw new Error("Date broken: " + JSON.stringify(r));
});
await demo.render("out.mp4");`);
    const r = await cli(["check", "s.ts"], dir);
    assert.equal(r.code, 0, `deterministic ${deterministic}: ${r.output}`);
  }
});

test("a failed render leaves the previous output in place", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-cli-"));
  const body = (extra: string) => `const demo = createDemo({ viewport: [300, 200], fps: 10 });\nawait demo.browser.goto("data:text/html,<button id=b>b</button>");\nawait demo.cursor.moveTo("#b");\n${extra}\nawait demo.render("out/s.mp4");`;
  script(dir, "s.ts", body(""));
  const good = await cli(["render", "s.ts"], dir);
  assert.equal(good.code, 0, good.output);
  const before = readFileSync(join(dir, "out/s.mp4"));
  script(dir, "s.ts", body(`await demo.wait(500);\nawait demo.cursor.moveTo("#missing");`));
  const bad = await cli(["render", "s.ts"], dir);
  assert.equal(bad.code, 1);
  assert.ok(readFileSync(join(dir, "out/s.mp4")).equals(before), "the last good render is untouched");
  assert.deepEqual(readdirSync(join(dir, "out")), ["s.mp4"], "no partial files left behind");
});

test("record --prune only removes recordings", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-cli-"));
  writeFileSync(join(dir, "tsconfig.json"), "{}\n");
  writeFileSync(join(dir, "old-recording-123abc.json"), JSON.stringify({ version: 1, command: "echo old", events: [] }));
  script(dir, "s.ts", `const demo = createDemo({ recordingsDir: "." });\nawait demo.terminal.open();\nawait demo.terminal.run("echo new");\nawait demo.render("out.mp4");`);
  const r = await cli(["record", "s.ts", "--prune"], dir);
  assert.equal(r.code, 0, r.output);
  const left = readdirSync(dir);
  assert.ok(left.includes("tsconfig.json"), "other JSON is kept");
  assert.ok(!left.includes("old-recording-123abc.json"), "the unused recording is pruned");
});
