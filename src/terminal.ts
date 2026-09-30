/**
 * Terminal window: an xterm.js page rendered in Chromium with a bundled
 * monospace font, driven by the timeline. Output is either declared in the
 * script or replayed from a recording made by `reelscript record`.
 */
import { spawn } from "node:child_process";
import { onInterrupt } from "./cleanup.js";
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
  /** Set when the command ran past the time limit and was stopped. */
  timedOut?: boolean;
  /** Set when it was stopped, as the script asked, once its output showed `until`. */
  stoppedAtUntil?: boolean;
  durationMs: number;
  recordedAt: string;
  events: TermEvent[];
}

export const TERMINAL_URL = "https://reelscript.local/terminal";

/** Stable file name for a command's recording. */
/**
 * Which recording a run uses. The same command run twice (`ls`, `touch x`,
 * `ls`), or in two folders, is a different recording each time. The first
 * run of a command in the script's own folder keeps the plain name, so
 * existing recordings still match.
 */
export interface RecordingKey {
  cwd?: string;
  /** 1 for the first run of this command (in this cwd) in the script, 2 for the second, ... */
  occurrence?: number;
}

function keyString(command: string, key: RecordingKey = {}): string {
  let s = command;
  if (key.cwd && key.cwd !== ".") s += `\0cwd=${key.cwd}`;
  if ((key.occurrence ?? 1) > 1) s += `\0#${key.occurrence}`;
  return s;
}

export function slugForCommand(command: string, key: RecordingKey = {}): string {
  const base = command
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = createHash("sha1").update(keyString(command, key)).digest("hex").slice(0, 6);
  return `${base || "cmd"}-${hash}`;
}

/** The key for each recorded run in a timeline, by action index. */
export function recordingKeys(actions: ReadonlyArray<{ kind: string; command?: string; output?: string; events?: unknown; cwd?: string }>): Map<number, RecordingKey> {
  const seen = new Map<string, number>();
  const keys = new Map<number, RecordingKey>();
  actions.forEach((a, i) => {
    if (a.kind !== "terminal.run" || a.output !== undefined || a.events || a.command === undefined) return;
    const id = `${a.command}\0${a.cwd ?? "."}`;
    const occurrence = (seen.get(id) ?? 0) + 1;
    seen.set(id, occurrence);
    keys.set(i, { cwd: a.cwd, occurrence });
  });
  return keys;
}

export function recordingPath(dir: string, command: string, key: RecordingKey = {}): string {
  return join(dir, `${slugForCommand(command, key)}.json`);
}

export function loadRecording(dir: string, command: string, key: RecordingKey = {}): TermRecording | null {
  const file = recordingPath(dir, command, key);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as TermRecording;
}

/**
 * A line feed as a new line: what a terminal's line discipline does to a
 * program's output, and what declared output and `reelscript record`
 * recordings (made without a pseudo-terminal) expect. Output recorded from
 * a pseudo-terminal has had it done already, and is written as it is.
 */
export function withCarriageReturns(text: string): string {
  return text.replace(/(?<!\r)\n/g, "\r\n");
}

/** Turn declared output into evenly paced line events. */
export function scriptedEvents(output: string, durationMs?: number): TermEvent[] {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  // Output ending in a newline ends with its last line, not an empty one after it.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const n = lines.length;
  const total = durationMs ?? Math.min(2500, 150 + 60 * n);
  const step = n > 1 ? total / (n - 1) : 0;
  return lines.map((line, i) => [Math.round(80 + i * step), i < n - 1 || /\n$/.test(output) ? `${line}\n` : line]);
}

/**
 * Compact a recording's timing for playback: cap long silences, scale by
 * speed, so a real command that stalled for 20s doesn't stall the demo.
 */
export function playbackEvents(events: TermEvent[], opts: { speed?: number; maxGap?: number } = {}): TermEvent[] {
  const speed = opts.speed ?? 1;
  const maxGap = opts.maxGap ?? 700;
  let prev = 0;
  let acc = 0;
  return events.map(([at, text]) => {
    const gap = Math.min(Math.max(0, at - prev), maxGap) / speed;
    prev = at;
    acc += gap;
    return [Math.round(acc), text];
  });
}

/**
 * Timed output from an asciinema recording (a .cast file, format v2 or v3),
 * for terminal.run(cmd, { events }) or terminal.print("", { events }), with the
 * terminal size it was recorded at, for terminal.open({ cols, rows }).
 */
export function parseAsciicast(text: string): { events: TermEvent[]; cols: number; rows: number } {
  const [head, ...lines] = text.trim().split("\n");
  const header = JSON.parse(head) as { version: number; width?: number; height?: number; term?: { cols: number; rows: number } };
  if (header.version !== 2 && header.version !== 3) throw new Error(`reelscript: unsupported asciicast version ${header.version} (2 and 3 are supported)`);
  const events: TermEvent[] = [];
  let t = 0;
  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [time, code, data] = JSON.parse(line) as [number, string, string];
    t = header.version === 3 ? t + time : time; // v3 stores the interval since the previous event
    if (code === "o") events.push([Math.round(t * 1000), data]);
  }
  return {
    events,
    cols: header.term?.cols ?? header.width ?? 80,
    rows: header.term?.rows ?? header.height ?? 24,
  };
}

/** How long `reelscript record` lets a command run before stopping it. */
export const RECORD_TIMEOUT_MS = 120_000;

export interface RecordOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  timeoutMs?: number;
  /** Stop the command once its output shows this (a server that's up): meant, not a time-out. */
  until?: string;
}

/**
 * The environment a recorded command runs in: the user's, without the
 * settings the CLI passes itself (a recorded `reelscript render` would
 * otherwise think it was being recorded too).
 */
function commandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["REELSCRIPT_RECORD", "REELSCRIPT_SCRIPT", "REELSCRIPT_STRICT", "REELSCRIPT_CHECK", "REELSCRIPT_OUT", "REELSCRIPT_SNAPSHOT_AT"]) delete env[key];
  return env;
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
      env: { ...commandEnv(), FORCE_COLOR: "1", TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows) },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group: `a && b`, `npm run x` and the like start children
      // that outlive the shell and keep its output open.
      detached: true,
    });
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const unregister = onInterrupt(killGroup);
    let seen = "";
    let stoppedAtUntil = false;
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      events.push([Date.now() - start, text]);
      // Any case: "Ready" is what Next.js prints for a script's "ready".
      if (opts.until && !stoppedAtUntil && (seen += text).toLowerCase().includes(opts.until.toLowerCase())) {
        stoppedAtUntil = true;
        setTimeout(killGroup, 100); // a moment for the rest of that line
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs ?? RECORD_TIMEOUT_MS);
    child.on("error", reject);
    // When the command itself ends, so does anything it left running in the
    // background; otherwise their open output would keep the recording going.
    child.on("exit", () => setTimeout(killGroup, 100)); // kept alive: record mustn't exit first and leave them running
    child.on("close", (code) => {
      clearTimeout(timer);
      unregister();
      resolve({
        version: 1,
        command,
        cols,
        rows,
        exitCode: stoppedAtUntil ? 0 : code,
        ...(timedOut && !stoppedAtUntil ? { timedOut: true } : {}),
        ...(stoppedAtUntil ? { stoppedAtUntil: true } : {}),
        durationMs: Date.now() - start,
        recordedAt: new Date().toISOString(),
        events,
      });
    });
  });
}

export function saveRecording(dir: string, rec: TermRecording, key: RecordingKey = {}): string {
  mkdirSync(dir, { recursive: true });
  const file = recordingPath(dir, rec.command, key);
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

let pageCache = new Map<string, string>();

/** Self-contained HTML for the terminal page (xterm + font inlined). */
export function terminalPageHtml(fontSize = 15, lineHeight = 1.3): string {
  const key = `${fontSize}/${lineHeight}`;
  let html = pageCache.get(key);
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
    fontFamily: '"JetBrains Mono", monospace', fontSize: ${fontSize}, lineHeight: ${lineHeight},
    cursorBlink: true, cursorStyle: "block", convertEol: false, scrollback: 0,
    theme: ${JSON.stringify(THEME)},
  });
  const fit = new Fit();
  term.loadAddon(fit);
  term.open(document.getElementById("t"));
  fit.fit();
  term.focus(); // draws the block cursor; unfocused xterm shows only an outline
  window.__rsTerm = {
    write: (s) => { term.write(s); },
    fit: () => { if (!window.__rsFixed) fit.fit(); return { cols: term.cols, rows: term.rows }; },
    resize: (cols, rows) => { window.__rsFixed = true; term.resize(cols, rows); return { cols: term.cols, rows: term.rows }; },
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    ready: true,
  };
})();
</script></body></html>`;
  pageCache.set(key, html);
  return html;
}
