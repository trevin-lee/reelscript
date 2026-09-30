import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTheme } from "../src/theme.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");

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

/** A local site for a test: `pages` maps a path to [status, html]; anything else echoes the request headers. */
async function site(pages: Record<string, [number, string]>) {
  const server = createServer((req, res) => {
    const page = pages[req.url ?? ""];
    if (page) {
      res.writeHead(page[0], { "content-type": "text/html" });
      res.end(page[1]);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.headers));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}

test("in a project that isn't an ES module one, the script's temporary copy is gone before the script runs", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p14-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cjs", version: "1.0.0" }));
  demo(dir, `const demo = createDemo();\nawait demo.terminal.open();\nawait demo.terminal.run("ls -a");\nawait demo.render("out.mp4");`);
  const r = await run(["record", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  const recording = JSON.parse(readFileSync(join(dir, "recordings", readdirSync(join(dir, "recordings"))[0]), "utf8"));
  const listed = recording.events.map((e: [number, string]) => e[1]).join("");
  assert.match(listed, /s\.ts/);
  assert.doesNotMatch(listed, /reelscript\.mts/, "the copy isn't there for the demo's own commands to see");
  assert.deepEqual(readdirSync(dir).filter((f) => f.includes("reelscript")), [], "nor left behind");
});

test("a confirm() the page opens is answered OK, with a warning at the line", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p14-"));
  writeFileSync(join(dir, "p.html"), `<button id=del onclick="out.textContent = confirm('Delete project?') ? 'deleted' : 'cancelled'">Delete</button><p id=out>-</p>`);
  demo(dir, `const demo = createDemo({ viewport: [400, 200] });\nawait demo.browser.goto("./p.html");\nawait demo.cursor.moveTo("#del");\nawait demo.cursor.click();\nawait demo.waitFor("text=deleted", { timeout: 3000 });\nawait demo.render("out.mp4");`);
  const r = await run(["check", "s.ts"], dir);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /warning: the page opened a confirm\("Delete project\?"\) dialog, which isn't drawn in the video; reelscript answered OK\n {2}at s\.ts:5:\d+ \(cursor\.click\)/);
});

test("a goto that gets an HTTP error is a warning at its line", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p14-"));
  const s = await site({ "/gone": [404, "<h1>Not found</h1>"] });
  try {
    demo(dir, `const demo = createDemo({ viewport: [400, 200] });\nawait demo.browser.goto("${s.url}/gone");\nawait demo.render("out.mp4");`);
    const r = await run(["check", "s.ts"], dir);
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /warning: goto\("[^"]+\/gone"\) got HTTP 404 from \S+; the page shown may be an error page\n {2}at s\.ts:3:\d+ \(browser\.goto\)/);
  } finally {
    s.close();
  }
});

test("the browser's requests say Chrome on a Mac too, and it doesn't announce itself as automated", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p14-"));
  const s = await site({});
  try {
    demo(dir, `import { writeFileSync } from "node:fs";
const demo = createDemo({ viewport: [400, 200] });
await demo.browser.goto("${s.url}/headers");
await demo.call(async ({ page }) => writeFileSync("seen.json", JSON.stringify({ headers: JSON.parse(await page!.textContent("body") ?? "{}"), webdriver: await page!.evaluate(() => navigator.webdriver) })));
await demo.render("out.mp4");`);
    const r = await run(["check", "s.ts"], dir);
    assert.equal(r.code, 0, r.output);
    const { headers, webdriver } = JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"));
    assert.match(headers["user-agent"], /Macintosh.*Chrome\/\d+\.0\.0\.0/);
    assert.match(headers["sec-ch-ua"], /"Google Chrome"/);
    assert.doesNotMatch(headers["sec-ch-ua"], /Headless/);
    assert.equal(headers["sec-ch-ua-platform"], '"macOS"');
    assert.equal(webdriver, false);
  } finally {
    s.close();
  }
});

test("menubar.clockText sets what the menu bar's clock shows", async () => {
  let html = "";
  const theme = createTheme("macos", async (h) => { html = h; throw new Error("enough"); }, { app: "Acme", clockText: "Launch day" });
  await theme.background([800, 600]).catch(() => {});
  assert.match(html, /<b>Acme<\/b><span>Launch day<\/span>/);
});
