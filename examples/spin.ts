// A MacBook floating in the air, its lid wide open, turning; then down onto a
// desk, and in until its screen is the whole frame.
//   npx reelscript render examples/spin.ts
import { createDemo } from "@reelscript/cli";

const demo = createDemo({
  viewport: [1100, 680],
  desk: { hands: false },
});

demo.browser.goto("./app.html", { hold: 0 });
// From the first frame: the laptop alone in the studio, the lid as far open as it goes.
demo.desk.lid(135, { duration: 0 });
demo.desk.to("float", { ipad: false, duration: 0 });

// One full turn, gathering speed and slowing to a stop, so it leads straight into the landing.
demo.desk.to("float", { ipad: false, orbit: 360, duration: 6000 });
demo.wait(6000);

// Down onto the desk...
demo.desk.to("wide", { duration: 2600 });
demo.wait(2800);

// ...and in, until the screen fills the frame.
demo.desk.out({ duration: 2400 });
demo.wait(1200);

await demo.render("out/spin.mp4");
