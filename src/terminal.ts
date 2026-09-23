/**
 * Terminal window: an xterm.js page rendered in Chromium with a bundled
 * monospace font, driven by the timeline. Output is either declared in the
 * script or replayed from a recording made by `reelscript record`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** One chunk of output: when it appeared (ms from command start) and what. */
export type TermEvent = [atMs: number, text: string];

export interface TermRecording {
  version: 1;
  command: string;
  cols: number;
  rows: number;
  exitCode: number | null;
  durationMs: number;
  recordedAt: string;
  events: TermEvent[];
}

export const TERMINAL_URL = "https://reelscript.local/terminal";

/** Stable file name for a command's recording. */
export function slugForCommand(command: string): string {
  const base = command
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = createHash("sha1").update(command).digest("hex").slice(0, 6);
  return `${base || "cmd"}-${hash}`;
}

export function recordingPath(dir: string, command: string): string {
  return join(dir, `${slugForCommand(command)}.json`);
}

export function loadRecording(dir: string, command: string): TermRecording | null {
  const file = recordingPath(dir, command);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as TermRecording;
}

/** Turn declared output into evenly paced line events. */
export function scriptedEvents(output: string, durationMs?: number): TermEvent[] {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  const n = lines.length;
  const total = durationMs ?? Math.min(2500, 150 + 60 * n);
  const step = n > 1 ? total / (n - 1) : 0;
  return lines.map((line, i) => [Math.round(80 + i * step), i < n - 1 ? `${line}\n` : line]);
}

/**
 * Compact a recording's timing for playback: cap long silences, scale by
 * speed, so a real command that stalled for 20s doesn't stall the demo.
 */
export function playbackEvents(events: TermEvent[], opts: { speed?: number; maxGapMs?: number } = {}): TermEvent[] {
  const speed = opts.speed ?? 1;
  const maxGap = opts.maxGapMs ?? 700;
  let prev = 0;
  let acc = 0;
  return events.map(([at, text]) => {
    const gap = Math.min(Math.max(0, at - prev), maxGap) / speed;
    prev = at;
    acc += gap;
    return [Math.round(acc), text];
  });
}

export interface RecordOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  timeoutMs?: number;
}

/** Run a command for real and capture its output with timestamps. */
export function recordCommand(command: string, opts: RecordOptions = {}): Promise<TermRecording> {
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 36;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const events: TermEvent[] = [];
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: { ...process.env, FORCE_COLOR: "1", TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (chunk: Buffer) => events.push([Date.now() - start, chunk.toString("utf8")]);
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        version: 1,
        command,
        cols,
        rows,
        exitCode: code,
        durationMs: Date.now() - start,
        recordedAt: new Date().toISOString(),
        events,
      });
    });
  });
}

export function saveRecording(dir: string, rec: TermRecording): string {
  mkdirSync(dir, { recursive: true });
  const file = recordingPath(dir, rec.command);
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  return file;
}

// ---------------------------------------------------------------- page

const THEME = {
  background: "#1c1c1e",
  foreground: "#e5e5e7",
  cursor: "#e5e5e7",
  cursorAccent: "#1c1c1e",
  selectionBackground: "#3a3a3c",
  black: "#1c1c1e",
  red: "#ff6b6b",
  green: "#5fd27a",
  yellow: "#f5c451",
  blue: "#6ea8ff",
  magenta: "#d38cff",
  cyan: "#5ed7e0",
  white: "#e5e5e7",
  brightBlack: "#6e6e73",
  brightRed: "#ff8787",
  brightGreen: "#7ee89b",
  brightYellow: "#ffd479",
  brightBlue: "#8fbcff",
  brightMagenta: "#e0a5ff",
  brightCyan: "#7fe6ee",
  brightWhite: "#ffffff",
};

let pageCache = new Map<number, string>();

/** Self-contained HTML for the terminal page (xterm + font inlined). */
export function terminalPageHtml(fontSize = 15): string {
  let html = pageCache.get(fontSize);
  if (html) return html;
  const require = createRequire(import.meta.url);
  const xtermJs = readFileSync(require.resolve("@xterm/xterm/lib/xterm.js"), "utf8");
  const xtermCss = readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8");
  const fitJs = readFileSync(require.resolve("@xterm/addon-fit/lib/addon-fit.js"), "utf8");
  const font = readFileSync(new URL("../assets/fonts/JetBrainsMono-Variable.ttf", import.meta.url)).toString("base64");
  html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "JetBrains Mono"; font-weight: 100 800; src: url(data:font/ttf;base64,${font}) format("truetype"); }
${xtermCss}
html, body { margin: 0; height: 100%; background: ${THEME.background}; overflow: hidden; }
#t { position: absolute; inset: 0; padding: 10px 12px; }
.xterm .xterm-viewport { overflow: hidden !important; }
</style></head><body><div id="t"></div>
<script>${xtermJs}</script>
<script>${fitJs}</script>
<script>
(async () => {
  await document.fonts.load('${fontSize}px "JetBrains Mono"');
  const T = window.Terminal || (window.xterm && window.xterm.Terminal);
  const Fit = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon;
  const term = new T({
    fontFamily: '"JetBrains Mono", monospace', fontSize: ${fontSize}, lineHeight: 1.3,
    cursorBlink: true, cursorStyle: "block", convertEol: true, scrollback: 0,
    theme: ${JSON.stringify(THEME)},
  });
  const fit = new Fit();
  term.loadAddon(fit);
  term.open(document.getElementById("t"));
  fit.fit();
  term.focus(); // draws the block cursor; unfocused xterm shows only an outline
  window.__rsTerm = {
    write: (s) => { term.write(s); },
    fit: () => { fit.fit(); return { cols: term.cols, rows: term.rows }; },
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    ready: true,
  };
})();
</script></body></html>`;
  pageCache.set(fontSize, html);
  return html;
}
