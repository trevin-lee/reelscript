import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { clockShim } from "../src/clock.js";
import { resolveFfmpeg } from "../src/encoder.js";
import { quickInputMatches } from "../src/renderer.js";
import { INSPECT_ELEMENTS } from "../src/mcp.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");
const ffmpeg = resolveFfmpeg();

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

const clip = (dir: string) =>
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=160x120:rate=30", "-c:v", "libvpx", "-b:v", "300k", join(dir, "clip.webm")]);

test("animations, video and the caret inside web components follow the frame clock", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p10-"));
  clip(dir);
  const slide = `@keyframes slide { to { transform: translateX(100px) } } .box { width: 10px; height: 10px; animation: slide 4s linear }`;
  // The same 4s slide in the page, in a declarative shadow root, in a closed
  // root, and in an open root inside that; a video and a text field in the closed root.
  writeFileSync(
    join(dir, "page.html"),
    `<style>${slide}</style><div class=box id=light></div>
<x-declared><template shadowrootmode="open"><style>${slide}</style><div class=box></div></template></x-declared>
<x-closed id=host></x-closed>
<script>
  const closed = host.attachShadow({ mode: "closed" });
  closed.innerHTML = '<style>${slide} input { caret-color: red; font: 20px sans-serif; margin: 10px; width: 300px }</style><div class=box></div><x-inner></x-inner><video src="clip.webm" muted width=80></video><input value="hello">';
  closed.querySelector("x-inner").attachShadow({ mode: "open" }).innerHTML = '<style>${slide}</style><div class=box></div>';
  closed.querySelector("video").play();
  window.closedRoot = closed;
</script>`,
  );
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 500, height: 300 } });
    await ctx.addInitScript(clockShim(0));
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(join(dir, "page.html")).href);
    const advance = (ms: number) => page.evaluate((ms) => (window as unknown as { __reelscript_advance: (n: number) => Promise<unknown> }).__reelscript_advance(ms), ms);
    await advance(16);
    for (let i = 0; i < 60; i++) await advance(1000 / 60); // 1s of page time, however long it takes
    // A string, not a function: tsx would add a __name helper the page doesn't have.
    const seen: Record<"light" | "declared" | "closed" | "nested" | "video", number> = await page.evaluate(`(() => {
      const closed = window.closedRoot;
      const x = (el) => new DOMMatrix(getComputedStyle(el).transform).e;
      return {
        light: x(document.getElementById("light")),
        declared: x(document.querySelector("x-declared").shadowRoot.querySelector(".box")),
        closed: x(closed.querySelector(".box")),
        nested: x(closed.querySelector("x-inner").shadowRoot.querySelector(".box")),
        video: closed.querySelector("video").currentTime,
      };
    })()`);
    assert.ok(Math.abs(seen.light - 25) < 1, `a quarter of the way after 1s of 4s: ${JSON.stringify(seen)}`);
    for (const where of ["declared", "closed", "nested"] as const) assert.ok(Math.abs(seen[where] - seen.light) < 0.5, `${where} shadow root on the frame clock: ${JSON.stringify(seen)}`);
    assert.ok(Math.abs(seen.video - 1) < 0.1, `a video playing in a shadow root moves with the clock: ${JSON.stringify(seen)}`);

    await page.evaluate(() => {
      const input = (window as unknown as { closedRoot: ShadowRoot }).closedRoot.querySelector("input")!;
      input.focus();
      input.setSelectionRange(5, 5);
    });
    await advance(16);
    const caret = await page.evaluate(() => {
      const input = (window as unknown as { closedRoot: ShadowRoot }).closedRoot.querySelector("input")!;
      const drawn = [...document.querySelectorAll("div[aria-hidden=true]")].find((d) => (d as HTMLElement).style.position === "fixed") as HTMLElement | undefined;
      return { drawn: drawn && drawn.style.display !== "none" ? parseFloat(drawn.style.left) : null, field: input.getBoundingClientRect().left, color: getComputedStyle(input).caretColor };
    });
    assert.ok(caret.drawn !== null && caret.drawn > caret.field + 40, `the caret is drawn after the text in a shadow-root field: ${JSON.stringify(caret)}`);
    assert.match(caret.color, /rgba\(0, 0, 0, 0\)|transparent/, "Chromium's own caret is hidden there too, despite the component's caret-color");
  } finally {
    await browser.close();
  }
});

test("a video that can't seek (a server without Range requests) is warned about once", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p10-"));
  clip(dir);
  writeFileSync(join(dir, "page.html"), `<video src="clip.webm" autoplay muted loop width=160></video>`);
  // Like python -m http.server: the whole file every time, Range headers ignored.
  const server = createServer((req, res) => {
    const file = req.url === "/clip.webm" ? "clip.webm" : "page.html";
    res.writeHead(200, { "content-type": file.endsWith(".webm") ? "video/webm" : "text/html" });
    res.end(readFileSync(join(dir, file)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    demo(dir, `const demo = createDemo({ viewport: [360, 150], theme: "bare" });\nawait demo.browser.goto("http://127.0.0.1:${port}/page.html");\nawait demo.wait(1000);\nawait demo.render("out.mp4");`);
    const r = await run(["check", "s.ts"], dir);
    assert.equal(r.code, 0, r.output);
    assert.equal(r.output.match(/warning: \S+clip\.webm can't be moved to the page clock's time/g)?.length, 1, r.output);
  } finally {
    server.close();
  }
});

test("check rejects options render can't use, at the createDemo line; a missing script is named", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p10-"));
  for (const [options, message] of [
    ["{ fps: 0 }", /fps must be a number above 0, not 0/],
    ["{ viewport: [0, 0] }", /viewport must be \[width, height\] in whole pixels above 0, not \[0,0\]/],
    ["{ desktop: [1280.5, 800] }", /desktop must be \[width, height\] in whole pixels above 0/],
    ["{ gif: { width: -1 } }", /gif\.width must be a whole number of pixels above 0, not -1/],
    ["{ theme: \"dark\" as never }", /unknown theme "dark" \(use "macos", "bare"\)/],
    ["{ timezone: \"America/NewYork\" }", /unknown timezone "America\/NewYork" \(use an IANA name/],
    ["{ clock: \"yesterday\" }", /can't read clock "yesterday"; use an ISO date/],
  ] as const) {
    demo(dir, `const demo = createDemo(${options});\nawait demo.render("out.mp4");`);
    const r = await run(["check", "s.ts"], dir);
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, message);
    assert.match(r.output, /s\.ts:2:\d+ \(createDemo\)/, r.output);
  }
  const missing = await run(["render", "s.ts", "demos/tpyo.ts"], dir);
  assert.equal(missing.code, 1);
  assert.match(missing.output, /^reelscript: no script at demos\/tpyo\.ts$/m);
  assert.doesNotMatch(missing.output, /ERR_MODULE_NOT_FOUND|Cannot find module/);
});

test("terminal output ending in a newline has no blank line before the prompt, and prompt can be a new one", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p10-"));
  demo(dir, `import { writeFileSync } from "node:fs";
const demo = createDemo({ viewport: [600, 300], theme: "bare" });
await demo.terminal.open({ prompt: "acme % " });
await demo.terminal.run("echo hi", { output: "hi\\n" });
await demo.terminal.run("cd app", { output: "", prompt: "app % " });
await demo.terminal.run("ls", { output: "a.ts\\n" });
await demo.call(async ({ page }) => {
  const rows = await page!.evaluate(() => [...document.querySelectorAll(".xterm-rows > div")].map((r) => (r.textContent ?? "").replace(/\\s+$/, "")));
  writeFileSync("rows.json", JSON.stringify(rows.slice(0, rows.findLastIndex((r) => r) + 1)));
});
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "rows.json"), "utf8")), ["acme % echo hi", "hi", "acme % cd app", "app % ls", "a.ts", "app %"]);
});

test("Quick Open and Command Palette rows count only for the file or command asked for", () => {
  assert.ok(quickInputMatches("app.ts src, recently opened", "app.ts", true));
  assert.ok(quickInputMatches("app.ts src, file results", "src/app.ts", true));
  assert.ok(quickInputMatches("app.ts src/web, file results", "web/app.ts", true));
  assert.ok(quickInputMatches("README.md, file results", "./README.md", true));
  assert.ok(!quickInputMatches("webapp.ts src, file results", "app.ts", true), "a longer name isn't the file");
  assert.ok(!quickInputMatches("app.ts src, file results", "pp.ts", true), "nor a shorter one");
  assert.ok(!quickInputMatches("app.ts lib, file results", "src/app.ts", true), "nor one in another folder");
  assert.ok(!quickInputMatches("No matching results", "x.ts", true));
  assert.ok(quickInputMatches("Format Document, Control+Shift+I", "Format Document", false));
  assert.ok(quickInputMatches("Format Document, Control+Shift+I", "format document", false), "VS Code ignores case, and so does this");
  assert.ok(quickInputMatches("View: Toggle Word Wrap, Alt+Z", "Toggle Word Wrap", false), "the category is optional");
  assert.ok(quickInputMatches("Acme: Deploy to Production", "Acme: Deploy to Production", false));
  assert.ok(!quickInputMatches("Format Document With..., recently used", "Format Document", false), "a longer command isn't the one asked for");
  assert.ok(!quickInputMatches("JSON: Sort Document, similar commands", "Sort Document", false));
});

test("a link or window.open() that would open a new tab opens in the browser window", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p10-"));
  writeFileSync(join(dir, "a.html"), `<a id=docs href="b.html" target="_blank">Docs</a>`);
  writeFileSync(join(dir, "b.html"), `<h1 id=b>B</h1><button id=open onclick="window.open('c.html')">Open</button>`);
  writeFileSync(join(dir, "c.html"), `<h1 id=c>C</h1>`);
  demo(dir, `const demo = createDemo({ viewport: [500, 300] });
await demo.browser.goto("./a.html");
await demo.cursor.moveTo("#docs");
await demo.cursor.click();
await demo.waitFor("#b", { timeout: 5000 });
await demo.cursor.moveTo("#open");
await demo.cursor.click();
await demo.waitFor("#c", { timeout: 5000 });
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
});

test("a target is its first visible match, and several visible matches are a warning at the line", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p10-"));
  // A hidden copy first, as a collapsed mobile menu would be; then two visible "Create" buttons.
  writeFileSync(join(dir, "p.html"), `<nav style="display:none"><a>Pricing</a></nav><nav><a id=pricing>Pricing</a></nav><button>Create</button> <button>Create</button>`);
  demo(dir, `const demo = createDemo({ viewport: [500, 300] });
await demo.browser.goto("./p.html");
await demo.cursor.moveTo("text=Pricing");
await demo.cursor.moveTo("text=Create");
await demo.cursor.click();
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.doesNotMatch(r.output, /"text=Pricing" matches/, "the hidden copy doesn't count");
  assert.equal(r.output.match(/warning: "text=Create" matches 2 visible elements in the browser window; using the first/g)?.length, 1, r.output);
  assert.match(r.output, /matches 2 visible elements[^\n]*\n {2}at s\.ts:5:\d+ \(cursor\.moveTo\)/);
});

test("inspect_page lists elements inside web components", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<button id=light>Light</button><x-app></x-app>
<script>document.querySelector("x-app").attachShadow({ mode: "open" }).innerHTML = '<button data-testid="deploy">Deploy</button>';</script>`);
    const found = (await page.evaluate(INSPECT_ELEMENTS)) as { selector: string; label: string }[];
    assert.deepEqual(found.map((e) => [e.selector, e.label]), [["#light", "Light"], ['[data-testid="deploy"]', "Deploy"]]);
    assert.equal(await page.locator('[data-testid="deploy"]').count(), 1, "and the selector it suggests reaches it");
  } finally {
    await browser.close();
  }
});

test("a GIF isn't scaled up past the video, and the summary describes the GIF", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p10-"));
  demo(dir, `const demo = createDemo({ viewport: [300, 200], theme: "bare", fps: 30 });\nawait demo.browser.goto("data:text/html,hi");\nawait demo.wait(1000);\nawait demo.render("out.gif");`);
  const r = await run(["render", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  const gif = readFileSync(join(dir, "out.gif"));
  const size = [gif.readUInt16LE(6), gif.readUInt16LE(8)];
  assert.deepEqual(size, [300, 200], "the video's own width, not 960");
  const said = /\((\d+)x(\d+), (\d+) frames, ([\d.]+)s video/.exec(r.output);
  assert.ok(said, r.output);
  assert.deepEqual([+said[1], +said[2]], size, "the summary gives the GIF's size");
  assert.equal(+said[3], Math.round(+said[4] * 20), "and its frames, at the GIF's 20fps");
});
