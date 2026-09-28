#!/usr/bin/env node
/**
 * reelscript CLI
 *
 *   reelscript render  <script.ts> [--out demo.mp4]
 *   reelscript preview <script.ts> --at 2.5 [--out frame.png]
 *
 * Scripts are ordinary TS/JS modules that build a Demo and call
 * `demo.render(...)`. The CLI runs them with tsx, overriding the output via
 * environment variables (see Demo.render).
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire, register } from "node:module";

// Let scripts import "@reelscript/cli" without a local install (global, npx,
// the container): resolve it to the copy of the library running this CLI.
// Registered as an inline module so there's no hook file to resolve, which
// newer Node versions load in a separate thread without the TS loader.
{
  const built = new URL("./index.js", import.meta.url);
  const self = (existsSync(fileURLToPath(built)) ? built : new URL("./index.ts", import.meta.url)).href;
  const hook = `export async function resolve(specifier, context, next) {
  if (specifier === "@reelscript/cli") return { url: ${JSON.stringify(self)}, shortCircuit: true };
  return next(specifier, context);
}`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`);
}

const require = createRequire(import.meta.url);
const version: string = require("../package.json").version;

function usage(): never {
  console.log(`reelscript ${version} — product demos as code

usage:
  reelscript render  <script> [--out demo.mp4]
  reelscript preview <script> --at <seconds> [--out frame.png]
  reelscript check   <script>            run the timeline without rendering; fail on missing selectors
  reelscript record  <script>            run terminal commands for real and save recordings
  reelscript login   <url> [--out session.json]   sign in once in a real browser and save the session
  reelscript warmup                      download the narration model into the cache
  reelscript mcp                         run the MCP server (stdio) for coding agents

env:
  REELSCRIPT_FFMPEG   path to ffmpeg (defaults to bundled ffmpeg-static)`);
  process.exit(1);
}

function parse(argv: string[]) {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      flags[k] = v ?? rest[++i] ?? "";
    } else positional.push(a);
  }
  return { command, flags, positional };
}

/** Run a script and fail if it never called demo.render(), which would otherwise pass silently. */
async function runScript(path: string): Promise<void> {
  const g = globalThis as { __reelscript_runs?: number };
  const before = g.__reelscript_runs ?? 0;
  await importScript(path);
  if ((g.__reelscript_runs ?? 0) === before) {
    throw new Error(`reelscript: ${path} finished without calling demo.render(), so there was nothing to render, check or record`);
  }
}

async function importScript(path: string): Promise<void> {
  const script = resolve(path);
  process.env.REELSCRIPT_SCRIPT = script;
  const { tsImport } = await import("tsx/esm/api");
  try {
    await tsImport(pathToFileURL(script).href, import.meta.url);
  } catch (err) {
    // A .ts/.js script in a project without "type": "module" is compiled as
    // CommonJS, which forbids top-level await. Re-run it as an ES module via
    // a temporary .mts copy beside the original so relative paths still work.
    if (!(err instanceof Error) || !/Top-level await/.test(err.message)) throw err;
    const { copyFileSync, unlinkSync } = await import("node:fs");
    const { dirname, basename, join } = await import("node:path");
    const tmp = join(dirname(script), `.${basename(script).replace(/\.[cm]?[jt]sx?$/, "")}.reelscript.mts`);
    copyFileSync(script, tmp);
    try {
      await tsImport(pathToFileURL(tmp).href, import.meta.url);
    } finally {
      unlinkSync(tmp);
    }
  }
}

async function main(): Promise<void> {
  const { command, flags, positional } = parse(process.argv.slice(2));
  switch (command) {
    case "render": {
      const script = positional[0] ?? usage();
      if (flags.out) process.env.REELSCRIPT_OUT = resolve(flags.out);
      await runScript(script);
      break;
    }
    case "preview": {
      const script = positional[0] ?? usage();
      const at = Number(flags.at ?? "0");
      process.env.REELSCRIPT_SNAPSHOT_AT = String(Math.round(at * 1000));
      process.env.REELSCRIPT_OUT = resolve(flags.out ?? `preview-${at}s.png`);
      await runScript(script);
      break;
    }
    case "check": {
      if (!positional.length) usage();
      for (const script of positional) {
        process.env.REELSCRIPT_CHECK = "1";
        await runScript(script);
      }
      break;
    }
    case "record": {
      const script = positional[0] ?? usage();
      process.env.REELSCRIPT_RECORD = "1";
      await runScript(script);
      break;
    }
    case "mcp": {
      const { serve } = await import("./mcp.js");
      await serve();
      break;
    }
    case "login": {
      const url = positional[0] ?? usage();
      const out = flags.out || "session.json";
      const { login } = await import("./session.js");
      const r = await login(url, out);
      console.error(
        `reelscript: saved ${r.cookies} cookie${r.cookies === 1 ? "" : "s"} and storage for ${r.origins} origin${r.origins === 1 ? "" : "s"} to ${r.path}\n` +
          `  Use it with createDemo({ session: "<path to it from your script's folder>" }). It signs in as you: keep it out of git.`,
      );
      break;
    }
    case "warmup": {
      const { kokoro } = await import("./tts.js");
      const t = Date.now();
      await kokoro().synthesize("Ready.", {});
      console.log(`narration model ready (${((Date.now() - t) / 1000).toFixed(1)}s)`);
      break;
    }
    case "--version":
    case "-v":
      console.log(version);
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
