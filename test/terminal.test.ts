import { test } from "node:test";
import assert from "node:assert/strict";
import { playbackEvents, recordCommand, scriptedEvents, slugForCommand } from "../src/terminal.js";

test("slugForCommand is stable and filesystem-safe", () => {
  const a = slugForCommand("npm install -D @reelscript/cli");
  assert.equal(a, slugForCommand("npm install -D @reelscript/cli"));
  assert.match(a, /^[a-z0-9-]+-[0-9a-f]{6}$/);
  assert.notEqual(a, slugForCommand("npm install -D @reelscript/core"));
});

test("scriptedEvents paces lines evenly and keeps newlines", () => {
  const ev = scriptedEvents("one\ntwo\nthree", 1000);
  assert.deepEqual(ev.map(([, t]) => t), ["one\n", "two\n", "three"]);
  assert.deepEqual(ev.map(([at]) => at), [80, 580, 1080]);
});

test("playbackEvents caps silences and scales speed", () => {
  const ev = playbackEvents([[0, "a"], [5000, "b"], [5100, "c"]], { maxGapMs: 700, speed: 2 });
  assert.deepEqual(ev, [[0, "a"], [350, "b"], [400, "c"]]);
});

test("recordCommand captures real output with timing", async () => {
  const rec = await recordCommand("echo hello && echo world");
  assert.equal(rec.exitCode, 0);
  assert.equal(rec.events.map(([, t]) => t).join(""), "hello\nworld\n");
  assert.ok(rec.events.every(([at]) => at >= 0));
});
