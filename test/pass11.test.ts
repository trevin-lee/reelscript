import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { missingLibraries } from "../src/browser.js";
import { cacheParts, partPaths } from "../src/cache.js";

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

test("a number an action can't use fails where the script queues it, and a missing session names createDemo's line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p11-"));
  for (const [step, message] of [
    [`demo.type("#a", "abc", { wpm: 0 })`, /wpm must be a number above 0, not 0[\s\S]*s\.ts:4:\d+ \(type\)/],
    [`demo.terminal.run("ls", { events: [[0, "a"]], speed: 0 })`, /speed must be a number above 0, not 0[\s\S]*s\.ts:4:\d+ \(terminal\.run\)/],
    [`demo.wait("500" as never)`, /ms must be a number, 0 or more, not "500"[\s\S]*s\.ts:4:\d+ \(wait\)/],
    [`demo.wait(-2000)`, /ms must be a number, 0 or more, not -2000/],
    [`demo.zoom.to("#a", { scale: 0 })`, /scale must be a number above 0, not 0/],
  ] as const) {
    demo(dir, `const demo = createDemo();\nawait demo.browser.goto("data:text/html,<input id=a>");\nawait ${step};\nawait demo.render("out.mp4");`);
    const r = await run(["check", "s.ts"], dir);
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, message);
  }
  demo(dir, `const demo = createDemo({ camera: { scale: 0 } });\nawait demo.render("out.mp4");`);
  const camera = await run(["check", "s.ts"], dir);
  assert.match(camera.output, /camera scale must be a number above 0, not 0[\s\S]*s\.ts:2:\d+ \(createDemo\)/);
  demo(dir, `const demo = createDemo({ session: "nosuch.json" });\nawait demo.browser.goto("data:text/html,hi");\nawait demo.render("out.mp4");`);
  const session = await run(["check", "s.ts"], dir);
  assert.equal(session.code, 1);
  assert.match(session.output, /session file not found[\s\S]*s\.ts:2:\d+ \(createDemo\)/);
});

test("preview past the end fails with the demo's length; at the end it's the last frame", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p11-"));
  demo(dir, `const demo = createDemo({ viewport: [300, 200], theme: "bare", fps: 30 });\nawait demo.browser.goto("data:text/html,hi");\nawait demo.wait(1000);\nawait demo.render("out.mp4");`);
  const past = await run(["preview", "s.ts", "--at", "20"], dir);
  assert.equal(past.code, 1);
  const length = /20\.00s is past the end of the demo, which is ([\d.]+)s long/.exec(past.output);
  assert.ok(length, past.output);
  const end = await run(["preview", "s.ts", "--at", length[1], "--out", "end.png"], dir);
  assert.equal(end.code, 0, end.output);
});

test("a failure in the page clock itself is a warning, once", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p11-"));
  writeFileSync(join(dir, "p.html"), `<p>hi</p><script>document.getAnimations = () => { throw new Error("boom"); };</script>`);
  demo(dir, `const demo = createDemo({ viewport: [300, 200] });\nawait demo.browser.goto("./p.html");\nawait demo.wait(300);\nawait demo.browser.goto("./p.html");\nawait demo.wait(300);\nawait demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.equal(r.output.match(/warning: the page clock failed in file:\S+p\.html, so its animations may differ between renders: .*boom/g)?.length, 1, r.output);
});

test("a launch that fails for lack of system libraries is recognised, and names them", () => {
  const log = `browserType.launch: Target page, context or browser has been closed
Browser logs:
<launching> /ms-playwright/chromium_headless_shell-1243/chrome-linux/headless_shell --disable-field-trial-config
/ms-playwright/chromium_headless_shell-1243/chrome-linux/headless_shell: error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file: No such file or directory`;
  assert.deepEqual(missingLibraries(log), ["libglib-2.0.so.0"]);
  const hostCheck = `browserType.launch:
╔══════════════════════════════════════════════════════╗
║ Host system is missing dependencies to run browsers. ║
║ Missing libraries:                                   ║
║     libnss3.so                                       ║
║     libatk-1.0.so.0                                  ║
╚══════════════════════════════════════════════════════╝`;
  assert.deepEqual(missingLibraries(hostCheck), ["libnss3.so", "libatk-1.0.so.0"]);
  assert.equal(missingLibraries("browserType.launch: Timeout 180000ms exceeded"), null, "other failures aren't taken for it");
});

test("reelscript cache lists the browser, in Playwright's folder, and it's the container's own there", () => {
  const browser = cacheParts().find((p) => p.name === "browser");
  assert.ok(browser, "listed");
  assert.deepEqual(partPaths(browser).map((p) => p.split(/[\\/]/).pop()!.replace(/\d+$/, "N")), ["chromium-N", "chromium_headless_shell-N"]);
  assert.equal(browser.builtIn, false);
  assert.equal(browser.shared, true, "so clear all, which tests run against a scratch folder, leaves it alone");
  const before = process.env.REELSCRIPT_BUILTIN;
  process.env.REELSCRIPT_BUILTIN = "/opt/reelscript/builtin";
  try {
    assert.equal(cacheParts().find((p) => p.name === "browser")!.builtIn, true);
  } finally {
    if (before === undefined) delete process.env.REELSCRIPT_BUILTIN;
    else process.env.REELSCRIPT_BUILTIN = before;
  }
});

test("editor.file() with a folder picks that folder's file when two share a name", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p11-"));
  for (const folder of ["src", "test"]) {
    mkdirSync(join(dir, "ws", folder), { recursive: true });
    writeFileSync(join(dir, "ws", folder, "app.ts"), `export const where = "${folder}";\n`);
  }
  demo(dir, `const demo = createDemo({ viewport: [1000, 640] });
await demo.editor.open({ workspace: "ws" });
await demo.editor.openFile("src/app.ts");
await demo.cursor.moveTo(demo.editor.file("test")); // expand it: both app.ts rows show
await demo.cursor.click();
await demo.cursor.moveTo(demo.editor.file("test/app.ts"));
await demo.cursor.click();
await demo.waitFor(".tabs-container .tab.active :is([class~='test-name-dir-icon'])", { window: "editor" });
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.doesNotMatch(r.output, /matches \d+ visible elements/, "the folder makes it one row");
});
