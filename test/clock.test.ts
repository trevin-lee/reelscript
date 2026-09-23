import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { CLOCK_SHIM } from "../src/clock.js";

const APP = new URL("../examples/app.html", import.meta.url).href;

test("page clock advances exactly one frame per step", async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await ctx.addInitScript(CLOCK_SHIM);
    const page = await ctx.newPage();
    await page.goto(APP);
    const advance = (ms: number) =>
      page.evaluate((ms) => (window as unknown as { __reelscript_advance: (n: number) => void }).__reelscript_advance(ms), ms);

    // Timers and Date follow the virtual clock.
    await page.evaluate(() => {
      (window as unknown as { fired: number[] }).fired = [];
      setTimeout(() => (window as unknown as { fired: number[] }).fired.push(performance.now()), 50);
    });
    await advance(40);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { fired: number[] }).fired), []);
    await advance(20);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { fired: number[] }).fired), [50]);

    // A 200ms CSS transition spans ~12 frames at 60fps regardless of wall-clock time.
    await page.click("#new-project");
    const opacity: number[] = [];
    for (let i = 0; i < 16; i++) {
      await advance(1000 / 60);
      opacity.push(Number(await page.evaluate(() => getComputedStyle(document.querySelector("#modal")!).opacity)));
    }
    assert.equal(opacity[0], 0);
    assert.ok(opacity[5] > 0.3 && opacity[5] < 0.9, `mid-transition opacity was ${opacity[5]}`);
    assert.equal(opacity[12], 1);
    assert.ok(opacity.every((v, i) => i === 0 || v >= opacity[i - 1]), "opacity is monotonic");

    // The app's setTimeout(200) focus handler ran on the virtual clock.
    assert.equal(await page.evaluate(() => document.activeElement?.id), "project-name");
  } finally {
    await browser.close();
  }
});
