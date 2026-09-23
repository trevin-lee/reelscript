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
import { pathToFileURL } from "node:url";
import { createRequire, register } from "node:module";

// Let scripts import "@reelscript/cli" without a local install (see resolve-self.ts).
register(new URL("./resolve-self.js", import.meta.url));

const require = createRequire(import.meta.url);
const version: string = require("../package.json").version;

function usage(): never {
  console.log(`reelscript ${version} — product demos as code

usage:
  reelscript render  <script> [--out demo.mp4]
  reelscript preview <script> --at <seconds> [--out frame.png]
  reelscript record  <script>            run terminal commands for real and save recordings
  reelscript warmup                      download the narration model into the cache

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

async function runScript(path: string): Promise<void> {
  process.env.REELSCRIPT_SCRIPT = resolve(path);
  const { tsImport } = await import("tsx/esm/api");
  await tsImport(pathToFileURL(resolve(path)).href, import.meta.url);
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
    case "record": {
      const script = positional[0] ?? usage();
      process.env.REELSCRIPT_RECORD = "1";
      await runScript(script);
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
