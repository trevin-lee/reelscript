import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFfmpeg } from "../src/encoder.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");
const ffmpeg = resolveFfmpeg();

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

const frames = (file: string, cwd: string) =>
  execFileSync(ffmpeg, ["-v", "error", "-i", file, "-map", "0:v", "-f", "framemd5", "-"], { cwd }).toString().split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop()!.trim());

test("video and SVG animations follow the frame clock: the same moment at every frame, every render", { timeout: 180_000 }, async () => {
  // Timing is what reelscript controls, so that's what's compared: the video's
  // time and the SVG timeline at fixed points. (Chromium's video decoding can
  // vary pixel values invisibly between runs, like its text rasterizing.)
  const dir = mkdtempSync(join(tmpdir(), "rs-p9-"));
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=160x120:rate=30", "-c:v", "libvpx", "-b:v", "300k", join(dir, "clip.webm")]);
  writeFileSync(join(dir, "media.html"), `<body style="margin:10px"><video id=v src="clip.webm" autoplay muted loop width=160 height=120></video>
<svg id=s width="160" height="120"><circle cx="20" cy="60" r="12" fill="tomato"><animate attributeName="cx" from="20" to="140" dur="1s" repeatCount="indefinite"/></circle></svg></body>`);
  demo(dir, `import { writeFileSync } from "node:fs";
const demo = createDemo({ viewport: [360, 150], fps: 20, theme: "bare" });
const seen: number[][] = [];
await demo.browser.goto("./media.html");
for (let i = 0; i < 3; i++) {
  await demo.wait(500);
  await demo.call(async ({ page }) => {
    seen.push(await page!.evaluate(() => [
      Math.round((document.getElementById("v") as HTMLVideoElement).currentTime * 1000),
      Math.round((document.getElementById("s") as unknown as SVGSVGElement).getCurrentTime() * 1000),
    ]));
  });
}
await demo.call(() => writeFileSync(process.env.SEEN_FILE!, JSON.stringify(seen)));
await demo.render("out/m.mp4");`);
  const runs: number[][][] = [];
  for (let i = 0; i < 2; i++) {
    const file = join(dir, `seen${i}.json`);
    const r = await run(["render", "s.ts"], dir, { SEEN_FILE: file });
    assert.equal(r.code, 0, r.output);
    runs.push(JSON.parse(readFileSync(file, "utf8")));
  }
  assert.deepEqual(runs[0], runs[1], "the same video and SVG time at each point in both renders");
  const [video, svg] = [runs[0].map((x) => x[0]), runs[0].map((x) => x[1])];
  assert.ok(video[1] - video[0] >= 400 && video[1] - video[0] <= 600, `the video advances with the timeline: ${video}`);
  assert.ok(svg[2] - svg[0] >= 900 && svg[2] - svg[0] <= 1100, `the SVG timeline advances with it: ${svg}`);
});

test("a page that pauses its own video keeps it paused", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p9-"));
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=160x120:rate=30", "-c:v", "libvpx", join(dir, "clip.webm")]);
  writeFileSync(join(dir, "p.html"), `<video id=v src="clip.webm" autoplay muted></video><button id=stop onclick="document.getElementById('v').pause()">stop</button>`);
  demo(dir, `const demo = createDemo({ viewport: [400, 200] });
await demo.browser.goto("./p.html");
await demo.wait(500);
await demo.cursor.moveTo("#stop");
await demo.cursor.click();
let at = 0;
await demo.call(async ({ page }) => { at = await page!.evaluate(() => (document.getElementById("v") as HTMLVideoElement).currentTime); });
await demo.wait(800);
await demo.call(async ({ page }) => {
  const s = await page!.evaluate(() => { const v = document.getElementById("v") as HTMLVideoElement; return { t: v.currentTime, paused: v.paused }; });
  if (!s.paused || Math.abs(s.t - at) > 0.01) throw new Error("video kept playing: " + JSON.stringify({ at, ...s }));
});
await demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
});

test("an odd desktop size renders to mp4, and a local page keeps its #hash", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p9-"));
  writeFileSync(join(dir, "app.html"), `<p id=where></p><script>document.getElementById("where").textContent = location.hash;</script>`);
  demo(dir, `const demo = createDemo({ viewport: [400, 300], desktop: [601, 451], fps: 10 });
await demo.browser.goto("./app.html#settings");
await demo.waitFor('#where:has-text("#settings")', { timeout: 3000 });
await demo.render("out/odd.mp4");`);
  const r = await run(["render", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /602x452/);
});

test("record is quiet with verbose: false, but still warns", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p9-"));
  demo(dir, `const demo = createDemo({ verbose: false });\nawait demo.terminal.open();\nawait demo.terminal.run("echo hi");\nawait demo.terminal.run("ls /no-such-dir");\nawait demo.render("out.mp4");`);
  const r = await run(["record", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.doesNotMatch(r.output, /recording "echo hi"|saved \d recording/);
  assert.match(r.output, /warning: "ls \/no-such-dir" exited/);
});

test("cache clear narration clears every voice model in reelscript's own folder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p9-"));
  const models = join(dir, "cache", "models");
  mkdirSync(join(models, "someone", "other-voice"), { recursive: true });
  writeFileSync(join(models, "someone", "other-voice", "model.onnx"), "x");
  // REELSCRIPT_MODELS empty (unset): reelscript's own folder, and never a contributor's real one.
  const r = await run(["cache", "clear", "narration"], dir, { REELSCRIPT_CACHE: join(dir, "cache"), REELSCRIPT_MODELS: "" });
  assert.equal(r.code, 0, r.output);
  assert.ok(!existsSync(models));
});
