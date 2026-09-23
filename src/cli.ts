#!/usr/bin/env node
/**
 * reelscript CLI — thin entry point.
 *
 *   reelscript render <script.ts> [--out demo.mp4]
 *   reelscript watch  <script.ts>
 *
 * Command wiring is stubbed until the engine lands.
 */

const [, , command, ...rest] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case "render":
      console.log(`reelscript: render not implemented yet (script: ${rest[0] ?? "?"})`);
      break;
    case "watch":
      console.log(`reelscript: watch not implemented yet (script: ${rest[0] ?? "?"})`);
      break;
    case "--version":
    case "-v":
      console.log("reelscript 0.0.0");
      break;
    default:
      console.log("usage: reelscript <render|watch> <script> [--out demo.mp4]");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
