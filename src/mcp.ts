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
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const INSTRUCTIONS = `reelscript renders product demos from TypeScript scripts: a scripted cursor, typing, zooms, narration, and browser, terminal, and VS Code windows on a mocked macOS desktop.

Workflow for making a demo:
1. Call reelscript_docs once to learn the API.
2. Call inspect_page on the app's URL to get selectors for the elements you'll click and type into.
3. Write a script file (see the docs' example) that ends with await demo.render("out/demo.mp4").
4. If the script runs real terminal commands (terminal.run without output), call record_script to capture them.
5. Call check_script: it runs the whole timeline without rendering and reports the script line of any failing step. Fix and repeat until it passes.
6. Call preview_frame at the key moments and look at the images; adjust timing, zoom, and camera until it reads well.
7. Call render_script for the final video.

If the app needs a login, ask the user to run \`reelscript login <url> --out session.json\` once and pass createDemo({ session: "session.json" }).

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
const INSPECT_ELEMENTS = `(() => {
  const q = 'a,button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[contenteditable=true],[data-testid]';
  const out = [];
  const esc = (v) => v.replace(/"/g, '\\"');
  for (const el of Array.from(document.querySelectorAll(q))) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
    const tag = el.tagName.toLowerCase();
    const label = (el.value || el.innerText || el.getAttribute("placeholder") || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 60);
    let selector = "";
    if (el.id) selector = "#" + CSS.escape(el.id);
    else if (el.dataset.testid) selector = '[data-testid="' + esc(el.dataset.testid) + '"]';
    else if (el.getAttribute("aria-label")) selector = tag + '[aria-label="' + esc(el.getAttribute("aria-label")) + '"]';
    else if (el.getAttribute("name")) selector = tag + '[name="' + esc(el.getAttribute("name")) + '"]';
    else if (label) selector = tag + ':has-text("' + esc(label) + '")';
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
        "Open a URL in headless Chromium and list its visible interactive elements (buttons, links, inputs) with a suggested selector, text, and position. Optionally returns a screenshot.",
      inputSchema: {
        url: z.string().describe("Page URL, e.g. http://localhost:3000 or file:///path/app.html"),
        width: z.number().int().optional().describe("Viewport width. Default 1280"),
        height: z.number().int().optional().describe("Viewport height. Default 800"),
        screenshot: z.boolean().optional().describe("Include a screenshot. Default true"),
        session: z
          .string()
          .optional()
          .describe("Saved login from `reelscript login`, relative to the working directory, to inspect a page behind a sign-in"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ url, width = 1280, height = 800, screenshot = true, session }) => {
      const { chromium } = await import("playwright");
      const { resolveSession } = await import("./session.js");
      const storageState = session ? resolveSession(session, process.cwd()) : undefined;
      const browser = await chromium.launch();
      try {
        const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, storageState })).newPage();
        await page.goto(url, { waitUntil: "load" });
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
      inputSchema: { script: z.string().describe("Path to the demo script, relative to the working directory") },
      // Not read-only: it clicks through the real app and runs the script's demo.call() code.
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ script }) => {
      const { code, output } = await runCli(["check", resolve(script)]);
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
      },
    },
    async ({ script, out }) => {
      const args = ["render", resolve(script)];
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
        script: z.string().describe("Path to the demo script"),
        prune: z.boolean().optional().describe("Also delete recordings in that folder the script no longer uses. Default false"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ script, prune = false }) => {
      const args = ["record", resolve(script)];
      if (prune) args.push("--prune");
      const { code, output } = await runCli(args);
      return { content: [text(output || (code === 0 ? "recorded" : "record failed"))], isError: code !== 0 };
    },
  );

  await server.connect(new StdioServerTransport());
}
