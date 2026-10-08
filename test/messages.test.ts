import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemo } from "../src/index.js";
import { resolveSession } from "../src/session.js";

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

test("timed events and text options of the wrong type fail where they're queued, instead of hanging a check", async () => {
  const demo = createDemo();
  await demo.terminal.open();
  const bad = (opts: object) => demo.terminal.run("echo hi", opts as never);
  assert.throws(() => bad({ events: [["a", "x\n"]] }), /events\[0\] must be \[ms, text\], with ms a number, 0 or more; not \["a","x\\n"\]/);
  assert.throws(() => bad({ events: "x" }), /events must be a list of \[ms, text\] pairs/);
  assert.throws(() => bad({ output: 5 }), /output must be text, not 5/);
  assert.throws(() => bad({ prompt: 3 }), /prompt must be true, false, or the prompt's text/);
  await demo.terminal.run("echo hi", { events: [[0, "hi\n"]], prompt: "acme % " });
});

test("editor.file() and editor.tab() take a name and its folder, not a longer path they'd quietly trim", () => {
  const demo = createDemo();
  assert.match(demo.editor.file("src/app.ts"), /aria-label="app\.ts"/);
  assert.throws(() => demo.editor.file("bogus/src/app.ts"), /editor\.file\("bogus\/src\/app\.ts"\) can name a file and the folder it's directly in \("src\/app\.ts"\)/);
  assert.throws(() => demo.editor.tab("a/b/c.ts"), /editor\.tab\("a\/b\/c\.ts"\)/);
});

test("a session path that isn't a saved session says so, with how to make one", () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-msg-"));
  writeFileSync(join(dir, "login.log"), "reelscript: saved the session\n");
  assert.throws(() => resolveSession("login.log", dir), /login\.log isn't a saved session[\s\S]*npx @reelscript\/cli login/);
  writeFileSync(join(dir, "ok.json"), JSON.stringify({ cookies: [], origins: [] }));
  assert.equal(resolveSession("ok.json", dir), join(dir, "ok.json"));
});

test("waitFor doesn't count text only a screen reader gets, parked off the page or clipped to nothing", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-msg-"));
  const page = `<p id="gone" style="position:absolute;left:-999em">Deployed</p><p id="clipped" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Deployed</p><p id="shown">Ready</p>`;
  writeFileSync(join(dir, "page.html"), page);
  const wait = (target: string) => `const demo = createDemo({ viewport: [300, 200], fps: 10, theme: "bare" });\nawait demo.browser.goto("./page.html");\nawait demo.waitFor(${JSON.stringify(target)}, { timeout: 1500 });\nawait demo.render("out.mp4");`;
  for (const target of ["#gone", "#clipped"]) {
    demo(dir, wait(target));
    const r = await run(["check", "s.ts"], dir);
    assert.equal(r.code, 1, `${target} counted as shown: ${r.output}`);
    assert.match(r.output, new RegExp(`waitFor "${target}" timed out`));
  }
  demo(dir, wait("#shown"));
  assert.equal((await run(["check", "s.ts"], dir)).code, 0);
});

test("render --out names the output given, and check with warnings doesn't say it passed", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-msg-"));
  demo(dir, `const demo = createDemo({ viewport: [300, 200], fps: 10, theme: "bare" });\nawait demo.browser.goto("data:text/html,hi");\nawait demo.render("out.mp4");`);
  const bad = await run(["render", "s.ts", "--out", "x.webm"], dir);
  assert.equal(bad.code, 1);
  assert.match(bad.output, /can't render to "[^"]*\/x\.webm"/);
  assert.doesNotMatch(bad.output, /pending/);
  demo(dir, `const demo = createDemo({ viewport: [300, 200], fps: 10, theme: "bare" });\nawait demo.browser.mockAPI("/api/never", {});\nawait demo.browser.goto("data:text/html,hi");\nawait demo.render("out.mp4");`);
  const strict = await run(["check", "--strict", "s.ts"], dir);
  assert.equal(strict.code, 1);
  assert.match(strict.output, /check finished with 1 warning for s\.ts/);
  assert.doesNotMatch(strict.output, /check passed/);
});

test("render() says which command ran the script, so a script cuts or captions only a video that was written", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-msg-"));
  demo(
    dir,
    `import { writeFileSync } from "node:fs";\nconst demo = createDemo({ viewport: [300, 200], fps: 10, theme: "bare" });\nawait demo.browser.goto("data:text/html,hi");\nconst r = await demo.render("out.mp4");\nwriteFileSync("result.json", JSON.stringify({ command: r.command, out: r.out }));`,
  );
  const result = () => JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as { command: string; out: string };
  assert.equal((await run(["check", "s.ts"], dir)).code, 0);
  assert.deepEqual(result(), { command: "check", out: "" });
  assert.equal((await run(["preview", "s.ts", "--out", "f.png"], dir)).code, 0);
  assert.equal(result().command, "preview");
  assert.match(result().out, /f\.png$/);
  assert.equal((await run(["render", "s.ts"], dir)).code, 0);
  assert.deepEqual(result(), { command: "render", out: join(realpathSync(dir), "out.mp4") });
});

test("record --prune removes only the recordings the scripts it's given made", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-msg-"));
  const script = (name: string, say: string) =>
    writeFileSync(join(dir, name), `import { createDemo } from "@reelscript/cli";\nconst demo = createDemo();\nawait demo.terminal.open();\nawait demo.terminal.run("echo ${say}");\nawait demo.render("out.mp4");\n`);
  script("a.ts", "one");
  script("b.ts", "other");
  assert.equal((await run(["record", "a.ts", "b.ts"], dir)).code, 0);
  // From before recordings named their script: left, and listed.
  writeFileSync(join(dir, "recordings", "echo-old-000000.json"), JSON.stringify({ version: 1, command: "echo old", cols: 80, rows: 24, exitCode: 0, durationMs: 1, recordedAt: "", events: [] }));
  script("a.ts", "two");
  const pruned = await run(["record", "a.ts", "--prune"], dir);
  assert.equal(pruned.code, 0, pruned.output);
  const left = readdirSync(join(dir, "recordings")).sort();
  assert.ok(left.some((f) => f.startsWith("echo-two-")), "a.ts's new recording");
  assert.ok(left.some((f) => f.startsWith("echo-other-")), "b.ts's recording, which a.ts doesn't use, is left alone");
  assert.ok(!left.some((f) => f.startsWith("echo-one-")), "a.ts's old recording is pruned");
  assert.ok(left.includes("echo-old-000000.json"));
  assert.match(pruned.output, /left 1 recording[\s\S]*echo-old-000000\.json/);
  assert.equal((await run(["check", "b.ts"], dir)).code, 0);
});

test("a misspelt voice fails at createDemo(), like every other option", async () => {
  assert.throws(() => createDemo({ voice: "af_hart" }), /unknown voice "af_hart"[\s\S]*\(createDemo\)/);
  createDemo({ voice: "af_heart" });
  const engine = { id: "x", voices: ["low", "high"], synthesize: async () => ({ samples: new Float32Array(0), sampleRate: 24000 }) };
  assert.throws(() => createDemo({ tts: engine as never, voice: "mid" }), /unknown voice "mid". Voices: low, high/);
  createDemo({ tts: engine as never, voice: "high" });
});

test("hints name the CLI as the project runs it: npx reelscript when installed, npx @reelscript/cli when not", async () => {
  const { cli } = await import("../src/browser.js");
  const here = process.cwd();
  const bare = mkdtempSync(join(tmpdir(), "rs-msg-"));
  const installed = mkdtempSync(join(tmpdir(), "rs-msg-"));
  mkdirSync(join(installed, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(installed, "node_modules", ".bin", "reelscript"), "");
  mkdirSync(join(installed, "demos"));
  try {
    process.chdir(bare);
    assert.equal(cli(), "npx @reelscript/cli");
    process.chdir(join(installed, "demos"));
    assert.equal(cli(), "npx reelscript");
  } finally {
    process.chdir(here);
  }
});

test("a strict render with warnings names the output given; a window that doesn't fit, and an old option name, are warnings at their line", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-msg-"));
  writeFileSync(join(dir, "w.mp4"), "the previous video");
  demo(dir, `const demo = createDemo({ viewport: [300, 200], fps: 10, theme: "bare" });\nawait demo.browser.mockAPI("/api/never", {});\nawait demo.browser.goto("data:text/html,hi");\nawait demo.render("out.mp4");`);
  const strict = await run(["render", "s.ts", "--strict", "--out", "w.mp4"], dir);
  assert.equal(strict.code, 1);
  assert.match(strict.output, /--strict makes a render with warnings fail; [^\n]*\/w\.mp4 is unchanged/);
  assert.doesNotMatch(strict.output, /pending/);
  assert.equal(readFileSync(join(dir, "w.mp4"), "utf8"), "the previous video");

  demo(dir, `const demo = createDemo({ viewport: [800, 500] });\nawait demo.browser.goto("data:text/html,hi", { settle: 100 });\nawait demo.terminal.open({ x: 700, y: 400, width: 1200, height: 900 });\nawait demo.render("out.mp4");`);
  const checked = await run(["check", "--strict", "s.ts"], dir);
  assert.equal(checked.code, 1);
  assert.match(checked.output, /goto\(\{ settle \}\) is now goto\(\{ hold \}\); the old name works until 1\.0\n  at [^\n]*s\.ts:3/);
  assert.match(checked.output, /the terminal window was refitted: width 1200 became \d+, as much as the \d+x\d+ desktop has room for[^\n]*\n  at [^\n]*s\.ts:4/);
});

test("menubar on the bare theme, which has none, fails at createDemo()", () => {
  assert.throws(() => createDemo({ theme: "bare", menubar: { app: "Acme" } }), /the bare theme has no menu bar[\s\S]*\(createDemo\)/);
  createDemo({ theme: "bare", menubar: false });
  createDemo({ menubar: { app: "Acme" } });
});

test("a point target follows the rules a selector does: a click or zoom must be on its window, and a click must land on it; the cursor may still leave the shot", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-msg-"));
  const body = (steps: string) => `const demo = createDemo({ viewport: [400, 300] });\ndemo.browser.goto("data:text/html,<button id=b>go</button>");\n${steps}\nawait demo.render("out.mp4");`;
  const cases: [string, RegExp | null][] = [
    [`demo.cursor.moveTo({ x: 5000, y: -300 });\ndemo.cursor.click();`, /the click at the point \{ x: 5000, y: -300 \} would land outside the browser window, whose content is 400x300/],
    [`demo.zoom.to({ x: 900, y: 10 }, { scale: 2 });`, /the point \{ x: 900, y: 10 \} is outside the browser window, whose content is 400x300/],
    [`demo.terminal.open({ x: 0, y: 30, width: 700, height: 500 });\ndemo.cursor.moveTo({ x: 30, y: 90 }, { window: "browser" });\ndemo.cursor.click();`, /the click on the point \{ x: 30, y: 90 \} would land on the terminal window/],
    [`demo.cursor.moveTo({ x: 5000, y: 5000 });\ndemo.wait(100);`, null],
  ];
  for (const [steps, expected] of cases) {
    demo(dir, body(steps));
    const r = await run(["check", "s.ts"], dir);
    if (expected) {
      assert.equal(r.code, 1, `${steps}\n${r.output}`);
      assert.match(r.output, expected);
    } else assert.equal(r.code, 0, `parking the cursor out of the shot: ${r.output}`);
  }
});

test("a refitted window says why: the smallest size, or the menu bar", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-msg-"));
  demo(dir, `const demo = createDemo({ viewport: [600, 400] });\ndemo.browser.goto("data:text/html,hi");\ndemo.terminal.open({ x: 0, y: 0, width: 100, height: 300 });\nawait demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.match(r.output, /width 100 became 200, the smallest a window can be \(200x120\)/);
  assert.match(r.output, /y 0 became \d+, below the menu bar \(menubar: false removes it\)/);
});

test("an option a step can't use fails at its line instead of doing nothing", () => {
  const demo = createDemo();
  demo.terminal.open();
  const events: [number, string][] = [[0, "b\n"]];
  assert.throws(() => demo.terminal.run("x", { output: "a\n", events }), /output and events are two ways/);
  assert.throws(() => demo.terminal.run("x", { output: "a\n", cwd: "nowhere", exitCode: 1 }), /cwd, exitCode are for reelscript record/);
  assert.throws(() => demo.terminal.print("IGNORED", { events }), /text isn't shown when events are given/);
  assert.throws(() => demo.terminal.print("more"), /print\(\) would write after the prompt "~ % "/);
  demo.terminal.run("build", { output: "...", prompt: false });
  demo.terminal.print("done\n", { prompt: true });
  assert.throws(() => demo.terminal.print("again"), /print\(\) would write after the prompt/);
  const bare = createDemo({ theme: "bare" });
  assert.throws(() => bare.terminal.open({ title: "acme" }), /the bare theme draws no title bar/);
  assert.throws(() => createDemo({ theme: "bare", address: "https://acme.test" }), /the bare theme draws no address bar/);
  const quiet = createDemo();
  quiet.terminal.open({ prompt: "" });
  quiet.terminal.print("", { events });
});
