import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clockEpoch, menubarClock } from "../src/time.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");

function check(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "rs-wc-"));
  writeFileSync(join(dir, "s.ts"), `import { createDemo } from "@reelscript/cli";\n${body}\nawait demo.render("out.mp4");\n`);
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", tsx, join(root, "src/cli.ts"), "check", "s.ts"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("clockEpoch reads wall-clock times in a timezone, and ISO strings with offsets as they are", () => {
  assert.equal(new Date(clockEpoch("2026-03-10T14:30", "America/New_York")).toISOString(), "2026-03-10T18:30:00.000Z"); // EDT
  assert.equal(new Date(clockEpoch("2026-01-10T14:30", "America/New_York")).toISOString(), "2026-01-10T19:30:00.000Z"); // EST
  assert.equal(new Date(clockEpoch("2026-03-10T14:30:00Z", "Asia/Tokyo")).toISOString(), "2026-03-10T14:30:00.000Z");
  assert.throws(() => clockEpoch("next tuesday", "UTC"), /can't read clock/);
});

test("the default menu bar clock is unchanged, and a custom clock shows in it", () => {
  assert.equal(menubarClock(clockEpoch("2025-09-23T09:41:00", "UTC"), "UTC"), "Tue Sep 23  9:41 AM");
  assert.equal(menubarClock(clockEpoch("2026-03-10T14:30", "America/New_York"), "America/New_York"), "Tue Mar 10  2:30 PM");
});

test("the page's Date starts at the demo's clock, in its timezone", { timeout: 60_000 }, async () => {
  const r = await check(`const demo = createDemo({ clock: "2026-03-10T14:30", timezone: "America/New_York" });
await demo.browser.goto("data:text/html,<p>hi</p>");
await demo.call(async ({ page }) => {
  const seen = await page!.evaluate(() => ({ iso: new Date().toISOString(), hour: new Date().getHours() }));
  if (!seen.iso.startsWith("2026-03-10T18:30") || seen.hour !== 14) throw new Error("page clock was " + JSON.stringify(seen));
});`);
  assert.equal(r.code, 0, r.output);
});

test("a closed window is gone until it's opened again", { timeout: 60_000 }, async () => {
  const closed = await check(`const demo = createDemo();
await demo.terminal.open();
await demo.terminal.close();
await demo.terminal.run("echo hi", { output: "hi" });`);
  assert.equal(closed.code, 1);
  assert.match(closed.output, /window "terminal" is not open[\s\S]*s\.ts:5/);

  const reopened = await check(`const demo = createDemo();
await demo.browser.open({ x: 40, y: 60, width: 700, height: 400 });
await demo.terminal.open();
await demo.terminal.close();
await demo.terminal.open();
await demo.terminal.run("echo hi", { output: "hi" });
await demo.browser.close();`);
  assert.equal(reopened.code, 0, reopened.output);
});

test("mockAPI opens no window", { timeout: 60_000 }, async () => {
  const r = await check(`const demo = createDemo();
demo.browser.mockAPI("https://api.example.test/**", { ok: true });
await demo.terminal.open();
await demo.waitFor("body", { window: "browser", timeout: 1000 });`);
  assert.equal(r.code, 1);
  assert.match(r.output, /window "browser" is not open/);
});
