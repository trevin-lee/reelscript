import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemo } from "../src/index.js";

test("demo records a timeline in order", async () => {
  const demo = createDemo();
  await demo.browser.goto("https://example.test");
  demo.browser.mockAPI("**/api/*", { ok: true });
  await demo.cursor.moveTo("#a", { ease: "snappy" });
  await demo.cursor.click();
  demo.zoom.to("#b", { scale: 2 });
  await demo.type("#c", "hi", { wpm: 500 });
  await demo.press("Enter");
  await demo.wait(100);
  demo.zoom.out();
  demo.say("Done.", { voice: "am_michael" });
  await demo.waitForNarration();

  assert.deepEqual(
    demo.getTimeline().map((a) => a.kind),
    ["browser.goto", "browser.mockAPI", "cursor.moveTo", "cursor.click", "zoom.to", "type", "press", "wait", "zoom.out", "say", "waitForNarration"],
  );
  assert.deepEqual(demo.getTimeline()[2], { kind: "cursor.moveTo", target: "#a", ease: "snappy" });
});
