import { test } from "node:test";
import assert from "node:assert/strict";
import { cardTitle, fields, hasContent, InputError } from "../src/validation.ts";

const ID = crypto.randomUUID();
function form(values: Record<string, string>) {
  const f = new FormData();
  f.set("requestId", ID);
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

test("every written field is optional", () => {
  const data = fields(form({}));
  assert.equal(data.title, "");
  assert.equal(data.description, "");
  assert.equal(data.report, "");
  assert.equal(data.contact, "");
});

test("an old page's kind is ignored, a bad request id is not", () => {
  assert.doesNotThrow(() => fields(form({ kind: "bug" })));
  assert.doesNotThrow(() => fields(form({ kind: "nonsense" })));
  const bad = new FormData();
  bad.set("requestId", "nope");
  assert.throws(() => fields(bad), (e) => e instanceof InputError && e.code === "invalid_fields");
});

test("nothing at all can't be submitted, any one thing can", () => {
  assert.equal(hasContent(fields(form({})), 0), false);
  assert.equal(hasContent(fields(form({ description: "   \n " })), 0), false);
  assert.equal(hasContent(fields(form({ title: "x" })), 0), true);
  assert.equal(hasContent(fields(form({ description: "x" })), 0), true);
  assert.equal(hasContent(fields(form({ report: "x" })), 0), true);
  assert.equal(hasContent(fields(form({ contact: "x" })), 0), true);
  assert.equal(hasContent(fields(form({})), 1), true);
});

test("limits still hold", () => {
  assert.throws(() => fields(form({ title: "x".repeat(121) })));
  assert.throws(() => fields(form({ description: "x".repeat(6001) })));
  assert.throws(() => fields(form({ contact: "x".repeat(201) })));
});

test("the card title: own title, first line, or what the card holds", () => {
  assert.equal(cardTitle(fields(form({ title: "Mine", description: "other" })), 0), "Mine");
  assert.equal(cardTitle(fields(form({ description: "\n  First line  \nsecond" })), 0), "First line");
  assert.equal(cardTitle(fields(form({ description: "x".repeat(200) })), 0).length, 80);
  assert.equal(cardTitle(fields(form({ report: "version 1.1.0" })), 0), "(diagnostics only)");
  assert.equal(cardTitle(fields(form({})), 2), "(screenshots only, 2)");
  assert.equal(cardTitle(fields(form({ contact: "me" })), 0), "(contact only)");
  for (const d of [{ description: "x".repeat(300) }, { description: "" }]) {
    const t = cardTitle(fields(form({ ...d, report: "r" })), 0);
    assert.ok(t.length >= 1 && t.length <= 200);
  }
});
