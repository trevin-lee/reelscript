import { createDemo } from "@reelscript/cli";

const demo = createDemo({
  theme: "macos",
  viewport: [1280, 800],
  fps: 60,
  voice: "af_heart",
  pronunciations: { Reelscript: "Reel script" },
});

// The sample app ships with the repo, so the demo is fully self-contained.
await demo.browser.goto(new URL("./app.html", import.meta.url).href);

demo.say("Reelscript turns product demos into code.");
await demo.wait(600);

demo.say("Open the dashboard, and click New project.");
await demo.cursor.moveTo("#new-project", { ease: "smooth" });
await demo.cursor.click();
demo.zoom.to("#modal", { scale: 1.6 });
await demo.waitForNarration();

demo.say("Give it a name, and hit Create.");
await demo.cursor.moveTo("#project-name");
await demo.cursor.click();
await demo.type("#project-name", "Acme Q3 Launch", { wpm: 400 });
await demo.wait(300);
await demo.cursor.moveTo("#create");
await demo.cursor.click();
demo.zoom.out();
await demo.waitForNarration();

demo.say("When the UI changes, you don't re-record anything. You just re-run the script.");
await demo.waitForNarration();

await demo.render("out/basic.mp4");
