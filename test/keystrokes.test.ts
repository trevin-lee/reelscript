import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createDemo } from "../src/index.js";
import { layout } from "../src/keyboard.js";
import { keystrokeKeys, keystrokeOpacity, keystrokePlace, showsAsKeystroke } from "../src/keystrokes.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsx = import.meta.resolve("tsx");
test("keystrokes: shortcuts show, keys that only type don't; a chord reads as the laptop writes it", () => {
  for (const c of ["Meta+K", "Control+C", "Alt+ArrowLeft", "Enter", "Escape", "Shift+Tab", "ArrowDown", "F5", "Meta+Shift+P"]) assert.ok(showsAsKeystroke(c, "chords"), c);
  for (const c of ["a", "A", "Shift+A", "!", "Space", "Shift++"]) assert.ok(!showsAsKeystroke(c, "chords"), c);
  assert.ok(showsAsKeystroke("a", "all"));
  const mac = layout("mac"), pc = layout("pc");
  assert.deepEqual(keystrokeKeys("Meta+Shift+P", mac), ["⇧", "⌘", "P"]);
  assert.deepEqual(keystrokeKeys("Control+Shift+P", pc), ["Ctrl", "Shift", "P"]);
  assert.deepEqual(keystrokeKeys("Enter", mac), ["↩"]);
  assert.deepEqual(keystrokeKeys("Meta+F13", mac), ["⌘", "F13"], "a key the laptop hasn't got, as the script names it");
});

test("keystrokes: each fades in as its keys go down, holds, fades out, and gives way to the next; it sits where it's put", () => {
  const strokes = [{ at: 1000, keys: ["⌘", "K"] }, { at: 1500, keys: ["↩"] }];
  assert.equal(keystrokeOpacity(strokes, 1000, 800), null);
  assert.ok(keystrokeOpacity(strokes, 1000, 950)!.opacity > 0 && keystrokeOpacity(strokes, 1000, 950)!.opacity < 1);
  assert.deepEqual(keystrokeOpacity(strokes, 1000, 1200), { stroke: strokes[0], opacity: 1 });
  assert.equal(keystrokeOpacity(strokes, 1000, 1450)!.stroke, strokes[1], "the next one takes over as its keys go down");
  assert.equal(keystrokeOpacity(strokes, 1000, 3000), null);
  assert.deepEqual(keystrokePlace("bottom", 100, 40, 1000, 800), { left: 450, top: 720 });
  assert.deepEqual(keystrokePlace("bottom-left", 100, 40, 1000, 800), { left: 40, top: 720 });
  assert.deepEqual(keystrokePlace("top", 100, 40, 1000, 800), { left: 450, top: 40 });
  assert.deepEqual(keystrokePlace({ x: 200, y: 100 }, 100, 40, 1000, 800), { left: 150, top: 80 });
});

test("keystrokes: options are checked at the createDemo line, and keystroke on a press needs the overlay on", () => {
  assert.doesNotThrow(() => createDemo({ keystrokes: true }));
  assert.doesNotThrow(() => createDemo({ keystrokes: { show: "all", position: { x: 10, y: 20 }, hold: 0, css: ".key { color: red }" } }));
  assert.throws(() => createDemo({ keystrokes: { show: "some" as never } }), /unknown keystrokes show "some" \(use "chords" or "all"\)/);
  assert.throws(() => createDemo({ keystrokes: { position: "middle" as never } }), /unknown keystrokes position "middle"/);
  assert.throws(() => createDemo({ keystrokes: { hold: -1 } }), /keystrokes hold must be a number, 0 or more/);
  assert.throws(() => createDemo({ keystrokes: { colour: "red" } as never }), /keystrokes: .*colour/);
  assert.throws(() => createDemo().press("Meta+K", { keystroke: false }), /keystroke shows or hides this press where shortcuts are named, .* and neither is on/);
  const panel = createDemo();
  panel.keyboard.open();
  assert.doesNotThrow(() => panel.press("Meta+K", { keystroke: false }), "the keyboard window names shortcuts too");
  assert.doesNotThrow(() => createDemo({ keystrokes: true }).editor.openFile("app.ts", { keystroke: false }));
  assert.doesNotThrow(() => createDemo({ keystrokes: true }).editor.command("Format Document", { keystroke: false }));
  assert.doesNotThrow(() => createDemo({ keystrokes: true }).press("a", { keystroke: true }));
});

test("keystrokes: the pill is drawn over the finished frame, the same size and place with the camera zoomed in", { timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-keys-"));
  mkdirSync(dir, { recursive: true });
  const page = "data:text/html,<body style='margin:0;background:%23fff'><input id=f>";
  writeFileSync(
    join(dir, "s.ts"),
    `import { createDemo } from "@reelscript/cli";\nconst demo = createDemo({ viewport: [640, 400], theme: "bare", keystrokes: process.env.KEYS === "1" });\n` +
      `demo.browser.goto("${page}");\nif (process.env.ZOOM) demo.zoom.to("#f", { scale: 2, duration: 0 });\ndemo.wait(200);\ndemo.press("Meta+K");\ndemo.wait(1500);\nawait demo.render("out.mp4");\n`,
  );
  const shot = async (name: string, env: Record<string, string>) => {
    const r = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", tsx, join(root, "src/cli.ts"), "preview", "s.ts", "--at", "0.6", "--out", name], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
      let output = "";
      child.stdout!.on("data", (d) => (output += d));
      child.stderr!.on("data", (d) => (output += d));
      child.on("close", (code) => resolve({ code, output }));
    });
    assert.equal(r.code, 0, r.output);
    return sharp(join(dir, name)).raw().toBuffer({ resolveWithObject: true });
  };
  // The pill's box: the dark pixels in the bottom fifth of an otherwise white frame.
  const box = ({ data, info }: { data: Buffer; info: sharp.OutputInfo }) => {
    let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
    for (let y = Math.floor(info.height * 0.8); y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] < 60 && data[i + 1] < 60 && data[i + 2] < 60) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    return x1 < 0 ? null : { x0, x1, y0, y1 };
  };
  assert.equal(box(await shot("off.png", { KEYS: "0" })), null, "no pill with the overlay off");
  const plain = box(await shot("on.png", { KEYS: "1" }));
  const zoomed = box(await shot("zoomed.png", { KEYS: "1", ZOOM: "1" }));
  assert.ok(plain, "a pill with the overlay on");
  assert.ok(Math.abs((plain.x0 + plain.x1) / 2 - 320) < 4, "centred");
  assert.deepEqual(zoomed, plain, "the zoom doesn't move or scale it");
});
