import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDITOR_DEFAULT_SETTINGS, editorStyles, editorTitle, registerExtensionFolder } from "../src/editor.js";

test("editorTitle strips the product name and joins with an em dash", () => {
  assert.equal(editorTitle("app.ts - acme - code-server", "x"), "app.ts — acme");
  assert.equal(editorTitle("acme - code-server", "x"), "acme");
  assert.equal(editorTitle("", "fallback"), "fallback");
});

test("editor defaults keep typing predictable and the AI panel closed", () => {
  assert.equal(EDITOR_DEFAULT_SETTINGS["editor.acceptSuggestionOnEnter"], "off");
  assert.equal(EDITOR_DEFAULT_SETTINGS["editor.autoClosingBrackets"], "never");
  assert.equal(EDITOR_DEFAULT_SETTINGS["chat.disableAIFeatures"], true);
});

test("editorStyles hides toasts unless asked", () => {
  assert.match(editorStyles(false), /notifications-toasts \{ display: none/);
  assert.doesNotMatch(editorStyles(true), /notifications-toasts/);
});

test("registerExtensionFolder copies the folder and lists it in the manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "rs-ext-"));
  const target = registerExtensionFolder(new URL("../examples/acme-ext", import.meta.url).pathname, dir);
  assert.equal(target, join(dir, "acme.acme-tools-0.1.0"));
  assert.ok(existsSync(join(target, "extension.js")));
  const manifest = JSON.parse(readFileSync(join(dir, "extensions.json"), "utf8"));
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].identifier.id, "acme.acme-tools");
  assert.equal(manifest[0].version, "0.1.0");
  // registering again replaces rather than duplicates
  registerExtensionFolder(new URL("../examples/acme-ext", import.meta.url).pathname, dir);
  assert.equal(JSON.parse(readFileSync(join(dir, "extensions.json"), "utf8")).length, 1);
});
