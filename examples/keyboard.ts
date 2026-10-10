// Keyboard shortcuts, shown: a keyboard window plays every key the demo
// presses or types, with the hands that press them, and the demo ends on
// the desk, with the app on the laptop's screen.
//   npx reelscript render examples/keyboard.ts
import { createDemo } from "@reelscript/cli";

const demo = createDemo({
  viewport: [1100, 680],
  desk: { laptop: "mac" },
});

demo.browser.goto("./app.html");
demo.keyboard.open();
demo.wait(600);

// Shortcuts the page handles: the hands press them on the keyboard below.
demo.press("Meta+N");
demo.wait(500);
demo.type("#project-name", "Acme Q3 Launch", { wpm: 240 });
demo.wait(300);
demo.press("Enter");
demo.wait(900);

// Then the whole desk, the app still on screen, and back.
demo.desk.to("desk");
demo.wait(2200);
demo.desk.to("keyboard", { duration: 1200 });
demo.wait(1600);
demo.desk.out();
demo.wait(1200);

await demo.render("out/keyboard.mp4");
