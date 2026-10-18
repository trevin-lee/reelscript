// reelscript, filmed by reelscript: three example scripts, each shown in VS
// Code, rendered in a terminal, and then played out as the video it makes;
// and `check` catching a demo a UI change has broken.
//   npx reelscript render examples/meta.ts
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

/** The script rendered, in the terminal at the lower right. */
function render(file: string, wrote: string) {
  demo.terminal.open({ title: "acme", ...SMALL });
  demo.zoom.to("#t", { window: "terminal", scale: 1.5, duration: 700 });
  demo.terminal.run(`npx reelscript render ${file}`, { output: `\nreelscript: wrote ${wrote}\n` });
  demo.wait(900);
  demo.zoom.out({ duration: 600 });
  demo.wait(300);
}

// The app the scripts film, open from the start behind VS Code, so it's there, loaded, when it comes forward.
demo.browser.goto("./app.html", { hold: 0 });
// (TypeScript checking is off in the editor: the workspace has no node_modules to resolve the import.)
demo.editor.open({ workspace: "meta", settings: { "typescript.validate.enable": false }, ...MAIN });

// 1. A browser demo: a click, a zoom, typing, and the keys on the keyboard window.
show("browser.ts", "This is reelscript. A product demo is a TypeScript script: this one clicks a button, zooms in, and types a name.");
render("browser.ts", "out/browser.mp4  (1424x992, 480 frames, 8.0s video)");
demo.browser.focus();
demo.keyboard.open();
demo.cursor.moveTo("#new-project");
demo.cursor.click();
demo.zoom.to("#modal", { duration: 700 });
demo.wait(300);
demo.type("#project-name", "Acme Q3 Launch");
demo.wait(400);
demo.press("Enter");
demo.wait(500);
demo.zoom.out({ duration: 700 });
demo.wait(800);
demo.keyboard.close();

// 2. A terminal demo: a command and its output, declared, so it renders the same everywhere.
show("terminal.ts", "A terminal demo: a command, and its output as it streams in.");
render("terminal.ts", "out/terminal.mp4  (1244x832, 300 frames, 5.0s video)");
demo.terminal.open({ title: "acme", fontSize: 22, ...MAIN });
demo.terminal.run("acme deploy --prod", {
  events: [
    [0, "Building acme@3.2.0\n"],
    [700, "✓ Built in 1.4s\n"],
    [1200, "Uploading 42 files\n"],
    [1900, "✓ Live at https://acme.app\n"],
  ],
});
demo.wait(1500);

// 3. The demo on a laptop: on a desk with hands on its keys, then floating in a studio beside an iPad.
show("desk.ts", "And the demo on a laptop: on a desk, typing, or floating in a studio.");
render("desk.ts", "out/desk.mp4  (1424x992, 1140 frames, 19.0s video)");
demo.browser.focus();
demo.desk.to("wide", { duration: 1800 });
demo.wait(1900);
demo.press("Meta+N");
demo.type("#project-name", "Launch video");
demo.press("Enter");
demo.wait(600);
demo.desk.to("float", { duration: 2000 });
demo.wait(2100);
demo.desk.to("float", { orbit: 360, duration: 6000 });
demo.wait(6000);
demo.desk.out({ duration: 1800 });
demo.wait(1900);

// The check that keeps a demo honest, and out.
demo.terminal.open({ title: "acme", ...SMALL });
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
