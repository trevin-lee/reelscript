// reelscript, filmed by reelscript: three example scripts, each shown in VS
// Code, rendered in a terminal, and then the video it made, played as it was
// rendered; and `check` failing at the line when a UI change breaks a demo.
//
// It plays the real renders, so make them first, from examples/meta:
//   cd examples/meta && npx reelscript render browser.ts terminal.ts desk.ts
//   cd .. && npx reelscript render meta.ts
import { createDemo } from "@reelscript/cli";

// Window places on the 1424x992 desktop a 1280x800 viewport gets: the main one, and a terminal at the lower right.
const MAIN = { x: 72, y: 72, width: 1280, height: 800 };
const SMALL = { x: 560, y: 600, width: 800, height: 260, fontSize: 14 };
// The camera is placed by hand, one push-in per beat, so it never hunts between windows.
const demo = createDemo({ viewport: [1280, 800] });

/** A script, in VS Code: opened, and the camera in on its code while the narration says what it is. */
function show(file: string, line: string) {
  demo.editor.focus();
  demo.editor.openFile(file);
  demo.zoom.to(".monaco-editor .view-lines", { window: "editor", scale: 1.25, within: "window", duration: 900 });
  demo.say(line);
  demo.waitForNarration();
  demo.wait(300);
  demo.zoom.out({ duration: 600 });
}

/** The script rendered, in the terminal at the lower right, with the line the render printed. */
function render(file: string, wrote: string) {
  demo.terminal.open({ title: "meta", ...SMALL });
  demo.zoom.to("#t", { window: "terminal", scale: 1.5, duration: 700 });
  demo.terminal.run(`npx reelscript render ${file}`, { output: `\n${wrote}\n` });
  demo.wait(900);
  demo.zoom.out({ duration: 600 });
  demo.wait(300);
}

/** The video the render made, played in the browser window from its first frame to its last. */
function play(video: string, seconds: number) {
  demo.browser.focus();
  demo.browser.goto(`./meta/player.html?v=out/${video}`, { hold: 0 });
  demo.wait(seconds * 1000 + 400);
}

// The player, full size, behind VS Code until a video plays in it.
demo.browser.open(MAIN);
// (TypeScript checking is off in the editor: the workspace has no node_modules to resolve the import.)
demo.editor.open({ workspace: "meta", settings: { "typescript.validate.enable": false }, ...MAIN });

// 1. A browser demo: a click, a zoom, typing, and the keys on the keyboard window.
show("browser.ts", "This is reelscript. A product demo is a TypeScript script: this one clicks a button, zooms in, and types a name.");
render("browser.ts", "reelscript: wrote out/browser.mp4  (1424x992, 251 frames, 4.18s video, rendered in 78.5s)");
play("browser.mp4", 4.18);

// 2. A terminal demo: a command and its output, declared, so it renders the same everywhere.
show("terminal.ts", "A terminal demo: a command, and its output as it streams in.");
render("terminal.ts", "reelscript: wrote out/terminal.mp4  (1424x992, 232 frames, 3.87s video, rendered in 9.7s)");
play("terminal.mp4", 3.87);

// 3. The demo on a laptop: on a desk with hands on its keys, then floating in a studio beside an iPad.
show("desk.ts", "And the demo on a laptop: on a desk, typing, or floating in a studio.");
render("desk.ts", "reelscript: wrote out/desk.mp4  (1424x992, 601 frames, 10.02s video, rendered in 438.2s)");
play("desk.mp4", 10.02);

// The check that keeps a demo honest, and out.
demo.terminal.open({ title: "meta", ...SMALL });
demo.zoom.to("#t", { window: "terminal", scale: 1.6, duration: 800 });
demo.say("When your UI changes, reelscript check fails in CI, at the line, before a stale demo ships.");
demo.terminal.run("npx reelscript check browser.ts", {
  output: '\nreelscript: target "#new-project" was not found in the browser window\n  at browser.ts:7:13 (cursor.moveTo)\n',
});
demo.waitForNarration();
demo.say("Product demos as code. reelscript is open source, on npm and GitHub.");
demo.zoom.out({ duration: 1600 });
demo.waitForNarration();
demo.wait(300);

await demo.render("out/meta.mp4");
