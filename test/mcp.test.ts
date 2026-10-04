import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const app = new URL("../examples/app.html", import.meta.url).href;

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

test("MCP server: docs, inspect, check, and preview work the way an agent uses them", { timeout: 180_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/cli.ts", "mcp"],
    cwd: root,
    env: process.env as Record<string, string>,
    stderr: "pipe",
  });
  let serverLog = "";
  transport.stderr?.on("data", (d) => (serverLog += d.toString()));
  const client = new Client({ name: "reelscript-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["check_script", "inspect_page", "preview_frame", "record_script", "reelscript_docs", "render_script"]);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    assert.deepEqual(readOnly, ["inspect_page", "reelscript_docs"], "only tools that can't change anything claim to be read-only");
    assert.match(client.getInstructions() ?? "", /check_script/);

    const docs = (await client.callTool({ name: "reelscript_docs" })).content as Content;
    assert.match(docs[0].text ?? "", /createDemo/);

    const inspected = (await client.callTool({ name: "inspect_page", arguments: { url: app, screenshot: true } })).content as Content;
    assert.match(inspected[0].text ?? "", /#new-project/);
    // The new-project dialog is closed (faded out), so its field isn't something a script could target yet.
    assert.doesNotMatch(inspected[0].text ?? "", /#project-name/);
    assert.equal(inspected[1].type, "image");
    // The same mistakes a script makes get the same clear answers, not Chromium's.
    const zone = await client.callTool({ name: "inspect_page", arguments: { url: app, timezone: "Mars/Base", screenshot: false } });
    assert.equal(zone.isError, true);
    assert.match((zone.content as Content)[0].text ?? "", /unknown timezone "Mars\/Base" \(use an IANA name/);
    const closed = await new Promise<number>((resolve) => {
      const server = createServer().listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
      });
    });
    const nobody = await client.callTool({ name: "inspect_page", arguments: { url: `http://127.0.0.1:${closed}`, screenshot: false } });
    assert.equal(nobody.isError, true);
    assert.match((nobody.content as Content)[0].text ?? "", new RegExp(`nothing is answering at 127\\.0\\.0\\.1:${closed}\\. Is the app running\\?`));

    const ok = await client.callTool({ name: "check_script", arguments: { script: "examples/basic.ts" } });
    assert.equal(ok.isError, false);
    assert.match((ok.content as Content)[0].text ?? "", /check passed/);

    const broken = "examples/.mcp-broken.ts";
    writeFileSync(
      `${root}/${broken}`,
      `import { createDemo } from "@reelscript/cli";\nconst demo = createDemo();\nawait demo.browser.goto(${JSON.stringify(app)});\nawait demo.cursor.moveTo("#nope");\nawait demo.render("out/never.mp4");\n`,
    );
    try {
      const bad = await client.callTool({ name: "check_script", arguments: { script: broken } });
      assert.equal(bad.isError, true);
      assert.match((bad.content as Content)[0].text ?? "", /#nope[\s\S]*\.mcp-broken\.ts:4/);
    } finally {
      rmSync(`${root}/${broken}`, { force: true });
    }

    const frame = (await client.callTool({ name: "preview_frame", arguments: { script: "examples/terminal.ts", at: 2, width: 640 } })).content as Content;
    const image = frame.find((c) => c.type === "image");
    assert.ok(image?.data && image.data.length > 1000, "preview returns a PNG");
  } catch (err) {
    if (err instanceof Error) err.message += `\n--- server stderr ---\n${serverLog.slice(-4000)}`;
    throw err;
  } finally {
    await client.close();
  }
});
