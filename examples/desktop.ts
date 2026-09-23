import { createDemo } from "@reelscript/cli";

// A browser and a terminal on the same desktop. Clicking a window brings it
// to the front; typing goes to the focused window; selectors resolve in the
// focused window unless `window` says otherwise.
const demo = createDemo({
  theme: "macos",
  viewport: [1180, 720],
  desktop: [1600, 1000],
  fps: 60,
  pronunciations: { Reelscript: "Reel script" },
});

await demo.browser.goto(new URL("./app.html", import.meta.url).href);
demo.say("Reelscript can put a browser and a terminal on the same desktop.");
await demo.wait(600);

await demo.terminal.open({ title: "acme", prompt: "acme % ", x: 700, y: 560, width: 840, height: 360 });
await demo.terminal.run("npm run deploy", {
  output: "\n> acme@1.4.0 deploy\n> acme-cli deploy --prod\n\n  Building...      done (2.1s)\n  Uploading...     done (0.8s)\n  Live at https://acme.app\n",
  duration: 2200,
});
await demo.waitForNarration();

demo.say("Click back into the browser, and keep going.");
await demo.cursor.moveTo("#new-project", { window: "browser" });
await demo.cursor.click();
demo.zoom.to("#modal", { scale: 1.4 });
await demo.cursor.moveTo("#project-name");
await demo.cursor.click();
await demo.type("#project-name", "Deployed from the CLI", { wpm: 400 });
await demo.cursor.moveTo("#create");
await demo.cursor.click();
demo.zoom.out();
await demo.waitForNarration();
await demo.wait(900);

await demo.render("out/desktop.mp4");
