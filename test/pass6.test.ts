import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAsciicast } from "../src/terminal.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");

function run(args: string[], cwd: string, env: Record<string, string> = {}, onOutput?: (all: string, stdin: NodeJS.WritableStream) => void) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", tsx, join(root, "src/cli.ts"), ...args], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const on = (d: Buffer) => {
      output += d;
      onOutput?.(output, child.stdin!);
    };
    child.stdout!.on("data", on);
    child.stderr!.on("data", on);
    child.on("close", (code) => resolve({ code, output }));
  });
}

function demo(dir: string, body: string, name = "s.ts") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `import { createDemo } from "@reelscript/cli";\n${body}\n`);
}

test("check opens hover menus the way a render does", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p6-"));
  const page = "data:text/html," + encodeURIComponent(`<style>#menu{display:none}#account:hover #menu{display:block}</style>
<div id=account style="margin:40px;width:200px">Account<div id=menu><a id=settings href="#">Settings</a></div></div>`);
  demo(dir, `const demo = createDemo({ viewport: [600, 400] });\nawait demo.browser.goto(${JSON.stringify(page)});\nawait demo.cursor.moveTo("#account");\nawait demo.cursor.moveTo("#settings");\nawait demo.cursor.click();\nawait demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
});

test("check times narration with the real length of lines already spoken", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p6-"));
  const cache = join(dir, "cache");
  // A voice engine whose every line lasts 3s, far longer than the word-count estimate for "Hi."
  demo(dir, `const tts = { id: "three-seconds", async synthesize() { return { audio: new Float32Array(72000), sampleRate: 24000 }; } };
const demo = createDemo({ tts, viewport: [300, 200], fps: 10 });
await demo.browser.goto("data:text/html,hi");
demo.say("Hi.");
await demo.waitForNarration();
await demo.render("out.mp4");`);
  const timeline = (out: string) => Number(/([\d.]+)s timeline/.exec(out)?.[1]);
  const before = await run(["check", "s.ts"], dir, { REELSCRIPT_CACHE: cache });
  assert.ok(timeline(before.output) < 2, before.output);
  assert.equal((await run(["render", "s.ts"], dir, { REELSCRIPT_CACHE: cache })).code, 0);
  const after = await run(["check", "s.ts"], dir, { REELSCRIPT_CACHE: cache });
  assert.ok(timeline(after.output) >= 3, after.output);
});

test("login keeps IndexedDB, and a demo with the session sees it", { timeout: 120_000 }, async () => {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<div id=who>checking</div><script>
const open = indexedDB.open("auth", 1);
open.onupgradeneeded = () => open.result.createObjectStore("s");
open.onsuccess = () => {
  const db = open.result;
  if (location.pathname === "/login") db.transaction("s", "readwrite").objectStore("s").put("trevin", "user");
  const get = db.transaction("s").objectStore("s").get("user");
  get.onsuccess = () => { document.getElementById("who").textContent = get.result ? "signed in as " + get.result : "signed out"; };
};
</script>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "rs-p6-"));
  try {
    let pressed = false;
    const login = await run(["login", `${base}/login`, "--out", "session.json"], dir, { REELSCRIPT_LOGIN_HEADLESS: "1" }, (all, stdin) => {
      if (!pressed && /press Enter/.test(all)) {
        pressed = true;
        setTimeout(() => stdin.write("\n"), 800);
      }
    });
    assert.equal(login.code, 0, login.output);
    const saved = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
    assert.ok(saved.origins.some((o: { indexedDB?: unknown[] }) => o.indexedDB?.length), "IndexedDB is saved");
    demo(dir, `const demo = createDemo({ session: "session.json" });\nawait demo.browser.goto(${JSON.stringify(base + "/")});\nawait demo.waitFor('#who:has-text("signed in as trevin")', { timeout: 5000 });\nawait demo.render("out.mp4");`);
    const r = await run(["check", "s.ts"], dir);
    assert.equal(r.code, 0, r.output);
  } finally {
    server.close();
  }
});

test("type needs its field on screen, like moveTo; press can name a window", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p6-"));
  const tall = "data:text/html," + encodeURIComponent(`<div style="height:2000px"></div><input id=far>`);
  demo(dir, `const demo = createDemo({ viewport: [500, 300] });\nawait demo.browser.goto(${JSON.stringify(tall)});\nawait demo.type("#far", "hello");\nawait demo.render("out.mp4");`);
  const off = await run(["check", "s.ts"], dir);
  assert.equal(off.code, 1);
  assert.match(off.output, /"#far" is outside the visible part[\s\S]*demo\.scroll\("#far"\)/);

  demo(dir, `const demo = createDemo({ viewport: [500, 300] });
await demo.browser.goto("data:text/html,<input id=a autofocus>");
await demo.terminal.open();
await demo.press("x", { window: "browser" });
await demo.call(async ({ page }) => { if ((await page!.inputValue("#a")) !== "x") throw new Error("press missed the browser"); });
await demo.render("out.mp4");`);
  const press = await run(["check", "s.ts"], dir);
  assert.equal(press.code, 0, press.output);
});

test("asciinema recordings, v2 and v3, become timed events", () => {
  const v2 = `{"version": 2, "width": 100, "height": 30}\n[0.5, "o", "hello "]\n[1.25, "i", "x"]\n[1.5, "o", "world"]`;
  assert.deepEqual(parseAsciicast(v2), { events: [[500, "hello "], [1500, "world"]], cols: 100, rows: 30 });
  const v3 = `{"version": 3, "term": {"cols": 120, "rows": 40}}\n[0.5, "o", "hello "]\n# a comment\n[1.0, "o", "world"]`;
  assert.deepEqual(parseAsciicast(v3), { events: [[500, "hello "], [1500, "world"]], cols: 120, rows: 40 });
  assert.throws(() => parseAsciicast(`{"version": 1}`), /unsupported asciicast version 1/);
});
