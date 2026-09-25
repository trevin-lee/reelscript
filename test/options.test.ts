import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemo } from "../src/index.js";
import { centreWithin } from "../src/renderer.js";
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
