import { createDemo } from "../src/index.js";

const demo = createDemo({ theme: "macos", viewport: [1280, 800], fps: 60 });

// The sample app ships with the repo, so the demo is fully self-contained.
await demo.browser.goto(new URL("./app.html", import.meta.url).href);
await demo.wait(500);

await demo.cursor.moveTo("#new-project", { ease: "smooth" });
await demo.cursor.click();

demo.zoom.to("#modal", { scale: 1.6 });
await demo.wait(400);

await demo.cursor.moveTo("#project-name");
await demo.cursor.click();
await demo.type("#project-name", "Acme Q3 Launch", { wpm: 400 });
await demo.wait(400);

await demo.cursor.moveTo("#create");
await demo.cursor.click();
demo.zoom.out();
await demo.wait(1200);

await demo.render("out/basic.mp4");
