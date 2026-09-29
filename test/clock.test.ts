import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import sharp from "sharp";
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

test("a finished animation with a fill mode stays finished", async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await ctx.addInitScript(CLOCK_SHIM);
    const page = await ctx.newPage();
    await page.setContent(`<style>
      @keyframes rise { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: none } }
      h1 { animation: rise 100ms linear both; }
    </style><h1>Title</h1>`);
    const advance = (ms: number) =>
      page.evaluate((ms) => (window as unknown as { __reelscript_advance: (n: number) => void }).__reelscript_advance(ms), ms);
    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      await advance(20);
      times.push(Number(await page.evaluate(() => document.getAnimations()[0]?.currentTime ?? -1)));
    }
    // 0, 20, 40, 60, 80, then finished at 100 and held there; never back to 0.
    assert.deepEqual(times.slice(0, 5), [0, 20, 40, 60, 80]);
    assert.ok(times.slice(5).every((t) => t === 100), `restarted: ${times.join(",")}`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("h1")!).opacity), "1");
  } finally {
    await browser.close();
  }
});

test("a fade a click starts is filmed from its first frame", { timeout: 180_000 }, async () => {
  // Chromium also runs an opacity fade on its compositor. Held by the page clock before
  // it had started, that copy could stay a real frame ahead (about 1 run in 75), so the
  // click's frame differed between renders.
  const page = `<style>#m{position:fixed;inset:100px;background:#000;opacity:0;transition:opacity .2s}#m.open{opacity:1}</style>
    <button style="position:fixed;left:0;top:0;width:80px;height:40px" onclick="m.classList.add('open')">go</button><div id="m"></div>`;
  const browser = await chromium.launch({ args: ["--disable-smooth-scrolling"] });
  try {
    const seen: string[] = [];
    for (let run = 0; run < 100; run++) {
      const ctx = await browser.newContext({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
      await ctx.addInitScript(CLOCK_SHIM);
      await ctx.route("http://fade.test/", (r) => r.fulfill({ contentType: "text/html", body: page }));
      const p = await ctx.newPage();
      const cdp = await ctx.newCDPSession(p);
      await p.goto("http://fade.test/");
      const advance = () => p.evaluate(() => (window as unknown as { __reelscript_advance: (n: number) => unknown }).__reelscript_advance(1000 / 30));
      // Darkness at the middle of the fading square, as captured for a frame.
      const shot = async () => {
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
        const px = await sharp(Buffer.from(data, "base64")).extract({ left: 200, top: 200, width: 1, height: 1 }).raw().toBuffer();
        return 255 - px[0];
      };
      await advance();
      await shot();
      await p.mouse.click(40, 20);
      await advance();
      const first = await shot();
      await advance();
      seen.push(`${first}/${await shot()}`);
      await ctx.close();
    }
    const kinds = [...new Set(seen)];
    assert.equal(kinds.length, 1, `the click's frame differed between runs: ${kinds.join(", ")}`);
    assert.match(kinds[0], /^0\/[1-9]/, "the fade starts at the click's frame and moves on the next");
  } finally {
    await browser.close();
  }
});

test("a scroll-driven animation is left to the scroll position", async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await ctx.addInitScript(CLOCK_SHIM);
    const page = await ctx.newPage();
    // As on github.com: a bar that grows as the page scrolls, and a timed
    // fade beside it.
    await page.setContent(`<style>
      @keyframes grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
      @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
      #bar { position: fixed; top: 0; width: 100%; height: 4px; animation: grow linear; animation-timeline: scroll(); }
      #fade { animation: fade 100ms linear both; }
      body { height: 3000px; }
    </style><div id="bar"></div><p id="fade">Hello</p>`);
    const advance = (ms: number) =>
      page.evaluate((ms) => (window as unknown as { __reelscript_advance: (n: number) => void }).__reelscript_advance(ms), ms);
    for (let i = 0; i < 10; i++) await advance(1000 / 60);
    assert.equal(Number(await page.evaluate(() => getComputedStyle(document.querySelector("#fade")!).opacity)), 1);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(100); // a real frame, for the scroll to reach the animation
    await advance(1000 / 60);
    const scale = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector("#bar")!).transform).a);
    assert.ok(scale > 0.4 && scale < 0.6, `the bar follows the scroll, half way down: ${scale}`);

    // Finished and played again by the page, it still isn't the clock's.
    await page.evaluate(() => {
      const bar = document.getAnimations().find((a) => a.timeline && !(a.timeline instanceof DocumentTimeline))!;
      bar.finish();
      bar.play();
    });
    await advance(1000 / 60);
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForTimeout(100);
    await advance(1000 / 60);
    const replayed = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector("#bar")!).transform).a);
    assert.ok(replayed > 0.15 && replayed < 0.35, `the replayed bar follows the scroll, a quarter down: ${replayed}`);
  } finally {
    await browser.close();
  }
});
