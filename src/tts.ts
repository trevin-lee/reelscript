/**
 * Narration: text-to-speech engines and a cache of synthesized clips.
 *
 * The default engine is Kokoro-82M through the optional `kokoro-js`
 * dependency: open weights, runs on CPU faster than real time, no account.
 * Any object implementing TtsEngine can be passed instead (ElevenLabs,
 * OpenAI, a cloud service).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TtsAudio {
  /** Mono PCM samples in [-1, 1]. */
  audio: Float32Array;
  sampleRate: number;
}

export interface TtsOptions {
  voice?: string;
  /** Playback speed multiplier. Default: 1 */
  speed?: number;
}

export interface TtsEngine {
  /** Stable identifier; part of the clip cache key. */
  readonly id: string;
  synthesize(text: string, opts: TtsOptions): Promise<TtsAudio>;
}

export interface Clip {
  /** Path to a 16-bit mono WAV file. */
  file: string;
  seconds: number;
}

export const DEFAULT_VOICE = "af_heart";
export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Root of reelscript's on-disk cache (models, synthesized clips). */
export function cacheDir(): string {
  return process.env.REELSCRIPT_CACHE ?? join(homedir(), ".cache", "reelscript");
}

/** Split narration into sentences; TTS models prefer short inputs. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Kokoro-82M via kokoro-js, loaded lazily on first use. */
export function kokoro(model = KOKORO_MODEL): TtsEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let loading: Promise<any> | null = null;
  const load = () =>
    (loading ??= (async () => {
      const spec = "kokoro-js";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let mod: any;
      try {
        mod = await import(spec);
      } catch {
        throw new Error(
          "reelscript: narration needs the optional dependency kokoro-js.\n" +
            "  npm install kokoro-js\n" +
            "or pass your own engine via createDemo({ tts })",
        );
      }
      mod.env.cacheDir = join(cacheDir(), "models");
      return mod.KokoroTTS.from_pretrained(model, { dtype: "q8", device: "cpu" });
    })());

  return {
    id: `kokoro:${model}:q8`,
    async synthesize(text, { voice = DEFAULT_VOICE, speed = 1 } = {}) {
      const tts = await load();
      const parts: Float32Array[] = [];
      let sampleRate = 24000;
      for (const sentence of splitSentences(text)) {
        const out = await tts.generate(sentence, { voice, speed });
        parts.push(out.audio);
        sampleRate = out.sampling_rate;
      }
      const total = parts.reduce((n, p) => n + p.length, 0);
      const audio = new Float32Array(total);
      let offset = 0;
      for (const p of parts) {
        audio.set(p, offset);
        offset += p.length;
      }
      return { audio, sampleRate };
    },
  };
}

/** Encode mono float samples as a 16-bit PCM WAV file. */
export function toWav({ audio, sampleRate }: TtsAudio): Buffer {
  const n = audio.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, audio[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

/** Synthesize (or fetch from cache) one narration clip. */
export async function synthesizeClip(engine: TtsEngine, text: string, opts: TtsOptions): Promise<Clip> {
  const voice = opts.voice ?? DEFAULT_VOICE;
  const speed = opts.speed ?? 1;
  const key = createHash("sha1").update([engine.id, voice, String(speed), text].join("\0")).digest("hex");
  const dir = join(cacheDir(), "tts");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${key}.wav`);
  const meta = `${file}.json`;
  if (existsSync(file) && existsSync(meta)) {
    return { file, seconds: (JSON.parse(readFileSync(meta, "utf8")) as { seconds: number }).seconds };
  }
  const audio = await engine.synthesize(text, { voice, speed });
  const seconds = audio.audio.length / audio.sampleRate;
  writeFileSync(file, toWav(audio));
  writeFileSync(meta, JSON.stringify({ seconds, text, voice, speed, engine: engine.id }));
  return { file, seconds };
}

/** Replace words the TTS mispronounces, e.g. { Reelscript: "Reel script" }. */
export function applyPronunciations(text: string, map: Record<string, string> | undefined): string {
  if (!map) return text;
  let out = text;
  for (const [word, spoken] of Object.entries(map)) out = out.split(word).join(spoken);
  return out;
}
