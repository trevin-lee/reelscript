import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPronunciations, splitSentences, toWav } from "../src/tts.js";

test("splitSentences breaks narration on sentence ends", () => {
  assert.deepEqual(splitSentences("One. Two!  Three? Four"), ["One.", "Two!", "Three?", "Four"]);
  assert.deepEqual(splitSentences("  spaced\n out.  "), ["spaced out."]);
});

test("toWav writes a valid 16-bit mono PCM header", () => {
  const wav = toWav({ audio: new Float32Array([0, 1, -1, 0.5]), sampleRate: 24000 });
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1); // channels
  assert.equal(wav.readUInt32LE(24), 24000); // sample rate
  assert.equal(wav.readUInt16LE(34), 16); // bits
  assert.equal(wav.readUInt32LE(40), 8); // data bytes
  assert.equal(wav.readInt16LE(44 + 2), 0x7fff);
  assert.equal(wav.readInt16LE(44 + 4), -0x8000);
});

test("applyPronunciations respells listed words", () => {
  assert.equal(applyPronunciations("Reelscript rocks", { Reelscript: "Reel script" }), "Reel script rocks");
  assert.equal(applyPronunciations("unchanged", undefined), "unchanged");
});
