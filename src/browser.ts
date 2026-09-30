/**
 * The Chromium build reelscript drives. Each Playwright version drives its
 * own build, and `npx playwright install` runs whichever Playwright the
 * project has, which in a project that already uses Playwright may be a
 * different version. So reelscript installs the browser itself, with its own
 * copy of Playwright, and says so when it's missing.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium, type Browser, type LaunchOptions } from "playwright";

/** The command that installs the browser reelscript drives: this form works with or without a local install. */
export const INSTALL_BROWSER = "npx @reelscript/cli warmup browser";

/** Whether a launch failed because the browser isn't installed. */
export function browserMissing(err: unknown): boolean {
  return err instanceof Error && /Executable doesn't exist/i.test(err.message);
}

/**
 * The system libraries a failed launch was missing, if that's why it failed
 * (Linux without Chromium's dependencies): named in the browser's log, or
 * in Playwright's own host check.
 */
export function missingLibraries(message: string): string[] | null {
  const named = [
    ...message.matchAll(/error while loading shared libraries: ([^:\s]+)/g),
    ...message.matchAll(/^[\s║]*(lib[\w.+-]+\.so[\w.]*)\s*║?$/gm),
  ].map((m) => m[1]);
  if (named.length) return [...new Set(named)];
  return /Host system is missing dependencies/i.test(message) ? [] : null;
}

/** Launch Chromium, or fail with what to do when it isn't installed or can't start. */
export async function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
  try {
    return await chromium.launch(options);
  } catch (err) {
    if (browserMissing(err)) {
      throw new Error(
        `reelscript: the browser reelscript drives isn't installed. Run:  ${INSTALL_BROWSER}\n` +
          "  (npx playwright install fetches a different build when your project has its own Playwright.)",
      );
    }
    const libs = err instanceof Error ? missingLibraries(err.message) : null;
    if (libs) {
      throw new Error(
        `reelscript: Chromium is installed but can't start: this system lacks libraries it needs${libs.length ? ` (${libs.join(", ")})` : ""}. ` +
          `Install them with:  ${INSTALL_BROWSER} --with-deps\n` +
          "  (That uses apt-get, with sudo unless you're root, on Debian and Ubuntu. Elsewhere, install Chromium's libraries with the system's package manager.)",
      );
    }
    throw err;
  }
}

/** Install Chromium and its headless shell with reelscript's own Playwright, and on Linux its system libraries if asked. */
export function installBrowser(withDeps = false): Promise<void> {
  const cli = join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
  const args = [cli, "install", ...(withDeps ? ["--with-deps"] : []), "chromium"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["inherit", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`reelscript: installing the browser failed (exit code ${code})`))));
  });
}

/** Start the installed browser once, so warmup never calls a browser ready that can't run. */
export async function verifyBrowser(): Promise<void> {
  const browser = await launchChromium({ headless: true });
  await browser.close();
}

/**
 * Chrome on macOS, as pages see it: the user agent, the client hint headers
 * (which otherwise name HeadlessChrome and the host's platform), and what
 * their scripts ask. Shared by the browser window, the editor, and MCP's
 * inspect_page, so what an agent inspects is what gets filmed.
 */
export function macChrome(browser: Browser): { userAgent: string; headers: Record<string, string>; script: string } {
  const chrome = browser.version().split(".")[0];
  return {
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`,
    headers: { "sec-ch-ua": `"Google Chrome";v="${chrome}", "Chromium";v="${chrome}", "Not_A Brand";v="8"`, "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"macOS"' },
    script: macPlatform(chrome),
  };
}

/** What a page's scripts ask about their platform, answered as Chrome on macOS. */
function macPlatform(chrome: string): string {
  return `
(() => {
  Object.defineProperty(Navigator.prototype, "platform", { configurable: true, get: () => "MacIntel" });
  Object.defineProperty(Navigator.prototype, "webdriver", { configurable: true, get: () => false });
  if (typeof NavigatorUAData === "undefined") return;
  const brands = () => [{ brand: "Google Chrome", version: "${chrome}" }, { brand: "Chromium", version: "${chrome}" }, { brand: "Not_A Brand", version: "8" }];
  const ua = NavigatorUAData.prototype;
  Object.defineProperty(ua, "platform", { configurable: true, get: () => "macOS" });
  Object.defineProperty(ua, "brands", { configurable: true, get: brands });
  const high = ua.getHighEntropyValues;
  ua.getHighEntropyValues = function (hints) {
    return high.call(this, hints).then((v) => ({ ...v, platform: "macOS", brands: brands(), ...(v.fullVersionList ? { fullVersionList: brands() } : {}) }));
  };
})();
`;
}
