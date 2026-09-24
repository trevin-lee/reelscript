/**
 * Editor window: a real VS Code (code-server, MIT, Code - OSS based) served
 * from a child process and shown in a Chromium page. Real extensions can be
 * installed from a .vsix or from Open VSX, so demos can show dev tools and
 * extensions exactly as users would see them.
 */
import { spawn } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cacheDir } from "./tts.js";

export const CODE_SERVER_VERSION = "4.138.0";

export const LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

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

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
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
  const manifestPath = join(extensionsDir, "extensions.json");
  const manifest: Array<{ identifier: { id: string } }> = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
  const kept = manifest.filter((e) => e.identifier.id.toLowerCase() !== id.toLowerCase());
  kept.push({
    identifier: { id },
    version,
    location: { $mid: 1, path: target, scheme: "file" },
    relativeLocation: relative,
    metadata: { installedTimestamp: Date.now(), pinned: true, source: "vsix" },
  } as never);
  writeFileSync(manifestPath, JSON.stringify(kept));
  return target;
}

/** One code-server process for the render, on a random local port. */
export class EditorServer {
  private root = "";
  private proc: ReturnType<typeof spawn> | null = null;
  port = 0;
  /** Absolute path of the (copied) workspace folder. */
  workspace = "";

  async start(config: EditorServerConfig, onStatus?: (m: string) => void): Promise<void> {
    const bin = await ensureCodeServer(onStatus);
    this.root = mkdtempSync(join(tmpdir(), "reelscript-editor-"));
    const userData = join(this.root, "user-data");
    mkdirSync(join(userData, "User"), { recursive: true });
    writeFileSync(join(userData, "User", "settings.json"), JSON.stringify({ ...EDITOR_DEFAULT_SETTINGS, ...config.settings }, null, 2));
    writeFileSync(join(this.root, "config.yaml"), "auth: none\n");
    const extensionsDir = join(cacheDir(), "code-server", "extensions");
    mkdirSync(extensionsDir, { recursive: true });

    const name = config.workspace ? basename(config.workspace) : "workspace";
    this.workspace = join(this.root, name);
    if (config.workspace) cpSync(config.workspace, this.workspace, { recursive: true });
    else mkdirSync(this.workspace);

    const common = ["--config", join(this.root, "config.yaml"), "--user-data-dir", userData, "--extensions-dir", extensionsDir];
    const baseDir = config.baseDir ?? process.cwd();
    for (const ext of config.extensions ?? []) {
      const looksLikePath = ext.endsWith(".vsix") || ext.includes("/") || ext.startsWith(".");
      const path = looksLikePath ? resolve(baseDir, ext) : null;
      if (path && existsSync(path) && statSync(path).isDirectory()) {
        onStatus?.(`loading extension folder ${ext}`);
        registerExtensionFolder(path, extensionsDir);
      } else {
        onStatus?.(`installing extension ${ext}`);
        await run(bin, [...common, "--install-extension", path ?? ext]);
      }
    }

    this.port = await freePort();
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
      { stdio: ["ignore", "pipe", "pipe"] },
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

  async stop(): Promise<void> {
    this.proc?.kill();
    this.proc = null;
    if (this.root) rmSync(this.root, { recursive: true, force: true });
  }
}
