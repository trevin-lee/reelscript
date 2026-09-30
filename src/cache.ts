/**
 * What reelscript keeps on disk between runs, and how to clear it.
 * Everything lives under one folder (REELSCRIPT_CACHE, default
 * ~/.cache/reelscript) unless REELSCRIPT_MODELS or REELSCRIPT_CODE_SERVER
 * point elsewhere, as they do in the container, where those are built in;
 * the browser lives in Playwright's own folder.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { KOKORO_MODEL, cacheDir } from "./tts.js";

export interface CachePart {
  name: string;
  description: string;
  path: string;
  /** More folders that belong to it. */
  also?: string[];
  /** Outside reelscript's folder and shared with other tools: cleared only by name, never by "all". */
  shared?: boolean;
  /** Not reelscript's to delete: built into the container, or a binary you pointed at. Listed, never cleared. */
  builtIn: boolean;
  /** Why it isn't cleared, for the listing. */
  note?: string;
}

export function cacheParts(): CachePart[] {
  const root = cacheDir();
  // The container marks where its own copies live; only those count as built in.
  const builtInDir = process.env.REELSCRIPT_BUILTIN;
  const isBuiltIn = (p: string) => !!builtInDir && p.startsWith(builtInDir);
  const part = (name: string, description: string, path: string, note?: string): CachePart => ({
    name,
    description,
    path,
    builtIn: isBuiltIn(path) || note !== undefined,
    note: isBuiltIn(path) ? `built in at ${path}` : note,
  });
  const codeServer = process.env.REELSCRIPT_CODE_SERVER;
  // A standalone code-server install is <root>/bin/code-server with <root>/lib/vscode;
  // anything else (a system package, a wrapper) is shown as just the binary.
  const install = codeServer ? join(codeServer, "..", "..") : "";
  const editorPath = codeServer ? (existsSync(join(install, "lib", "vscode")) ? install : codeServer) : join(root, "code-server");
  const editorNote = codeServer && !isBuiltIn(editorPath) ? `REELSCRIPT_CODE_SERVER: ${codeServer}` : undefined;
  return [
    ...browserPart(builtInDir),
    part("editor", "VS Code (code-server) for editor windows", editorPath, editorNote),
    part("extensions", "editor extensions installed from Open VSX or .vsix", join(root, "extensions")),
    // reelscript's own models folder is cleared whole (any voice model it
    // downloaded); a folder set with REELSCRIPT_MODELS may hold other things,
    // so only the default Kokoro model is cleared there.
    part("narration", "voice models", process.env.REELSCRIPT_MODELS ? join(modelsDir(), KOKORO_MODEL) : modelsDir()),
    part("narration-clips", "spoken lines, reused while their text and voice are unchanged", join(root, "tts")),
  ];
}

/**
 * The Chromium build reelscript's Playwright drives, and its headless shell.
 * They live in Playwright's folder (PLAYWRIGHT_BROWSERS_PATH, or its default),
 * shared with other projects on the same Playwright version.
 */
function browserPart(builtInDir: string | undefined): CachePart[] {
  const m = chromium.executablePath().match(/^(.*)[\\/]chromium-(\d+)[\\/]/);
  if (!m) return [];
  const [, folder, build] = m;
  return [{
    name: "browser",
    description: "Chromium and its headless shell",
    path: join(folder, `chromium-${build}`),
    also: [join(folder, `chromium_headless_shell-${build}`)],
    builtIn: !!builtInDir, // the container's own
    shared: true,
    note: builtInDir ? `built in at ${folder}` : `in Playwright's folder, ${folder}`,
  }];
}

/** Every folder of a part. */
export function partPaths(p: CachePart): string[] {
  return [p.path, ...(p.also ?? [])];
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
  const targets = name === "all" ? parts.filter((p) => !p.shared) : parts.filter((p) => p.name === name);
  if (!targets.length) throw new Error(`reelscript: unknown cache part "${name}". Parts: ${parts.map((p) => p.name).join(", ")}, all`);
  const removed: string[] = [];
  for (const p of targets) {
    if (p.builtIn) {
      if (name !== "all") throw new Error(`reelscript: ${p.name} isn't reelscript's to clear here (${p.note})`);
      continue;
    }
    for (const path of partPaths(p)) {
      if (!existsSync(path)) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  return removed;
}
