import { createDemo } from "@reelscript/cli";

const demo = createDemo({
  theme: "macos",
  viewport: [1280, 800],
  fps: 60,
  voice: "af_heart",
  camera: "follow",
  pronunciations: { Reelscript: "Reel script" },
});

// The sample app ships with the repo, so the demo is fully self-contained.
// Local pages are paths relative to this script.
demo.browser.goto("./app.html");

demo.say("Reelscript turns product demos into code.");
demo.wait(600);

demo.say("Open the dashboard, and click New project.");
demo.cursor.moveTo("#new-project", { ease: "smooth" });
demo.cursor.click();
demo.waitForNarration();

demo.say("Give it a name, and hit Create.");
demo.cursor.moveTo("#project-name");
demo.cursor.click();
demo.type("#project-name", "Acme Q3 Launch", { wpm: 400 });
demo.wait(300);
demo.cursor.moveTo("#create");
demo.cursor.click();
demo.waitForNarration();

demo.say("When the UI changes, you don't re-record anything. You just re-run the script.");
demo.waitForNarration();

await demo.render("out/basic.mp4");
