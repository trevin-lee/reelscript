import { test } from "node:test";
import assert from "node:assert/strict";
import { EDITOR_DEFAULT_SETTINGS, editorStyles, editorTitle } from "../src/editor.js";

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
