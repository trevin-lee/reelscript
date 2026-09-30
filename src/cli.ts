#!/usr/bin/env node
/**
 * reelscript CLI. See usage() below for every command.
 *
 * Scripts are ordinary TS/JS modules that build a Demo and call
 * `demo.render(...)`. The CLI runs them with tsx, overriding the output via
 * environment variables (see Demo.render).
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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
  reelscript render  <script> [more...] [--out demo.mp4]
                                                   render scripts to .mp4 or .gif
  reelscript preview <script> --at <seconds> [--out frame.png]
                                                   render one frame as a PNG
  reelscript check   <script> [more scripts...]    run the timeline without rendering; fail on
                                                   anything missing, with the script line
  reelscript record  <script> [more...] [--prune]  run terminal commands for real and save
                                                   recordings; --prune deletes unused ones
  reelscript login   <url> [--out session.json]    sign in once in a real browser; save the session
  reelscript warmup  [browser] [narration] [editor] [--with-deps]
                                                   download the browser, voice model and VS Code;
                                                   --with-deps adds Chromium's Linux libraries
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

const BOOLEAN_FLAGS = new Set(["prune", "help", "with-deps"]);

/** Whether a file is a terminal recording `reelscript record` wrote, and so safe to prune. */
function isRecording(file: string): boolean {
  try {
    const r = JSON.parse(readFileSync(file, "utf8"));
    return r?.version === 1 && typeof r.command === "string" && Array.isArray(r.events);
  } catch {
    return false;
  }
}

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
    if (!(err instanceof Error) || !/Top-level await|Cannot use import statement outside a module/.test(err.message)) throw err;
    const { copyFileSync, unlinkSync } = await import("node:fs");
    const { dirname, basename, join } = await import("node:path");
    const tmp = join(dirname(script), `.${basename(script).replace(/\.[cm]?[jt]sx?$/, "")}.reelscript.mts`);
    copyFileSync(script, tmp);
    const { onInterrupt } = await import("./cleanup.js");
    const unregister = onInterrupt(() => unlinkSync(tmp));
    try {
      await tsImport(pathToFileURL(tmp).href, import.meta.url);
    } finally {
      unregister();
      unlinkSync(tmp);
    }
  }
}

/** The options each command takes; anything else is an error rather than silently ignored. */
const OPTIONS: Record<string, string[]> = {
  render: ["out"],
  preview: ["at", "out"],
  check: [],
  record: ["prune"],
  login: ["out"],
  warmup: ["with-deps"],
  cache: [],
  mcp: [],
};

function fail(message: string): never {
  throw new Error(`reelscript: ${message}`);
}

async function main(): Promise<void> {
  const { command, flags, positional } = parse(process.argv.slice(2));
  if ("help" in flags) usage(0);
  const allowed = OPTIONS[command];
  if (allowed) {
    for (const k of Object.keys(flags)) {
      if (!allowed.includes(k)) {
        fail(`${command} has no --${k} option${allowed.length ? ` (it takes ${allowed.map((a) => `--${a}`).join(", ")})` : ""}`);
      }
    }
  }
  const { installInterruptHandlers } = await import("./cleanup.js");
  installInterruptHandlers();
  // A mistyped script path fails before anything runs, and not with Node's module error.
  if (["render", "preview", "check", "record"].includes(command)) {
    const missing = positional.find((p) => !existsSync(resolve(p)));
    if (missing !== undefined) fail(`no script at ${missing}`);
  }
  switch (command) {
    case "render": {
      if (!positional.length) usage();
      if (flags.out !== undefined && positional.length > 1) fail("--out names one video; render several scripts without it");
      if (flags.out) process.env.REELSCRIPT_OUT = resolve(flags.out);
      for (const script of positional) await runScript(script);
      break;
    }
    case "preview": {
      if (positional.length !== 1) fail("preview takes one script");
      const at = Number(flags.at ?? "0");
      if (!Number.isFinite(at) || at < 0) fail(`--at takes a time in seconds, not "${flags.at}"`);
      const out = flags.out ?? `preview-${at}s.png`;
      if (!out.toLowerCase().endsWith(".png")) fail(`preview writes a PNG; use a path ending in .png, not "${out}"`);
      process.env.REELSCRIPT_SNAPSHOT_AT = String(Math.round(at * 1000));
      process.env.REELSCRIPT_OUT = resolve(out);
      await runScript(positional[0]);
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
            if (!name.endsWith(".json") || files.has(file) || !isRecording(file)) continue;
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
      if (positional.length !== 1) fail("login takes one URL");
      const url = positional[0];
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
      const parts = positional.length ? positional : ["browser", "narration", "editor"];
      for (const part of parts) {
        const t = Date.now();
        if (part === "browser") {
          if (process.env.REELSCRIPT_BUILTIN) {
            console.error("reelscript: browser built into the image");
            continue;
          }
          const { installBrowser, verifyBrowser } = await import("./browser.js");
          await installBrowser("with-deps" in flags);
          await verifyBrowser();
          console.error(`reelscript: browser ready (${((Date.now() - t) / 1000).toFixed(1)}s)`);
        } else if (part === "narration") {
          const { kokoro } = await import("./tts.js");
          await kokoro().synthesize("Ready.", {});
          console.error(`reelscript: narration model ready (${((Date.now() - t) / 1000).toFixed(1)}s)`);
        } else if (part === "editor") {
          const { ensureCodeServer } = await import("./editor.js");
          await ensureCodeServer((m) => console.error(`reelscript: ${m}`));
          console.error(`reelscript: editor ready (${((Date.now() - t) / 1000).toFixed(1)}s)`);
        } else {
          throw new Error(`reelscript: unknown warmup part "${part}" (browser, narration, editor)`);
        }
      }
      break;
    }
    case "cache": {
      const { cacheParts, clearCache, formatBytes, partPaths, sizeOf } = await import("./cache.js");
      const { cacheDir } = await import("./tts.js");
      if (positional[0] === "clear") {
        const part = positional[1] ?? usage();
        for (const path of clearCache(part)) console.error(`reelscript: removed ${path}`);
        break;
      }
      if (positional.length) usage();
      console.log(`reelscript cache: ${cacheDir()}`);
      for (const p of cacheParts()) {
        const where = p.note ? `  (${p.note})` : "";
        console.log(`  ${p.name.padEnd(16)} ${formatBytes(partPaths(p).reduce((n, path) => n + sizeOf(path), 0)).padStart(8)}  ${p.description}${where}`);
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
      if (command !== undefined) console.error(`reelscript: unknown command "${command}"\n`);
      usage();
  }
}

main().catch(async (err) => {
  // After Ctrl-C, failures come from the clean-up itself; let it finish and exit.
  const { interrupted } = await import("./cleanup.js");
  if (interrupted()) return;
  console.error(err instanceof Error ? err.message : err);
  // Set the code and let the process wind down rather than process.exit(): the
  // voice model's native threads abort the process if it's torn down under them
  // (a C++ "mutex lock failed" and exit 134 on macOS). A timer that doesn't keep
  // the process alive forces the exit if anything else would.
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 5000).unref();
});
