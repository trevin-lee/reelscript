import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveFfmpeg } from "../src/encoder.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");

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

test("an action missing what it can't do without fails where it's queued", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p18-"));
  for (const [step, message] of [
    ["demo.wait(undefined as never)", /wait needs a time in ms[\s\S]*s\.ts:4:\d+ \(wait\)/],
    ["demo.scroll({})", /scroll takes a selector, or one of \{ by \} and \{ to \}, not nothing/],
    ["demo.scroll({ by: 1200, to: 0 })", /scroll takes a selector, or one of \{ by \} and \{ to \}, not by and to/],
  ] as const) {
    demo(dir, `const demo = createDemo();\nawait demo.browser.goto("data:text/html,hi");\nawait ${step};\nawait demo.render("out.mp4");`);
    const r = await run(["check", "s.ts"], dir);
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, message);
  }
});

test("content revealed as it scrolls into view renders the same every time", { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p18-"));
  const cards = Array.from({ length: 30 }, (_, i) => `<div class=card>card ${i}</div>`).join("");
  writeFileSync(
    join(dir, "p.html"),
    `<style>.card{height:120px;margin:12px;background:#4f46e5;color:#fff;font:20px sans-serif;opacity:0;transform:translateY(30px);transition:opacity .4s,transform .4s}.card.in{opacity:1;transform:none}</style>${cards}
<script>const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { threshold: 0.2 }); document.querySelectorAll(".card").forEach((c) => io.observe(c));</script>`,
  );
  demo(dir, `const demo = createDemo({ viewport: [360, 300], fps: 20, theme: "bare" });\nawait demo.browser.goto("./p.html");\nawait demo.wait(300);\nawait demo.scroll({ by: 1500 });\nawait demo.wait(500);\nawait demo.render(process.env.OUT!);`);
  for (const out of ["a.mp4", "b.mp4"]) {
    const r = await run(["render", "s.ts"], dir, { OUT: out });
    assert.equal(r.code, 0, r.output);
  }
  execFileSync(resolveFfmpeg(), ["-v", "error", "-i", "a.mp4", "-i", "b.mp4", "-lavfi", "[0:v][1:v]psnr=stats_file=psnr.log", "-f", "null", "-"], { cwd: dir });
  const worst = Math.min(...readFileSync(join(dir, "psnr.log"), "utf8").trim().split("\n").map((l) => {
    const v = /psnr_avg:(\S+)/.exec(l)?.[1];
    return v === "inf" || !v ? Infinity : Number(v);
  }));
  assert.ok(worst >= 40, `every frame the same to the eye (40 dB, the bar CI uses for the README GIF): worst ${worst} dB`);
});

test("login never saves an empty session, least of all over one that works", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p18-"));
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<p>sign in</p>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(dir, "session.json"), '{"cookies":[{"name":"sid"}],"origins":[]}\n');
    // stdin closed at once, as from /dev/null, with nothing signed in
    const r = await run(["login", `http://127.0.0.1:${port}/`, "--out", "session.json"], dir, { REELSCRIPT_LOGIN_HEADLESS: "1" });
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, /nothing to save: the browser has no cookies or storage for any site, so the sign-in didn't finish\. \S*session\.json is unchanged\./);
    assert.equal(readFileSync(join(dir, "session.json"), "utf8"), '{"cookies":[{"name":"sid"}],"origins":[]}\n');
  } finally {
    server.close();
  }
});

test("MCP check_script is strict by default, as CI's check --strict", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-p18-"));
  demo(dir, `const demo = createDemo({ viewport: [300, 200] });\ndemo.browser.mockAPI("/api/never", {});\nawait demo.browser.goto("data:text/html,hi");\nawait demo.render("out.mp4");`);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/cli.ts", "mcp"], cwd: root, env: process.env as Record<string, string>, stderr: "pipe" });
  const client = new Client({ name: "reelscript-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const strict = await client.callTool({ name: "check_script", arguments: { script: join(dir, "s.ts") } });
    assert.equal(strict.isError, true);
    assert.match(((strict.content as { text?: string }[])[0].text ?? ""), /--strict makes a run with warnings fail/);
    const loose = await client.callTool({ name: "check_script", arguments: { script: join(dir, "s.ts"), strict: false } });
    assert.equal(loose.isError, false, JSON.stringify(loose.content));
  } finally {
    await client.close();
  }
});
