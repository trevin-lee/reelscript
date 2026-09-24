import { createDemo } from "@reelscript/cli";

// A real VS Code (code-server) on the desktop: open files from the Explorer,
// type code, run palette commands. Install extensions with `extensions: [...]`
// to demo them the way users see them.
const demo = createDemo({
  viewport: [1280, 800],
  fps: 60,
  pronunciations: { Reelscript: "Reel script" },
});

await demo.editor.open({ workspace: "./acme" });
demo.say("Reelscript can drive a real VS Code, so you can demo your extension or dev tool the way users see it.");
await demo.wait(500);

await demo.cursor.moveTo(demo.editor.file("src"));
await demo.cursor.click();
await demo.cursor.moveTo(demo.editor.file("app.ts"));
await demo.cursor.click();
await demo.waitForNarration();

demo.say("Add a health check route.");
// Click into the editor first: opening a file from the Explorer leaves
// keyboard focus in the tree, exactly as it does for a person.
await demo.cursor.moveTo(".monaco-editor .view-lines");
await demo.cursor.click();
await demo.press("Control+End");
await demo.press("Enter");
demo.zoom.to(".monaco-editor .view-overlays .current-line", { scale: 1.4 });
await demo.editor.type('server.get("/health", () => ({ ok: true }));', { wpm: 350 });
await demo.waitForNarration();

demo.say("And run anything from the command palette.");
await demo.editor.command("Toggle Minimap");
await demo.waitForNarration();
demo.zoom.out();
await demo.wait(800);

await demo.render("out/editor.mp4");
