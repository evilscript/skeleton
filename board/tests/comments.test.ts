import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_NAMES } from "../src/agents.ts";
import { commentFields, InputError, MAX_COMMENT_BYTES } from "../src/validation.ts";

const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof InputError ? e.code : String(e); }
  return "";
};

test("a plain note defaults to type note and nobody in particular", () => {
  assert.deepEqual(commentFields({ body: "  hello  " }), { body: "hello", type: "note", to: null, ref: "" });
});

test("type, target and link are kept when valid", () => {
  const to = AGENT_NAMES[0], ref = "https://github.com/example-org/example-repo/pull/42";
  const f = commentFields({ body: "ok", type: "review", to, ref });
  assert.deepEqual(f, { body: "ok", type: "review", to, ref });
});

test("empty, missing and non-text bodies are refused", () => {
  assert.equal(code(() => commentFields({ body: "   " })), "invalid_fields");
  assert.equal(code(() => commentFields({})), "invalid_fields");
  assert.equal(code(() => commentFields({ body: 5 })), "invalid_fields");
});

test("the size limit is in bytes, not characters", () => {
  assert.equal(code(() => commentFields({ body: "a".repeat(MAX_COMMENT_BYTES) })), "");
  assert.equal(code(() => commentFields({ body: "a".repeat(MAX_COMMENT_BYTES + 1) })), "comment_too_long");
  // 1366 euro signs (3 bytes each in UTF-8) are 4098 bytes.
  assert.equal(code(() => commentFields({ body: "\u20ac".repeat(1366) })), "comment_too_long");
  assert.equal(code(() => commentFields({ body: "\u20ac".repeat(1365) })), "");
});

test("unknown type or target is refused", () => {
  assert.equal(code(() => commentFields({ body: "x", type: "shout" })), "invalid_type");
  assert.equal(code(() => commentFields({ body: "x", to: "bob" })), "invalid_to");
});

test("a link must be http(s)", () => {
  assert.equal(code(() => commentFields({ body: "x", ref: "javascript:alert(1)" })), "invalid_ref");
  assert.equal(code(() => commentFields({ body: "x", ref: "https://a b" })), "invalid_ref");
  assert.equal(code(() => commentFields({ body: "x", ref: "h".repeat(501) })), "invalid_ref");
});
