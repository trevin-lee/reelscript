import { createDemo } from "../src/index.js";

const demo = createDemo({ theme: "macos", viewport: [1280, 800], fps: 60 });

await demo.browser.goto("https://app.local");
await demo.cursor.moveTo("#new-project", { ease: "smooth" });
await demo.cursor.click();

demo.zoom.to("#modal", { scale: 1.5, hold: 1200 });
await demo.type("#name", "Acme Q3 Launch", { wpm: 400 });
demo.zoom.out();

console.log(demo.getTimeline());
await demo.render("out.mp4");
