import assert from "node:assert/strict";
import { test } from "node:test";
import { InputError, keyFromName, projectKey, projectName } from "../src/validation.ts";

const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof InputError ? e.code : String(e); }
  return "";
};

test("a key is lowercase latin letters, digits and single hyphens", () => {
  assert.equal(projectKey("main"), "main");
  assert.equal(projectKey("  My-App-2 "), "my-app-2");
  assert.equal(code(() => projectKey("")), "invalid_key");
  assert.equal(code(() => projectKey("a b")), "invalid_key");
  assert.equal(code(() => projectKey("-a")), "invalid_key");
  assert.equal(code(() => projectKey("a--b")), "invalid_key");
  assert.equal(code(() => projectKey("a/b")), "invalid_key");
  assert.equal(code(() => projectKey("\u6e38\u620f")), "invalid_key", "non-latin letters");
  assert.equal(code(() => projectKey(5)), "invalid_key");
});

test("a key is at most 30 characters", () => {
  assert.equal(code(() => projectKey("a".repeat(30))), "");
  assert.equal(code(() => projectKey("a".repeat(31))), "invalid_key");
});

test("'all' is reserved for comment listings", () => {
  assert.equal(code(() => projectKey("all")), "invalid_key");
  assert.equal(code(() => projectKey("ALL")), "invalid_key");
  assert.equal(code(() => projectKey("all-in")), "");
});

test("a name is 1 to 60 characters, trimmed", () => {
  assert.equal(projectName("  \u7b14\u8bb0  "), "\u7b14\u8bb0");
  assert.equal(code(() => projectName("   ")), "invalid_name");
  assert.equal(code(() => projectName("n".repeat(61))), "invalid_name");
  assert.equal(code(() => projectName("n".repeat(60))), "");
  assert.equal(code(() => projectName(null)), "invalid_name");
});

test("the key comes from the name when it has latin letters or digits", () => {
  assert.equal(keyFromName("My App 2"), "my-app-2");
  assert.equal(keyFromName("  Home & Garden!! "), "home-garden");
  assert.equal(keyFromName("My App \u7b14\u8bb0"), "my-app");
  assert.equal(keyFromName("a".repeat(29) + " b"), "a".repeat(29));
});

test("a name with nothing latin needs a key of its own", () => {
  assert.equal(code(() => keyFromName("\u6211\u7684\u6e38\u620f")), "invalid_key");
  assert.equal(code(() => keyFromName("!!!")), "invalid_key");
  assert.equal(code(() => keyFromName("All")), "invalid_key");
});
