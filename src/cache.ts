/**
 * What reelscript keeps on disk between runs, and how to clear it.
 * Everything lives under one folder (REELSCRIPT_CACHE, default
 * ~/.cache/reelscript) unless REELSCRIPT_MODELS or REELSCRIPT_CODE_SERVER
 * point elsewhere, as they do in the container, where those are built in.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { cacheDir } from "./tts.js";

export interface CachePart {
  name: string;
  description: string;
  path: string;
  /** Outside the cache folder (built into the container image): listed, never cleared. */
  builtIn: boolean;
}

export function cacheParts(): CachePart[] {
  const root = cacheDir();
  const part = (name: string, description: string, path: string, override?: string): CachePart => ({
    name,
    description,
    path,
    builtIn: override !== undefined,
  });
  const codeServer = process.env.REELSCRIPT_CODE_SERVER;
  // A standalone code-server install is <root>/bin/code-server with <root>/lib/vscode;
  // anything else (a system package, a wrapper) is shown as just the binary.
  const install = codeServer ? join(codeServer, "..", "..") : "";
  const editorPath = codeServer ? (existsSync(join(install, "lib", "vscode")) ? install : codeServer) : join(root, "code-server");
  return [
    part("editor", "VS Code (code-server) for editor windows", editorPath, codeServer),
    part("extensions", "editor extensions installed from Open VSX or .vsix", join(root, "extensions")),
    part("narration", "the Kokoro voice model", modelsDir(), process.env.REELSCRIPT_MODELS),
    part("narration-clips", "spoken lines, reused while their text and voice are unchanged", join(root, "tts")),
  ];
}

/** Where the narration model is stored. */
export function modelsDir(): string {
  return process.env.REELSCRIPT_MODELS ?? join(cacheDir(), "models");
}

export function sizeOf(path: string): number {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const entry of readdirSync(path)) total += sizeOf(join(path, entry));
    return total;
  } catch {
    return 0; // missing or unreadable
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

/** Remove one part of the cache, or all of it. Returns what was removed. */
export function clearCache(name: string): string[] {
  const parts = cacheParts();
  const targets = name === "all" ? parts : parts.filter((p) => p.name === name);
  if (!targets.length) throw new Error(`reelscript: unknown cache part "${name}". Parts: ${parts.map((p) => p.name).join(", ")}, all`);
  const removed: string[] = [];
  for (const p of targets) {
    if (p.builtIn) {
      if (name !== "all") throw new Error(`reelscript: ${p.name} is built in here (${p.path}) and isn't cleared`);
      continue;
    }
    rmSync(p.path, { recursive: true, force: true });
    removed.push(p.path);
  }
  return removed;
}
