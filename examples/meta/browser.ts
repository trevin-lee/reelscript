import { createDemo } from "@reelscript/cli";

const demo = createDemo();

demo.browser.goto("../app.html");
demo.keyboard.open();
demo.cursor.moveTo("#new-project");
demo.cursor.click();
demo.zoom.to("#modal");
demo.type("#project-name", "Acme Q3 Launch");
demo.press("Enter");
demo.zoom.out();

await demo.render("out/browser.mp4");
