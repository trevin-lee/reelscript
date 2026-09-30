/**
 * `reelscript mcp`: a Model Context Protocol server over stdio, so coding
 * agents can write demos the way a person would: read the API, inspect the
 * app for selectors, check the script, look at frames, and render.
 *
 *   claude mcp add reelscript -- npx -y @reelscript/cli mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

const INSTRUCTIONS = `reelscript renders product demos from TypeScript scripts: a scripted cursor, typing, zooms, narration, and browser, terminal, and VS Code windows on a mocked macOS desktop.

Workflow for making a demo:
1. Call reelscript_docs once to learn the API.
2. Call inspect_page on the app's URL to get selectors for the elements you'll click and type into.
3. Write a script file (see the docs' example) that ends with await demo.render("out/demo.mp4").
4. If the script runs real terminal commands (terminal.run without output), call record_script to capture them.
5. Call check_script: it runs the whole timeline without rendering and reports the script line of any failing step, and by default fails on warnings too, as CI's \`reelscript check --strict\` does. Fix and repeat until it passes.
6. Call preview_frame at the key moments and look at the images; adjust timing, zoom, and camera until it reads well.
7. Call render_script for the final video.

If the app needs a login, ask the user to run \`npx @reelscript/cli login <url> --out <path>\` once, then pass createDemo({ session }) with that file's path relative to the script (paths in a script are relative to the script's folder; CLI paths to the working directory). inspect_page takes the same file as its session argument, relative to the working directory. The demo's date is pinned; if the app checks its sign-in token's expiry (Supabase and Firebase do), give the demo createDemo({ clock: new Date() }) and inspect_page clock: "now".

Targets are Playwright selectors, so CSS, text= and role= forms all work. Prefer ids and data-testid attributes; they survive UI changes.`;

/** How to invoke this package's CLI from a child process (built or from source). */
function cli(): string[] {
  const js = fileURLToPath(new URL("./cli.js", import.meta.url));
  if (existsSync(js)) return [process.execPath, js];
  return [process.execPath, "--import", "tsx", fileURLToPath(new URL("./cli.ts", import.meta.url))];
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; output: string }> {
  const [cmd, ...pre] = cli();
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, [...pre, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (d) => (output += d.toString()));
    child.stderr!.on("data", (d) => (output += d.toString()));
    child.on("close", (code) => resolvePromise({ code, output: tidy(output) }));
  });
}

/** Drop progress-bar noise (carriage-return frame counters) from CLI output. */
function tidy(output: string): string {
  return output
    .split(/\r|\n/)
    .filter((l) => l.trim() && !/^reelscript: frame \d+/.test(l))
    .join("\n");
}

const text = (t: string) => ({ type: "text" as const, text: t });

/**
 * Collects visible interactive elements with a suggested selector. Kept as a
 * string so no transpiler helper (e.g. esbuild's __name) leaks into the page.
 */
/** Lists a page's visible interactive elements with a selector for each (inspect_page). */
export const INSPECT_ELEMENTS = `(() => {
  const q = 'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable=true],[data-testid]';
  const out = [];
  const esc = (v) => v.replace(/"/g, '\\"');
  // Web components' open shadow roots too: Playwright's selectors reach into them.
  const scopes = [document];
  for (let i = 0; i < scopes.length; i++) {
    const walker = document.createTreeWalker(scopes[i] === document ? document.documentElement : scopes[i], NodeFilter.SHOW_ELEMENT);
    for (let n = walker.currentNode; n; n = walker.nextNode()) if (n.shadowRoot) scopes.push(n.shadowRoot);
  }
  const found = scopes.flatMap((s) => Array.from(s.querySelectorAll(q)).map((el) => ({ el, r: el.getBoundingClientRect() })));
  found.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left); // reading order, wherever each lives
  for (const { el, r } of found) {
    const st = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || st.visibility !== "visible" || st.display === "none") continue;
    // Not inside anything faded all the way out (a closed modal): a script couldn't target it either.
    let faded = false;
    for (let n = el; n && !faded; n = n.parentElement || (n.getRootNode().host || null)) faded = getComputedStyle(n).opacity === "0";
    if (faded) continue;
    const tag = el.tagName.toLowerCase();
    // A text field is described by its placeholder or label, never by what's typed in it (a password, say);
    // and has-text() can't find it, since its text isn't its value.
    const field = tag === "textarea" || (tag === "input" && !/^(button|submit|reset)$/i.test(el.type));
    const wrapping = field ? el.closest("label") : null;
    const wrappingText = wrapping ? wrapping.innerText.replace(/\\s+/g, " ").trim() : "";
    const text = field
      ? el.getAttribute("placeholder") || el.getAttribute("aria-label") || (el.labels && el.labels[0] ? el.labels[0].innerText : "") || ""
      : el.value || el.innerText || el.getAttribute("aria-label") || "";
    const label = text.replace(/\\s+/g, " ").trim().slice(0, 60);
    let selector = "";
    if (el.id) selector = "#" + CSS.escape(el.id);
    else if (el.dataset.testid) selector = '[data-testid="' + esc(el.dataset.testid) + '"]';
    else if (el.getAttribute("aria-label")) selector = tag + '[aria-label="' + esc(el.getAttribute("aria-label")) + '"]';
    else if (el.getAttribute("name")) selector = tag + '[name="' + esc(el.getAttribute("name")) + '"]';
    else if (field && el.getAttribute("placeholder")) selector = tag + '[placeholder="' + esc(el.getAttribute("placeholder")) + '"]';
    else if (field && wrappingText) selector = 'label:has-text("' + esc(wrappingText.slice(0, 60)) + '") >> ' + tag;
    else if (!field && label) selector = tag + ':has-text("' + esc(label) + '")';
    else continue;
    out.push({ tag, selector, label, box: Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.width) + "x" + Math.round(r.height) });
    if (out.length >= 80) break;
  }
  return out;
})()`;

export async function serve(): Promise<void> {
  const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const server = new McpServer({ name: "reelscript", version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "reelscript_docs",
    {
      title: "reelscript API reference",
      description: "The full reelscript README: concepts, the complete API, and examples of browser, terminal, editor, and narration demos.",
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [text(readFileSync(new URL("../README.md", import.meta.url), "utf8"))] }),
  );

  server.registerTool(
    "inspect_page",
    {
      title: "Inspect a page for selectors",
      description:
        "Open a page as a demo's browser shows it (Chrome on a Mac, the demo's clock and timezone) and list its visible interactive elements (buttons, links, inputs) with a suggested selector, text, and position. Optionally returns a screenshot.",
      inputSchema: {
        url: z.string().describe("Page URL, e.g. http://localhost:3000, or a path to a local page relative to the working directory, e.g. demos/app.html"),
        width: z.number().int().optional().describe("Viewport width. Default 1280"),
        height: z.number().int().optional().describe("Viewport height. Default 800"),
        screenshot: z.boolean().optional().describe("Include a screenshot. Default true"),
        session: z
          .string()
          .optional()
          .describe("Saved login from `reelscript login`, relative to the working directory, to inspect a page behind a sign-in"),
        clock: z
          .string()
          .optional()
          .describe('The page\'s date, as a demo\'s clock option: an ISO date, or "now" for the real one (with a session, when the app checks its token\'s expiry). Default: the demo default, 2025-09-23 9:41 AM'),
        timezone: z.string().optional().describe('IANA timezone, as a demo\'s timezone option. Default "UTC"'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ url, width = 1280, height = 800, screenshot = true, session, clock, timezone }) => {
      const { launchChromium } = await import("./browser.js");
      const { resolveSession } = await import("./session.js");
      const { macChrome } = await import("./browser.js");
      const { dateShim } = await import("./clock.js");
      const { DEFAULT_CLOCK, DEFAULT_TIMEZONE, clockEpoch } = await import("./time.js");
      const storageState = session ? resolveSession(session, process.cwd(), "working directory") : undefined;
      const browser = await launchChromium();
      try {
        // The page as a demo's browser shows it: Chrome on a Mac, on the demo's date and timezone.
        const zone = timezone ?? DEFAULT_TIMEZONE;
        const epoch = clock === "now" ? Date.now() : clockEpoch(clock ?? DEFAULT_CLOCK, zone);
        const mac = macChrome(browser);
        const context = await browser.newContext({
          viewport: { width, height },
          deviceScaleFactor: 1,
          colorScheme: "light",
          storageState,
          timezoneId: zone,
          userAgent: mac.userAgent,
          extraHTTPHeaders: mac.headers,
        });
        await context.addInitScript(mac.script);
        await context.addInitScript(dateShim(epoch));
        const page = await context.newPage();
        // A path is a local page, relative to the working directory like every path given to a tool.
        await page.goto(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : pathToFileURL(resolve(url)).href, { waitUntil: "load" });
        const elements = (await page.evaluate(INSPECT_ELEMENTS)) as { tag: string; selector: string; label: string; box: string }[];
        const lines = elements.map((e) => `${e.tag.padEnd(9)} ${e.selector.padEnd(36)} ${JSON.stringify(e.label).padEnd(30)} at ${e.box}`);
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          text(`${elements.length} interactive elements on ${await page.title() || url}:\n${lines.join("\n") || "(none found)"}`),
        ];
        if (screenshot) {
          const png = await page.screenshot({ type: "png" });
          content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
        }
        return { content };
      } finally {
        await browser.close();
      }
    },
  );

  server.registerTool(
    "check_script",
    {
      title: "Check a demo script",
      description:
        "Run a script's whole timeline against the real app without rendering. Passes in seconds, or fails with the script line of the first step whose selector, command, or recording is missing.",
      inputSchema: {
        script: z.string().describe("Path to the demo script, relative to the working directory"),
        strict: z
          .boolean()
          .optional()
          .describe("Fail on warnings too (a page that answered 404, a mock no request used, an ambiguous target), as `reelscript check --strict` does in CI. Default true"),
      },
      // Not read-only: it clicks through the real app and runs the script's demo.call() code.
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ script, strict = true }) => {
      const { code, output } = await runCli(["check", resolve(script), ...(strict ? ["--strict"] : [])]);
      return { content: [text(output || (code === 0 ? "check passed" : "check failed"))], isError: code !== 0 };
    },
  );

  server.registerTool(
    "preview_frame",
    {
      title: "Preview one frame of a demo",
      description: "Render the single frame at a given time of a script and return it as an image, to judge framing, zoom, and timing without rendering the whole video.",
      inputSchema: {
        script: z.string().describe("Path to the demo script"),
        at: z.number().describe("Time in seconds"),
        width: z.number().int().optional().describe("Resize the returned image to this width. Default 1280"),
      },
      // Not read-only: the timeline up to that moment runs against the real app.
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ script, at, width = 1280 }) => {
      const dir = mkdtempSync(join(tmpdir(), "reelscript-preview-"));
      const out = join(dir, "frame.png");
      try {
        const { code, output } = await runCli(["preview", resolve(script), "--at", String(at), "--out", out]);
        if (code !== 0 || !existsSync(out)) return { content: [text(output || "preview failed")], isError: true };
        const png = await sharp(out).resize({ width, withoutEnlargement: true }).png().toBuffer();
        return { content: [text(output), { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  server.registerTool(
    "render_script",
    {
      title: "Render a demo",
      description: "Render a script to a video or GIF (by extension). Returns the output path and stats.",
      inputSchema: {
        script: z.string().describe("Path to the demo script"),
        out: z.string().optional().describe("Output path (.mp4 or .gif). Default: whatever the script passes to render()"),
        strict: z.boolean().optional().describe("Fail on warnings, keeping the previous video, as `reelscript render --strict` does. Default false"),
      },
    },
    async ({ script, out, strict = false }) => {
      const args = ["render", resolve(script), ...(strict ? ["--strict"] : [])];
      if (out) args.push("--out", resolve(out));
      const { code, output } = await runCli(args);
      return { content: [text(output || (code === 0 ? "rendered" : "render failed"))], isError: code !== 0 };
    },
  );

  server.registerTool(
    "record_script",
    {
      title: "Record a script's terminal commands",
      description:
        "Run, for real, every terminal.run command in the script that has no declared output, and save the recordings beside the script so renders can replay them. Runs shell commands on this machine.",
      inputSchema: {
        scripts: z.array(z.string()).min(1).describe("Paths to the demo scripts. With prune, list every script that shares the recordings folder"),
        prune: z
          .boolean()
          .optional()
          .describe("Also delete recordings in those scripts' folders that none of the listed scripts uses. Default false"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ scripts, prune = false }) => {
      const args = ["record", ...scripts.map((s) => resolve(s))];
      if (prune) args.push("--prune");
      const { code, output } = await runCli(args);
      return { content: [text(output || (code === 0 ? "recorded" : "record failed"))], isError: code !== 0 };
    },
  );

  await server.connect(new StdioServerTransport());
}
