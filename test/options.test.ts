import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemo } from "../src/index.js";
import { playbackEvents } from "../src/terminal.js";
import { withCarriageReturns } from "../src/terminal.js";
import { centreWithin, zoomAt } from "../src/renderer.js";
import { createTheme } from "../src/theme.js";

const noRaster = async () => Buffer.alloc(0);

test("waitFor and a zoom kept within the window are recorded", async () => {
  const demo = createDemo();
  await demo.browser.goto("https://example.test");
  await demo.waitFor("#ready", { timeout: 5000 });
  demo.zoom.to("#b", { scale: 2, within: "window" });
  assert.deepEqual(demo.getTimeline().slice(1), [
    { kind: "waitFor", target: "#ready", timeout: 5000 },
    { kind: "zoom.to", target: "#b", scale: 2, within: "window" },
  ]);
});

test("a click can take no video time, and waitFor can settle", async () => {
  const demo = createDemo();
  await demo.browser.goto("https://example.test");
  await demo.cursor.click({ duration: 0 });
  await demo.waitFor("#next", { settle: 100 });
  assert.deepEqual(demo.getTimeline().slice(1), [
    { kind: "cursor.click", duration: 0 },
    { kind: "waitFor", target: "#next", settle: 100 },
  ]);
});

test("without a menu bar the window moves up into its place", () => {
  const withBar = createTheme("macos", noRaster);
  const without = createTheme("macos", noRaster, false);
  const named = createTheme("macos", noRaster, { app: "Safari", clock: "Wed Sep 23  9:41 AM" });
  assert.deepEqual(withBar.defaultDesktop([1440, 740]), [1584, 932]);
  assert.deepEqual(without.defaultDesktop([1440, 740]), [1584, 904]);
  assert.deepEqual(named.defaultDesktop([1440, 740]), [1584, 932]);
  assert.deepEqual(withBar.mainPlacement([1600, 900], [1440, 740]), { x: 80, y: 72 });
  assert.deepEqual(without.mainPlacement([1600, 900], [1440, 740]), { x: 80, y: 44 });
});

test("centreWithin keeps a view inside a span, or centres it when the span is narrower", () => {
  // A 400-wide view in 0..1000: the centre stays between 200 and 800.
  assert.equal(centreWithin(500, 400, 0, 1000), 500);
  assert.equal(centreWithin(950, 400, 0, 1000), 800);
  assert.equal(centreWithin(10, 400, 0, 1000), 200);
  // Wider than the span: the middle of the span.
  assert.equal(centreWithin(10, 1200, 100, 1100), 600);
});

test("a zoom that replaces another starts where the other has got to", () => {
  const rest = { scale: 1, cx: 800, cy: 450 };
  // An instant zoom to 1.5, set at t=1000 and replaced at the same instant:
  // the new one starts from 1.5, not from the frame before.
  const instant = { from: rest, to: { scale: 1.5, cx: 700, cy: 400 }, start: 1000, dur: 0, ease: "smooth" as const };
  assert.deepEqual(zoomAt(instant, rest, 1000), { scale: 1.5, cx: 700, cy: 400 });
  // Halfway through a linear one.
  const linear = { from: rest, to: { scale: 2, cx: 600, cy: 350 }, start: 0, dur: 1000, ease: "linear" as const };
  assert.deepEqual(zoomAt(linear, rest, 500), { scale: 1.5, cx: 700, cy: 400 });
  assert.deepEqual(zoomAt(null, rest, 500), rest);
});

test("call, and terminal output that goes on without a prompt, are recorded", async () => {
  const demo = createDemo();
  const fn = () => {};
  await demo.terminal.open();
  await demo.terminal.run("agent", { output: "working", duration: 300, prompt: false });
  await demo.call(fn);
  await demo.terminal.print("done", { duration: 200, prompt: true });
  const [, run, call, print] = demo.getTimeline();
  assert.deepEqual(run, { kind: "terminal.run", command: "agent", output: "working", duration: 300, prompt: false });
  assert.equal(call.kind, "call");
  assert.equal((call as { fn: unknown }).fn, fn);
  assert.deepEqual(print, { kind: "terminal.print", text: "done", duration: 200, prompt: true });
});

test("a terminal can have a fixed size, and play timed output made elsewhere", async () => {
  const demo = createDemo();
  const events: [number, string][] = [[0, "\x1b[2J"], [400, "hello"], [5000, " world"]];
  await demo.terminal.open({ cols: 80, rows: 24, lineHeight: 1 });
  await demo.terminal.run("tool", { events, speed: 2, maxGapMs: 1000, prompt: false });
  await demo.terminal.print("", { events, speed: 4 });
  const [open, run, print] = demo.getTimeline();
  assert.deepEqual(open, { kind: "terminal.open", cols: 80, rows: 24, lineHeight: 1 });
  assert.deepEqual(run, { kind: "terminal.run", command: "tool", events, speed: 2, maxGapMs: 1000, prompt: false });
  assert.deepEqual(print, { kind: "terminal.print", text: "", events, speed: 4 });
  // Played the way a recording is: long gaps capped, then sped up.
  assert.deepEqual(playbackEvents(events, { speed: 2, maxGap: 1000 }), [[0, "\x1b[2J"], [200, "hello"], [700, " world"]]);
  // Declared output gets its carriage returns; one that has them keeps them.
  assert.equal(withCarriageReturns("a\nb\r\nc"), "a\r\nb\r\nc");
});

test("maxGap: Infinity keeps every silence, as output paced by the script needs", async () => {
  const demo = createDemo();
  const events: [number, string][] = [[0, "a"], [5000, "b"]];
  await demo.terminal.open();
  await demo.terminal.print("", { events, maxGap: Infinity });
  await demo.terminal.print("", { events, maxGapMs: Infinity });
  assert.deepEqual(playbackEvents(events, { maxGap: Infinity }), events);
  // Any other number that isn't one is still an error at its line.
  await assert.rejects(() => demo.terminal.print("", { events, maxGap: -1 }), /maxGap must be a number, 0 or more, not -1/);
  await assert.rejects(() => demo.wait(Infinity), /ms must be a number, 0 or more, not Infinity/);
});

test("a bundled ffmpeg that was never downloaded gives way to one on PATH, or says how to get it", async () => {
  const { resolveFfmpeg } = await import("../src/encoder.js");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const saved = { path: process.env.PATH, ffmpeg: process.env.REELSCRIPT_FFMPEG };
  delete process.env.REELSCRIPT_FFMPEG;
  try {
    const dir = mkdtempSync(join(tmpdir(), "rs-ffmpeg-"));
    writeFileSync(join(dir, "ffmpeg"), "");
    assert.equal(resolveFfmpeg(undefined, join(dir, "ffmpeg")), join(dir, "ffmpeg"), "the bundled one, when it's there");
    process.env.PATH = dir;
    assert.equal(resolveFfmpeg(undefined, "/nowhere/ffmpeg"), "ffmpeg");
    process.env.PATH = "/nowhere";
    assert.throws(() => resolveFfmpeg(undefined, "/nowhere/ffmpeg"), /npm install-scripts approve ffmpeg-static/);
  } finally {
    process.env.PATH = saved.path;
    if (saved.ffmpeg !== undefined) process.env.REELSCRIPT_FFMPEG = saved.ffmpeg;
  }
});
