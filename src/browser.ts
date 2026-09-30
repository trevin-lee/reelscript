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

/** The command that installs the browser reelscript drives. */
export const INSTALL_BROWSER = "npx reelscript warmup browser";

/** Whether a launch failed because the browser isn't installed. */
export function browserMissing(err: unknown): boolean {
  return err instanceof Error && /Executable doesn't exist/i.test(err.message);
}

/** Launch Chromium, or fail with the command that installs it. */
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
    throw err;
  }
}

/** Install Chromium and its headless shell with reelscript's own Playwright. */
export function installBrowser(): Promise<void> {
  const cli = join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "chromium"], { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`reelscript: installing the browser failed (exit code ${code})`))));
  });
}
