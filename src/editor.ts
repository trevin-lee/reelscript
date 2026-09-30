/**
 * Editor window: a real VS Code (code-server, MIT, Code - OSS based) served
 * from a child process and shown in a Chromium page. Real extensions can be
 * installed from a .vsix or from Open VSX, so demos can show dev tools and
 * extensions exactly as users would see them.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cacheDir } from "./tts.js";
import { interrupted, onInterrupt } from "./cleanup.js";

export const CODE_SERVER_VERSION = "4.138.0";


/** Settings that make VS Code behave like a demo stage: no welcome, no AI panel, no surprises when typing code. */
export const EDITOR_DEFAULT_SETTINGS: Record<string, unknown> = {
  "workbench.colorTheme": "Default Dark Modern",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.reduceMotion": "on",
  "workbench.layoutControl.enabled": false,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.disableAIFeatures": true,
  "window.commandCenter": false,
  "window.menuBarVisibility": "hidden",
  "editor.fontFamily": "JetBrains Mono",
  "editor.fontSize": 14,
  "editor.cursorBlinking": "solid",
  "editor.cursorSmoothCaretAnimation": "off",
  "editor.smoothScrolling": false,
  "editor.autoIndent": "none",
  "editor.autoClosingBrackets": "never",
  "editor.autoClosingQuotes": "never",
  "editor.acceptSuggestionOnEnter": "off",
  "editor.formatOnType": false,
  "files.autoSave": "off",
  "git.openRepositoryInParentFolders": "never",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
};

/** CSS injected into the workbench: bundled fonts and demo-unfriendly chrome hidden. */
export function editorStyles(notifications: boolean): string {
  return `
@font-face { font-family: "JetBrains Mono"; font-weight: 100 800; src: url(/__reelscript/fonts/JetBrainsMono-Variable.ttf) format("truetype"); }
@font-face { font-family: "Inter"; font-weight: 100 900; src: url(/__reelscript/fonts/InterVariable.ttf) format("truetype"); }
.monaco-workbench { font-family: Inter, system-ui, sans-serif !important; }
.statusbar-item[id="status.workbench.keyboardLayout"] { display: none !important; }
.editor-group-container .editor-group-watermark { display: none !important; }
${notifications ? "" : ".notifications-toasts { display: none !important; }"}`;
}

/** "app.ts - acme - code-server" → "app.ts — acme". */
export function editorTitle(pageTitle: string, fallback: string): string {
  const parts = pageTitle
    .split(" - ")
    .map((p) => p.trim())
    .filter((p) => p && p.toLowerCase() !== "code-server");
  return parts.length ? parts.join(" — ") : fallback;
}

function platformSuffix(): string {
  const os = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (!os || !arch) {
    throw new Error(`reelscript: the editor window needs code-server, which has no build for ${process.platform}/${process.arch}`);
  }
  return `${os}-${arch}`;
}

/** Path to the code-server binary, downloading the pinned standalone build into the cache on first use. */
export async function ensureCodeServer(onStatus?: (m: string) => void): Promise<string> {
  if (process.env.REELSCRIPT_CODE_SERVER) return process.env.REELSCRIPT_CODE_SERVER;
  const dir = join(cacheDir(), "code-server", CODE_SERVER_VERSION);
  const bin = join(dir, "bin", "code-server");
  if (existsSync(bin)) return bin;
  const suffix = platformSuffix();
  const url = `https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-${suffix}.tar.gz`;
  onStatus?.(`downloading code-server ${CODE_SERVER_VERSION} (${suffix}, about 200 MB, once)`);
  mkdirSync(dir, { recursive: true });
  const tgz = join(dir, "code-server.tar.gz");
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`reelscript: could not download ${url} (${res.status})`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tgz));
  await run("tar", ["-xzf", tgz, "-C", dir, "--strip-components=1"]);
  rmSync(tgz, { force: true });
  if (!existsSync(bin)) throw new Error("reelscript: code-server download did not produce a binary");
  return bin;
}

/**
 * code-server writes its logs under $XDG_DATA_HOME (~/.local/share/code-server
 * by default), outside anything reelscript lists or clears; each run keeps
 * them in its own temporary folder instead.
 */
const logsIn = (dir: string) => ({ ...process.env, XDG_DATA_HOME: join(dir, "data") });

function run(cmd: string, args: string[], logDir?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], env: logDir ? logsIn(logDir) : process.env });
    let err = "";
    p.stderr!.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`))));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export interface EditorServerConfig {
  /** Folder to open. Copied to a temp dir so the demo never edits the source. */
  workspace?: string;
  /**
   * Extensions to load: Open VSX ids ("esbenp.prettier-vscode"), paths to
   * .vsix files, or paths to extension folders (a directory with a
   * package.json, e.g. the extension you're developing). Paths resolve
   * against `baseDir`.
   */
  extensions?: string[];
  settings?: Record<string, unknown>;
  baseDir?: string;
}

/**
 * Copy an unpacked extension folder into the extensions dir under the name
 * VS Code expects and register it in the directory's manifest. Returns the
 * copy's path.
 */
interface ManifestEntry {
  identifier: { id: string; uuid?: string };
  version: string;
  location: { $mid: number; path: string; scheme: string };
  relativeLocation: string;
  metadata?: Record<string, unknown>;
}

function readManifest(extensionsDir: string): ManifestEntry[] {
  const path = join(extensionsDir, "extensions.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ManifestEntry[]) : [];
}

/** Add or replace entries in a directory's manifest (matched by extension id). */
function writeManifestEntries(extensionsDir: string, entries: ManifestEntry[]): void {
  const ids = new Set(entries.map((e) => e.identifier.id.toLowerCase()));
  const kept = readManifest(extensionsDir).filter((e) => !ids.has(e.identifier.id.toLowerCase()));
  writeFileSync(join(extensionsDir, "extensions.json"), JSON.stringify([...kept, ...entries]));
}

/**
 * Copy every extension from an installed extensions directory (a cache
 * entry) into a render's own extensions directory and register them there,
 * with locations rewritten to the copies.
 */
export function copyInstalledExtensions(fromDir: string, toDir: string): string[] {
  const entries = readManifest(fromDir);
  const copied: ManifestEntry[] = [];
  for (const e of entries) {
    const src = join(fromDir, e.relativeLocation);
    if (!existsSync(src)) continue;
    const dest = join(toDir, e.relativeLocation);
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, dereference: true });
    copied.push({ ...e, location: { ...e.location, path: dest } });
  }
  writeManifestEntries(toDir, copied);
  return copied.map((e) => e.identifier.id);
}

/**
 * An Open VSX id or .vsix, installed once into its own cache directory and
 * reused after that. Open VSX ids are cached by the exact string, so pin a
 * version with "publisher.name@1.2.3"; .vsix files are cached by content.
 */
async function cachedInstall(bin: string, spec: string, vsixPath: string | null, onStatus?: (m: string) => void): Promise<string> {
  const key = vsixPath
    ? `vsix-${createHash("sha1").update(readFileSync(vsixPath)).digest("hex").slice(0, 16)}`
    : `openvsx-${spec.toLowerCase().replace(/[^a-z0-9.@-]+/g, "_")}`;
  const entry = join(cacheDir(), "extensions", key);
  if (existsSync(join(entry, "extensions.json"))) return entry;
  onStatus?.(`installing extension ${spec} (cached after this)`);
  // Staged inside the cache folder, so moving it into place is a rename on the
  // same filesystem (a mounted /cache or a tmpfs /tmp would make it cross devices).
  mkdirSync(join(cacheDir(), "extensions"), { recursive: true });
  const scratch = mkdtempSync(join(cacheDir(), "extensions", ".staging-"));
  try {
    mkdirSync(join(scratch, "ext"));
    mkdirSync(join(scratch, "user"));
    writeFileSync(join(scratch, "config.yaml"), "auth: none\n");
    await run(bin, [
      "--config", join(scratch, "config.yaml"),
      "--user-data-dir", join(scratch, "user"),
      "--extensions-dir", join(scratch, "ext"),
      "--install-extension", vsixPath ?? spec,
    ], scratch);
    if (!existsSync(join(scratch, "ext", "extensions.json"))) {
      throw new Error(`reelscript: installing extension ${spec} produced nothing`);
    }
    mkdirSync(join(cacheDir(), "extensions"), { recursive: true });
    rmSync(entry, { recursive: true, force: true });
    renameSync(join(scratch, "ext"), entry);
    return entry;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function registerExtensionFolder(folder: string, extensionsDir: string): string {
  const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { name?: string; publisher?: string; version?: string };
  if (!pkg.name || !pkg.publisher) {
    throw new Error(`reelscript: ${folder}/package.json needs "name" and "publisher" to load as an extension`);
  }
  const version = pkg.version ?? "0.0.0";
  const id = `${pkg.publisher}.${pkg.name}`;
  const relative = `${id}-${version}`;
  const target = join(extensionsDir, relative);
  rmSync(target, { recursive: true, force: true });
  cpSync(folder, target, { recursive: true, dereference: true });
  // VS Code only loads user extensions listed in the directory's manifest,
  // so register the copy the way `--install-extension` would.
  writeManifestEntries(extensionsDir, [
    {
      identifier: { id },
      version,
      location: { $mid: 1, path: target, scheme: "file" },
      relativeLocation: relative,
      metadata: { installedTimestamp: Date.now(), pinned: true, source: "vsix" },
    },
  ]);
  return target;
}

/** One code-server process for the render, on a random local port. */
export class EditorServer {
  private root = "";
  private proc: ReturnType<typeof spawn> | null = null;
  port = 0;
  /** Absolute path of the (copied) workspace folder. */
  workspace = "";

  private configKey = "";

  async start(config: EditorServerConfig, onStatus?: (m: string) => void): Promise<void> {
    this.configKey = JSON.stringify([config.workspace, config.extensions ?? [], config.settings ?? {}]);
    const bin = await ensureCodeServer(onStatus);
    this.root = mkdtempSync(join(tmpdir(), "reelscript-editor-"));
    // From the moment the folder exists, an interrupt cleans it up.
    this.unregister = onInterrupt(() => this.stop());
    const userData = join(this.root, "user-data");
    mkdirSync(join(userData, "User"), { recursive: true });
    writeFileSync(join(userData, "User", "settings.json"), JSON.stringify({ ...EDITOR_DEFAULT_SETTINGS, ...config.settings }, null, 2));
    writeFileSync(join(this.root, "config.yaml"), "auth: none\n");
    // Each render gets its own extensions directory, so an extension loaded by
    // one demo never shows up in another. Downloads are cached separately.
    const extensionsDir = join(this.root, "extensions");
    mkdirSync(extensionsDir, { recursive: true });

    const name = config.workspace ? basename(config.workspace) : "workspace";
    this.workspace = join(this.root, name);
    if (config.workspace) cpSync(config.workspace, this.workspace, { recursive: true });
    else mkdirSync(this.workspace);

    const common = ["--config", join(this.root, "config.yaml"), "--user-data-dir", userData, "--extensions-dir", extensionsDir];
    const baseDir = config.baseDir ?? process.cwd();
    for (const ext of config.extensions ?? []) {
      // Anything that exists beside the script is a path ("acme-ext" as well as
      // "./acme-ext"); otherwise it's an Open VSX id, unless it looks like a path.
      const candidate = resolve(baseDir, ext);
      const looksLikePath = ext.endsWith(".vsix") || ext.includes("/") || ext.startsWith(".");
      const path = existsSync(candidate) || looksLikePath ? candidate : null;
      if (path && !existsSync(path)) throw new Error(`reelscript: extension not found: ${path}`);
      if (path && statSync(path).isDirectory()) {
        onStatus?.(`loading extension folder ${ext}`);
        registerExtensionFolder(path, extensionsDir);
      } else {
        const entry = await cachedInstall(bin, ext, path, onStatus);
        if (interrupted()) throw new Error("reelscript: interrupted");
        copyInstalledExtensions(entry, extensionsDir);
      }
    }

    this.port = await freePort();
    // Interrupted while starting up: don't launch anything more; the
    // clean-up registered above removes what was made.
    if (interrupted()) throw new Error("reelscript: interrupted");
    const proc = spawn(
      bin,
      [
        ...common,
        "--bind-addr", `127.0.0.1:${this.port}`,
        "--disable-telemetry",
        "--disable-update-check",
        "--disable-workspace-trust",
        "--disable-getting-started-override",
        this.workspace,
      ],
      // Its own process group, so stop() can end the extension host and
      // other children too, not just the parent.
      { stdio: ["ignore", "pipe", "pipe"], detached: true, env: logsIn(this.root) },
    );
    this.proc = proc;
    let log = "";
    proc.stdout!.on("data", (d) => (log += d.toString()));
    proc.stderr!.on("data", (d) => (log += d.toString()));
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`reelscript: code-server exited early\n${log.trim()}`);
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/healthz`);
        if (r.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`reelscript: code-server did not start\n${log.trim()}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  url(): string {
    return `http://127.0.0.1:${this.port}/?folder=${encodeURIComponent(this.workspace)}`;
  }

  /**
   * Stop code-server and every process it started, then remove its temporary
   * folder. Concurrent calls (Ctrl-C clean-up and the render's own shutdown)
   * share one stop, so none removes the folder before the processes are gone.
   */
  stop(): Promise<void> {
    this.stopping ??= this.stopNow().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private stopping: Promise<void> | null = null;

  private async stopNow(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (proc?.pid && proc.exitCode === null) {
      const exited = new Promise<void>((r) => proc.once("exit", () => r()));
      const signal = (sig: NodeJS.Signals) => {
        try {
          process.kill(-proc.pid!, sig); // the whole group
        } catch {
          /* already gone */
        }
      };
      signal("SIGTERM");
      const timedOut = await Promise.race([exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 1500).unref())]);
      if (timedOut) signal("SIGKILL");
      // Children may outlive the parent by a moment; end them, and wait until
      // none is left, so none can write into the folder after it's removed.
      signal("SIGKILL");
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          process.kill(-proc.pid, 0);
        } catch {
          break; // no process left in the group
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    this.unregister?.();
    this.unregister = null;
    if (this.root) {
      const root = this.root;
      this.root = "";
      rmSync(root, { recursive: true, force: true });
      // A dying process can still flush one last log line and recreate the
      // folder; sweep once more after it's had a moment.
      await new Promise((r) => setTimeout(r, 250));
      rmSync(root, { recursive: true, force: true });
    }
  }

  private unregister: (() => void) | null = null;

  /** Whether this server was started for the same workspace, extensions and settings. */
  matches(config: EditorServerConfig): boolean {
    return this.configKey === JSON.stringify([config.workspace, config.extensions ?? [], config.settings ?? {}]);
  }
}
