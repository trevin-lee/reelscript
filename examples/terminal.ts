import { createDemo } from "@reelscript/cli";

const demo = createDemo({
  theme: "macos",
  viewport: [1100, 640],
  fps: 60,
  pronunciations: { Reelscript: "Reel script" },
});

demo.terminal.open({ title: "acme", prompt: "acme % " });
demo.say("Reelscript renders terminal sessions too.");
demo.wait(400);

// Declared output: nothing runs, renders identically everywhere.
demo.terminal.run("npm install -D @reelscript/cli", {
  output: "\nadded 38 packages in 2s\n",
  duration: 1200,
});
demo.wait(300);

demo.say("Declare the output in the script, or record a real command and replay it.");
// Recorded output: `reelscript record examples/terminal.ts` runs this for real
// and saves examples/recordings/<slug>.json, which render replays.
demo.terminal.run("node --version");
demo.wait(300);

demo.terminal.run("npx reelscript render demo.ts --out demo.mp4", {
  output:
    "reelscript: synthesizing narration (2 clips)\n" +
    "reelscript: wrote demo.mp4  (1424x992, 610 frames, 10.17s video, rendered in 31.0s)\n",
  duration: 1800,
});
demo.waitForNarration();
demo.wait(800);

await demo.render("out/terminal.mp4");
