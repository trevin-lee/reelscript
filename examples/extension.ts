import { createDemo } from "@reelscript/cli";

// Demo the extension you're building: point `extensions` at its folder (or a
// .vsix, or an Open VSX id). In CI, build the extension first, then render.
const demo = createDemo({ viewport: [1280, 800], fps: 60 });

demo.editor.open({ workspace: "./acme", extensions: ["./acme-ext"], notifications: true });
demo.say("Acme Tools adds a one-click deploy to VS Code.");
demo.editor.openFile("app.ts");
demo.waitForNarration();

demo.say("Run it from the command palette.");
demo.editor.command("Acme: Deploy to Production");
demo.zoom.to(".statusbar", { scale: 1.5 });
// The extension deploys on VS Code's own, real-time clock. Show the spinner for
// a moment, then wait for the result itself rather than for a fixed time, so
// every render reaches the same point however fast the machine is.
demo.wait(800);
demo.waitFor("text=Deployed acme@1.4.0", { window: "editor" });
demo.wait(1400);
demo.waitForNarration();
demo.zoom.out();
demo.wait(1200);

await demo.render("out/extension.mp4");
