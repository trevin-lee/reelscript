// Product shots: the demo on a MacBook and an iPad floating in a studio,
// the camera moving round them, the lid closing and opening, and the
// laptop alone on its desk.
//   npx reelscript render examples/devices.ts
import { createDemo } from "@reelscript/cli";

const demo = createDemo({
  viewport: [1100, 680],
  desk: { backdrop: "#dfe3ea" },
});

demo.browser.goto("./app.html");
demo.wait(500);

// Fly out to the studio, then swing round the devices while the demo goes on.
demo.desk.to("float", { duration: 1800 });
demo.wait(1900);
demo.desk.to("float", { orbit: 35, tilt: 8, duration: 2600 });
demo.cursor.moveTo("#new-project");
demo.cursor.click();
demo.wait(1600);

// Shut the lid, and open it again from a lower angle.
demo.desk.lid(0, { duration: 1200 });
demo.wait(1400);
demo.desk.to("float", { orbit: -12, tilt: -4, duration: 1800 });
demo.desk.lid(110, { duration: 1400 });
demo.wait(2000);

// Down onto the desk, the laptop alone, then back to the flat desktop.
demo.desk.to("wide", { hands: false, orbit: -18, duration: 1800 });
demo.wait(2200);
demo.desk.out();
demo.wait(1200);

await demo.render("out/devices.mp4");
