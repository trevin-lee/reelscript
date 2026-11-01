import { createDemo } from "@reelscript/cli";

const demo = createDemo();

demo.browser.goto("../app.html");
demo.desk.to("wide");
demo.wait(1500);
demo.press("Meta+N");
demo.type("#project-name", "Launch video");
demo.press("Enter");
demo.wait(500);

demo.desk.to("float");
demo.wait(1500);
demo.desk.to("float", { orbit: 360, duration: 4000 });
demo.wait(4000);

await demo.render("out/desk.mp4");
