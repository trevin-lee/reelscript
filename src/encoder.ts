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
  /** Output width in px; height keeps the aspect ratio. Default: 960 */
  width?: number;
  /** GIF frame rate. Default: 20 */
  fps?: number;
}

/** Codec arguments chosen from the output extension. */
function outputArgs(opts: EncoderOptions): string[] {
  const ext = extname(opts.out).toLowerCase();
  if (ext === ".gif") {
    const width = opts.gif?.width ?? 960;
    const fps = opts.gif?.fps ?? 20;
    // Two-pass palette in one graph: sample a palette from the scaled frames,
    // then dither against it. Gives far better colour than ffmpeg's default GIF path.
    const filter = [
      `fps=${fps}`,
      `scale=${width}:-1:flags=lanczos`,
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
    proc.stderr!.on("data", (d) => (this.stderr += d.toString()));
    this.exit = new Promise((resolve) => proc.on("close", resolve));
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
    if (!this.proc.stdin.write(rgb)) {
      await once(this.proc.stdin, "drain");
    }
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
