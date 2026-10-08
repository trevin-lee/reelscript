import { createDemo } from "@reelscript/cli";

// A real VS Code (code-server) on the desktop: open files from the Explorer,
// type code, run palette commands. Install extensions with `extensions: [...]`
// to demo them the way users see them.
const demo = createDemo({
  viewport: [1280, 800],
  fps: 60,
  pronunciations: { Reelscript: "Reel script" },
});

demo.editor.open({ workspace: "./acme" });
demo.say("Reelscript can drive a real VS Code, so you can demo your extension or dev tool the way users see it.");
demo.wait(500);

demo.cursor.moveTo(demo.editor.file("src"));
demo.cursor.click();
demo.cursor.moveTo(demo.editor.file("app.ts"));
demo.cursor.click();
demo.waitForNarration();

demo.say("Add a health check route.");
// Click into the editor first: opening a file from the Explorer leaves
// keyboard focus in the tree, exactly as it does for a person.
demo.cursor.moveTo(".monaco-editor .view-lines");
demo.cursor.click();
demo.press("Meta+ArrowDown");
demo.press("Enter");
demo.zoom.to(".monaco-editor .view-overlays .current-line", { scale: 1.4 });
demo.editor.type('server.get("/health", () => ({ ok: true }));', { wpm: 350 });
demo.waitForNarration();

demo.say("And run anything from the command palette.");
demo.editor.command("Toggle Minimap");
demo.waitForNarration();
demo.zoom.out();
demo.wait(800);

await demo.render("out/editor.mp4");
