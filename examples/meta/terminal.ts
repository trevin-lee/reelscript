import { createDemo } from "@reelscript/cli";

const demo = createDemo();

demo.terminal.open({ title: "acme" });
demo.terminal.run("acme deploy --prod", {
  events: [
    [0, "Building acme@3.2.0\n"],
    [700, "✓ Built in 1.4s\n"],
    [1200, "Uploading 42 files\n"],
    [1900, "✓ Live at https://acme.app\n"],
  ],
});

await demo.render("out/terminal.mp4");
