/**
 * Saved logins. `reelscript login <url>` opens a real browser, lets you sign
 * in by hand, and saves the cookies and local storage (a Playwright storage
 * state) to a file; `createDemo({ session })` starts every browser window
 * signed in with it.
 */
import { chromium, type BrowserContext } from "playwright";
import { INSTALL_BROWSER, browserMissing } from "./browser.js";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface LoginResult {
  path: string;
  cookies: number;
  origins: number;
}

/** Resolve and validate a session path before a render starts. */
export function resolveSession(path: string, baseDir: string, relativeTo: "script" | "working directory" = "script"): string {
  const full = resolve(baseDir, path);
  if (!existsSync(full)) {
    throw new Error(
      `reelscript: session file not found: ${full}\n` +
        (relativeTo === "script" ? `  Paths in a script are relative to the script's folder.\n` : `  This path is relative to the working directory.\n`) +
        `  Create it by signing in once:  reelscript login <url of your app> --out ${full}`,
    );
  }
  return full;
}

export async function login(url: string, out: string, log: (m: string) => void = console.error): Promise<LoginResult> {
  const headless = process.env.REELSCRIPT_LOGIN_HEADLESS === "1"; // tests only
  let browser;
  try {
    browser = await chromium.launch({ headless });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // The container has only the headless browser, and a server has no screen to show one on.
    if (process.env.REELSCRIPT_BUILTIN || /XServer|\$DISPLAY/i.test(msg)) {
      throw new Error(
        "reelscript: login opens a visible browser, which this environment can't show.\n" +
          "  Sign in on your own machine instead, and pass the session file in.",
      );
    }
    if (browserMissing(err)) throw new Error(`reelscript: login opens Chromium, which isn't installed. Run:  ${INSTALL_BROWSER}`);
    throw err;
  }
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Keep a recent snapshot so closing the window still saves the session.
    let latest: StorageState = await context.storageState({ indexedDB: true });
    const poll = setInterval(() => {
      context.storageState({ indexedDB: true }).then((s) => (latest = s), () => {});
    }, 1000);

    log(`reelscript: sign in in the browser window, then press Enter here (or close the window) to save the session.`);
    const rl = createInterface({ input: process.stdin });
    await new Promise<void>((done) => {
      rl.once("line", () => done());
      rl.once("close", () => done());
      page.once("close", () => done());
      browser!.once("disconnected", () => done());
    });
    rl.close();
    clearInterval(poll);
    try {
      latest = await context.storageState({ indexedDB: true });
    } catch {
      /* window already closed; use the last snapshot */
    }

    const path = resolve(out);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(latest, null, 2) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
    return { path, cookies: latest.cookies.length, origins: latest.origins.length };
  } finally {
    await browser.close().catch(() => {});
  }
}
