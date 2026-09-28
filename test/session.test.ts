import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function cli(args: string[], opts: { env?: Record<string, string>; onOutput?: (all: string, stdin: NodeJS.WritableStream) => void } = {}) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(root, "src/cli.ts"), ...args], {
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const on = (d: Buffer) => {
      output += d.toString();
      opts.onOutput?.(output, child.stdin!);
    };
    child.stdout!.on("data", on);
    child.stderr!.on("data", on);
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("login saves a session, and a demo with it starts signed in", { timeout: 120_000 }, async () => {
  // A site that signs you in by setting a cookie, and shows who you are.
  const server = createServer((req, res) => {
    if (req.url === "/login") {
      res.setHeader("Set-Cookie", "sid=abc123; Path=/; HttpOnly");
      res.end("<p id=done>signed in</p>");
      return;
    }
    const signedIn = /(?:^|; )sid=abc123/.test(req.headers.cookie ?? "");
    res.setHeader("Content-Type", "text/html");
    res.end(`<div id=who>${signedIn ? "signed in as trevin" : "signed out"}</div>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "rs-session-"));
  try {
    // 1. reelscript login: press Enter once the prompt appears.
    let pressed = false;
    const login = await cli(["login", `${base}/login`, "--out", join(dir, "session.json")], {
      env: { REELSCRIPT_LOGIN_HEADLESS: "1" },
      onOutput: (all, stdin) => {
        if (!pressed && /press Enter/.test(all)) {
          pressed = true;
          setTimeout(() => stdin.write("\n"), 300);
        }
      },
    });
    assert.equal(login.code, 0, login.output);
    const saved = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
    assert.ok(saved.cookies.some((c: { name: string; value: string }) => c.name === "sid" && c.value === "abc123"));
    assert.equal(statSync(join(dir, "session.json")).mode & 0o777, 0o600, "session file is private");

    // 2. A demo using it is signed in; call() gets the page.
    const script = (session: boolean) => `import { createDemo } from "@reelscript/cli";
const demo = createDemo(${session ? `{ session: "./session.json" }` : ""});
await demo.browser.goto(${JSON.stringify(base + "/")});
await demo.call(({ page }) => { if (!page) throw new Error("call() got no page"); });
await demo.waitFor('#who:has-text("signed in as trevin")', { timeout: 3000 });
await demo.render("out.mp4");
`;
    writeFileSync(join(dir, "with.ts"), script(true));
    writeFileSync(join(dir, "without.ts"), script(false));
    const withSession = await cli(["check", join(dir, "with.ts")]);
    assert.equal(withSession.code, 0, withSession.output);
    assert.match(withSession.output, /check passed/);

    // 3. Without it the same demo fails, pointing at the waitFor line.
    const without = await cli(["check", join(dir, "without.ts")]);
    assert.notEqual(without.code, 0);
    assert.match(without.output, /without\.ts:5/);

    // 4. A missing session file is a clear error, not a browser stack trace.
    writeFileSync(join(dir, "missing.ts"), script(true).replace("./session.json", "./nope.json"));
    const missing = await cli(["check", join(dir, "missing.ts")]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.output, /session file not found[\s\S]*reelscript login/);
  } finally {
    server.close();
  }
});
