import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, extname } from "node:path";
import { once } from "node:events";

export interface EncoderOptions {
  out: string;
  width: number;
  height: number;
  fps: number;
  /** x264 CRF; lower = higher quality. */
  crf?: number;
  ffmpegPath?: string;
  /** GIF output settings (used when `out` ends in .gif). */
  gif?: GifOptions;
}

export interface GifOptions {
  /** Output width in px; height keeps the aspect ratio. Default: 960, or the video's width if narrower */
  width?: number;
  /** GIF frame rate. Default: 20 */
  fps?: number;
}

/** A GIF's size and frame rate for a video `width` x `height`: 960 wide by default, never scaled up. */
export function gifSize(width: number, height: number, gif: GifOptions = {}): { width: number; height: number; fps: number } {
  const w = gif.width ?? Math.min(960, width);
  return { width: w, height: Math.round((height * w) / width), fps: gif.fps ?? 20 };
}

/** Codec arguments chosen from the output extension. */
function outputArgs(opts: EncoderOptions): string[] {
  const ext = extname(opts.out).toLowerCase();
  if (ext === ".gif") {
    const { width, height, fps } = gifSize(opts.width, opts.height, opts.gif);
    // Two-pass palette in one graph: sample a palette from the scaled frames,
    // then dither against it. Gives far better colour than ffmpeg's default GIF path.
    const filter = [
      `fps=${fps}`,
      `scale=${width}:${height}:flags=lanczos`,
      "split[a][b]",
      "[a]palettegen=stats_mode=diff[p]",
      "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
    ].join(",");
    return ["-filter_complex", filter, "-loop", "0"];
  }
  return [
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", String(opts.crf ?? 18),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
  ];
}

export function resolveFfmpeg(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.REELSCRIPT_FFMPEG) return process.env.REELSCRIPT_FFMPEG;
  try {
    const require = createRequire(import.meta.url);
    const p = require("ffmpeg-static") as string | null;
    if (p) return p;
  } catch {
    /* fall through to PATH */
  }
  return "ffmpeg";
}

/** Streams raw RGB frames into ffmpeg and produces an H.264 mp4. */
/** Every ffmpeg reelscript has running, so a failed or interrupted render can stop them. */
const live = new Set<ChildProcess>();

function track(proc: ChildProcess): void {
  live.add(proc);
  proc.on("close", () => live.delete(proc));
}

/**
 * Kill every running ffmpeg and wait for it to exit. Left running, ffmpeg
 * finalizes its output when its input closes (rewriting the file for
 * faststart), recreating a partial file after it was deleted.
 */
export async function stopEncoders(): Promise<void> {
  await Promise.all(
    [...live].map(
      (p) =>
        new Promise<void>((resolve) => {
          if (p.exitCode !== null || p.signalCode !== null) return resolve();
          p.once("close", () => resolve());
          p.kill("SIGKILL");
        }),
    ),
  );
}

/** Output formats reelscript can write, by file extension. */
export const OUTPUT_FORMATS = [".mp4", ".gif"];

export function checkOutputFormat(out: string): void {
  const ext = extname(out).toLowerCase();
  if (!OUTPUT_FORMATS.includes(ext)) {
    throw new Error(`reelscript: can't render to "${out}": use a path ending in ${OUTPUT_FORMATS.join(" or ")}`);
  }
}

export class Encoder {
  private proc: ChildProcess | null = null;
  private stderr = "";
  private exit: Promise<number | null> | null = null;
  readonly frameBytes: number;

  constructor(private opts: EncoderOptions) {
    this.frameBytes = opts.width * opts.height * 3;
  }

  start(): void {
    const { out, width, height, fps } = this.opts;
    mkdirSync(dirname(out), { recursive: true });
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "-s", `${width}x${height}`,
      "-r", String(fps),
      "-i", "-",
      ...outputArgs(this.opts),
      out,
    ];
    const proc = spawn(resolveFfmpeg(this.opts.ffmpegPath), args, { stdio: ["pipe", "ignore", "pipe"] });
    track(proc);
    proc.stderr!.on("data", (d) => (this.stderr += d.toString()));
    this.exit = new Promise((resolve) =>
      proc.on("close", (code) => {
        this.exitCode = code;
        resolve(code);
      }),
    );
    // A write after ffmpeg exits raises EPIPE on stdin; writeFrame reports it instead.
    proc.stdin!.on("error", () => {});
    proc.on("error", (err) => {
      this.stderr += `\nfailed to start ffmpeg: ${err.message}`;
    });
    this.proc = proc;
  }

  async writeFrame(rgb: Buffer): Promise<void> {
    if (!this.proc?.stdin) throw new Error("encoder not started");
    if (rgb.length !== this.frameBytes) {
      throw new Error(`frame is ${rgb.length} bytes, expected ${this.frameBytes}`);
    }
    if (this.exitCode !== undefined) throw this.failure();
    if (!this.proc.stdin.write(rgb)) {
      // Wait for room in the pipe, unless ffmpeg has gone (then nothing drains it).
      await Promise.race([once(this.proc.stdin, "drain"), this.exit!.then(() => undefined)]);
      if (this.exitCode !== undefined) throw this.failure();
    }
  }

  private exitCode: number | null | undefined;

  private failure(): Error {
    return new Error(`reelscript: ffmpeg stopped while encoding (exit code ${this.exitCode})\n${this.stderr.trim()}`);
  }

  async finish(): Promise<void> {
    if (!this.proc?.stdin) return;
    this.proc.stdin.end();
    const code = await this.exit;
    if (code !== 0) {
      throw new Error(`ffmpeg exited with code ${code}\n${this.stderr.trim()}`);
    }
  }
}

export interface NarrationCue {
  /** WAV file to play. */
  file: string;
  /** When it starts on the video timeline, in ms. */
  atMs: number;
}

/** Remux a finished video with narration clips placed on the timeline (no video re-encode). */
export async function muxNarration(videoPath: string, cues: NarrationCue[], out: string, ffmpegPath?: string): Promise<void> {
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", videoPath];
  for (const c of cues) args.push("-i", c.file);
  const delayed = cues.map((c, i) => `[${i + 1}:a]adelay=${Math.max(0, Math.round(c.atMs))}:all=1[a${i}]`);
  const labels = cues.map((_, i) => `[a${i}]`).join("");
  const filter =
    cues.length === 1
      ? delayed[0]
      : [...delayed, `${labels}amix=inputs=${cues.length}:normalize=0[mix]`].join(";");
  const outLabel = cues.length === 1 ? "[a0]" : "[mix]";
  args.push(
    "-filter_complex", filter,
    "-map", "0:v",
    "-map", outLabel,
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "160k",
    "-ar", "48000",
    "-movflags", "+faststart",
    out,
  );
  const proc = spawn(resolveFfmpeg(ffmpegPath), args, { stdio: ["ignore", "ignore", "pipe"] });
  track(proc);
  let stderr = "";
  proc.stderr!.on("data", (d) => (stderr += d.toString()));
  const code = await new Promise<number | null>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", resolve);
  });
  if (code !== 0) throw new Error(`ffmpeg (narration mux) exited with code ${code}\n${stderr.trim()}`);
}
