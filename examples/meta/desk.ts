import { createDemo } from "@reelscript/cli";

const demo = createDemo();

demo.browser.goto("./app.html");
demo.desk.to("wide");
demo.press("Meta+N");
demo.type("#project-name", "Launch video");
demo.press("Enter");

demo.desk.to("float");
demo.desk.to("float", { orbit: 360 });

await demo.render("out/desk.mp4");
