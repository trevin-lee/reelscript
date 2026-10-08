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

demo.browser.goto("./app.html");
demo.say("Reelscript can put a browser and a terminal on the same desktop.");
demo.wait(600);

demo.terminal.open({ title: "acme", prompt: "acme % ", x: 700, y: 560, width: 840, height: 360 });
demo.terminal.run("npm run deploy", {
  output: "\n> acme@1.4.0 deploy\n> acme-cli deploy --prod\n\n  Building...      done (2.1s)\n  Uploading...     done (0.8s)\n  Live at https://acme.app\n",
  duration: 2200,
});
demo.waitForNarration();

demo.say("Click back into the browser, and keep going.");
demo.cursor.moveTo("#new-project", { window: "browser" });
demo.cursor.click();
demo.zoom.to("#modal", { scale: 1.4 });
demo.cursor.moveTo("#project-name");
demo.cursor.click();
demo.type("#project-name", "Deployed from the CLI", { wpm: 400 });
demo.cursor.moveTo("#create");
demo.cursor.click();
demo.zoom.out();
demo.waitForNarration();
demo.wait(900);

await demo.render("out/desktop.mp4");
