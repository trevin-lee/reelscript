import { createDemo } from "@reelscript/cli";

// Demo the extension you're building: point `extensions` at its folder (or a
// .vsix, or an Open VSX id). In CI, build the extension first, then render.
const demo = createDemo({ viewport: [1280, 800], fps: 60 });

await demo.editor.open({ workspace: "./acme", extensions: ["./acme-ext"], notifications: true });
demo.say("Acme Tools adds a one-click deploy to VS Code.");
await demo.editor.openFile("app.ts");
await demo.waitForNarration();

demo.say("Run it from the command palette.");
await demo.editor.command("Acme: Deploy to Production");
demo.zoom.to(".statusbar", { scale: 1.5 });
await demo.wait(2200);
await demo.waitForNarration();
demo.zoom.out();
await demo.wait(1200);

await demo.render("out/extension.mp4");
