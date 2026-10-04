import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
  await assert.rejects(() => bad({ events: [["a", "x\n"]] }), /events\[0\] must be \[ms, text\], with ms a number, 0 or more; not \["a","x\\n"\]/);
  await assert.rejects(() => bad({ events: "x" }), /events must be a list of \[ms, text\] pairs/);
  await assert.rejects(() => bad({ output: 5 }), /output must be text, not 5/);
  await assert.rejects(() => bad({ prompt: 3 }), /prompt must be true, false, or the prompt's text/);
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
