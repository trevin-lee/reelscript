#!/usr/bin/env node
/**
 * reelscript CLI. See usage() below for every command.
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

function usage(exitCode = 1): never {
  console.log(`reelscript ${version} - product demos as code

usage:
  reelscript render  <script> [--out demo.mp4]     render a script to .mp4 or .gif
  reelscript preview <script> --at <seconds> [--out frame.png]
                                                   render one frame as a PNG
  reelscript check   <script> [more scripts...]    run the timeline without rendering; fail on
                                                   anything missing, with the script line
  reelscript record  <script> [more...] [--prune]  run terminal commands for real and save
                                                   recordings; --prune deletes unused ones
  reelscript login   <url> [--out session.json]    sign in once in a real browser; save the session
  reelscript warmup  [narration] [editor]          download the voice model and VS Code ahead of time
  reelscript cache   [clear <part|all>]            show or clear what's cached on disk
  reelscript mcp                                   MCP server (stdio) for coding agents
  reelscript --version

Paths passed to the CLI are relative to the working directory; paths written
inside a script are relative to the script's folder.

env:
  REELSCRIPT_CACHE        cache folder (default ~/.cache/reelscript)
  REELSCRIPT_FFMPEG       ffmpeg to use (default: the bundled ffmpeg-static)
  REELSCRIPT_CODE_SERVER  code-server binary to use instead of downloading one
  REELSCRIPT_MODELS       folder for the narration model`);
  process.exit(exitCode);
}

const BOOLEAN_FLAGS = new Set(["prune", "help"]);

function parse(argv: string[]) {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      // On/off flags never take the next argument as their value.
      flags[k] = v ?? (BOOLEAN_FLAGS.has(k) ? "" : rest[++i] ?? "");
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
      if (!positional.length) usage();
      process.env.REELSCRIPT_RECORD = "1";
      for (const script of positional) await runScript(script);
      if ("prune" in flags) {
        // Remove recordings no given script uses. Scripts in one folder share
        // its recordings/, so pass every script that uses it.
        const { readdirSync, rmSync } = await import("node:fs");
        const { join, relative } = await import("node:path");
        const used = (globalThis as { __reelscript_recorded?: Map<string, Set<string>> }).__reelscript_recorded ?? new Map();
        let removed = 0;
        for (const [dir, files] of used) {
          for (const name of readdirSync(dir)) {
            const file = join(dir, name);
            if (!name.endsWith(".json") || files.has(file)) continue;
            rmSync(file);
            removed++;
            console.error(`reelscript: pruned ${relative(process.cwd(), file)}`);
          }
        }
        console.error(`reelscript: pruned ${removed} unused recording${removed === 1 ? "" : "s"}`);
      }
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
      const parts = positional.length ? positional : ["narration", "editor"];
      for (const part of parts) {
        const t = Date.now();
        if (part === "narration") {
          const { kokoro } = await import("./tts.js");
          await kokoro().synthesize("Ready.", {});
          console.error(`reelscript: narration model ready (${((Date.now() - t) / 1000).toFixed(1)}s)`);
        } else if (part === "editor") {
          const { ensureCodeServer } = await import("./editor.js");
          await ensureCodeServer((m) => console.error(`reelscript: ${m}`));
          console.error(`reelscript: editor ready (${((Date.now() - t) / 1000).toFixed(1)}s)`);
        } else {
          throw new Error(`reelscript: unknown warmup part "${part}" (narration, editor)`);
        }
      }
      break;
    }
    case "cache": {
      const { cacheParts, clearCache, formatBytes, sizeOf } = await import("./cache.js");
      const { cacheDir } = await import("./tts.js");
      if (positional[0] === "clear") {
        const part = positional[1] ?? usage();
        for (const path of clearCache(part)) console.error(`reelscript: removed ${path}`);
        break;
      }
      if (positional.length) usage();
      console.log(`reelscript cache: ${cacheDir()}`);
      for (const p of cacheParts()) {
        const where = p.builtIn ? `  (built in at ${p.path})` : "";
        console.log(`  ${p.name.padEnd(16)} ${formatBytes(sizeOf(p.path)).padStart(8)}  ${p.description}${where}`);
      }
      console.log(`clear a part with: reelscript cache clear <part|all>`);
      break;
    }
    case "--help":
    case "-h":
    case "help":
      usage(0);
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
