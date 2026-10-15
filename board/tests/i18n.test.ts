import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import worker from "../src/index.ts";
import { COMMENT_TYPES, PRIORITIES, pageLanguage } from "../src/validation.ts";
import { STATUS_SLUGS, VIEW_COLUMNS } from "../public/board/statuses.js";
import { database, DEV, keyOf, ownerCookie } from "./support.ts";

// The pages' language: every text lives in a pack, public/i18n/<code>.json. These tests keep the packs complete and in step with
// the markup and the scripts that use them, and run the loader (public/shared/i18n.js) against a stand-in page.
const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const PACKS = readdirSync(new URL("../public/i18n/", import.meta.url)).filter((name) => name.endsWith(".json")).sort();
const pack = (name: string) => JSON.parse(read("public/i18n/" + name)) as Record<string, string>;
const en = pack("en.json");
const placeholders = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

const HTML = ["public/board/index.html"];
const SCRIPTS = ["public/board/board.js"];

test("the packs are valid, flat, named by language code, and English is there", () => {
  assert.ok(PACKS.includes("en.json"));
  assert.ok(PACKS.includes("zh-CN.json"));
  for (const name of PACKS) {
    assert.match(name, /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*\.json$/, name);
    const data = pack(name);
    assert.ok(data && typeof data === "object" && !Array.isArray(data), name);
    for (const [key, value] of Object.entries(data)) {
      assert.match(key, /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, `${name}: the id ${key}`);
      assert.equal(typeof value, "string", `${name}: ${key}`);
      assert.notEqual(value.trim(), "", `${name}: ${key} is empty`);
    }
  }
});

test("every pack has exactly the keys of English, with the same placeholders", () => {
  for (const name of PACKS.filter((n) => n !== "en.json")) {
    const data = pack(name);
    assert.deepEqual(Object.keys(data).sort(), Object.keys(en).sort(), `${name}: keys differ from en.json`);
    for (const [key, value] of Object.entries(data)) assert.deepEqual(placeholders(value), placeholders(en[key]), `${name}: ${key}`);
  }
});

// The ids a page asks for ---------------------------------------------------------------------------------------------

function usedKeys() {
  const literal = new Set<string>(), families = new Set<string>();
  for (const file of HTML) {
    const html = read(file);
    for (const m of html.matchAll(/data-i18n(?:-files)?="([^"]+)"/g)) literal.add(m[1]);
    for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of m[1].split(";")) literal.add(pair.split(":")[1].trim());
  }
  for (const file of SCRIPTS) {
    const source = read(file);
    for (const m of source.matchAll(/\b(?:t|has)\(\s*"([a-z][a-z0-9_.]*)"(?!\s*\+)/g)) literal.add(m[1]);
    for (const m of source.matchAll(/\b(?:t|has)\(\s*"([a-z][a-z0-9_.]*\.)"\s*\+/g)) families.add(m[1]);
  }
  return { literal, families };
}

test("every id the pages use is in English, and every id in English is used", () => {
  const { literal, families } = usedKeys();
  for (const key of literal) assert.ok(key in en, `the pages use ${key}, which en.json does not have`);
  // The ids built from a prefix and a code: the prefixes the scripts build, and the complete lists behind them (below).
  assert.deepEqual([...families].sort(), ["board.action.", "board.error.", "column.", "priority.", "status.", "type."]);
  for (const key of Object.keys(en)) {
    const used = literal.has(key) || [...families].some((prefix) => key.startsWith(prefix));
    assert.ok(used, `${key} is in en.json but no page uses it`);
  }
});

test("the lists behind the ids built from a code are complete", () => {
  const keysOf = (prefix: string) => Object.keys(en).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
  assert.deepEqual(keysOf("status."), [...STATUS_SLUGS].sort());
  assert.deepEqual(keysOf("column."), VIEW_COLUMNS.map((c: { key: string }) => c.key).sort());
  assert.deepEqual(keysOf("priority."), [...PRIORITIES, "none"].sort());
  assert.deepEqual(keysOf("type."), [...COMMENT_TYPES].sort());
});

test("every error code the Worker can answer has a message, except those the page cannot meet", () => {
  const codes = new Set<string>();
  for (const file of ["src/index.ts", "src/validation.ts", "src/storage.ts"]) {
    for (const m of read(file).matchAll(/InputError\("([a-z_]+)"/g)) codes.add(m[1]);
    for (const m of read(file).matchAll(/json\(\{ error: "([a-z_]+)"/g)) codes.add(m[1]);
  }
  const board = Object.keys(en).filter((k) => k.startsWith("board.error.")).map((k) => k.slice("board.error.".length));
  for (const code of board) assert.ok(code === "generic" || codes.has(code), `board.error.${code} is not a code the Worker answers`);
  // The page never meets these: the origin check of the sign-in, a purge of a card that is not removed, and a database that
  // cannot be reached. The generic message ("Something went wrong: <code>") covers them if one does turn up.
  const never = ["invalid_origin", "not_removed", "unavailable"];
  for (const code of codes) if (!never.includes(code)) assert.ok(board.includes(code), `the board page has no message for ${code}`);
  // The sign-in's two answers.
  for (const code of ["link_invalid", "sign_in_locked"]) assert.ok(board.includes(code), code);
});

test("every action the Worker logs on a card has a word in the activity list", async () => {
  const bucket = { async put() {}, async get() { return null; }, async delete() {} };
  const { sqlite, env, request } = database({ FILES: bucket });
  try {
    const png = new Uint8Array(20); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const upload = (kind: string) => {
      const form = new FormData();
      form.set("kind", kind);
      form.append("file", new File([png], "a.png", { type: "image/png" }));
      return worker.fetch(new Request("http://localhost/api/cards/1/files", { method: "POST", headers: { authorization: "Bearer " + keyOf(DEV) }, body: form }), env);
    };
    const made = (await (await request("/api/cards", "POST", { title: "x" })).json()) as { no: number };
    assert.ok(made.no);
    for (const patch of [{ title: "y" }, { description: "d" }, { assignee: DEV }, { priority: "major" }, { chips: ["Bug"] }, { status: "progress" }]) {
      assert.equal((await request("/api/cards/1", "PATCH", patch)).status, 200);
    }
    const shot = await upload("screenshot");
    assert.equal(shot.status, 201);
    assert.equal((await upload("file")).status, 201);
    const id = ((await shot.json()) as { files: { id: string }[] }).files[0].id;
    assert.equal((await request(`/api/files/${id}`, "DELETE")).status, 200);
    assert.equal((await request("/api/cards/1", "DELETE")).status, 200);
    assert.equal((await request("/api/cards/1/restore", "POST")).status, 200);
    assert.equal((await request("/api/cards/1", "DELETE")).status, 200);
    const cookie = await ownerCookie(sqlite, env);
    assert.equal((await worker.fetch(new Request("http://localhost/api/cards/1?purge=1", { method: "DELETE", headers: { cookie, origin: "http://localhost", "x-board": "1" } }), env)).status, 200);
    const logged = sqlite.prepare("SELECT DISTINCT action FROM activity WHERE card_no IS NOT NULL").all().map((r) => String(r.action));
    const words = Object.keys(en).filter((k) => k.startsWith("board.action.")).map((k) => k.slice("board.action.".length));
    for (const action of logged) assert.ok(words.includes(action.replace(/ /g, "_")), `no word for the action "${action}"`);
    // Old boards also have "move" and "delete" in their activity.
    for (const word of words) assert.ok(logged.map((a) => a.replace(/ /g, "_")).includes(word) || ["move", "delete"].includes(word), `board.action.${word} is never logged`);
  } finally { sqlite.close(); }
});

// The markup keeps its English text, which the page shows until the pack is applied and when it cannot be loaded -------

function plain(markup: string) {
  return markup
    .replace(/<(?:code|br)\b[^>]*data-slot="(\w+)"[^>]*>(?:[^<]*<\/code>)?/g, "{$1}")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
test("the English text in the markup is the text of English", () => {
  for (const file of HTML) {
    const html = read(file);
    let checked = 0;
    for (const m of html.matchAll(/<(\w+)\b([^>]*?\bdata-i18n="([^"]+)"[^>]*)>([\s\S]*?)<\/\1\s*>/g)) {
      const [, , attrs, key, inner] = m;
      assert.equal(plain(inner), en[key].replace(/\s+/g, " ").trim(), `${file}: the text of ${key}`);
      checked++;
      // The variant for a board with files comes with its own text in the pack.
      const files = /data-i18n-files="([^"]+)"/.exec(attrs);
      if (files) assert.ok(files[1] in en, `${file}: ${files[1]}`);
    }
    assert.ok(checked > 5, file);
    for (const m of html.matchAll(/<(\w+)\b([^>]*?\bdata-i18n-attr="([^"]+)"[^>]*)>/g)) {
      for (const pair of m[3].split(";")) {
        const [attribute, key] = pair.split(":").map((s) => s.trim());
        const value = new RegExp(`\\b${attribute}="([^"]*)"`).exec(m[2]);
        assert.ok(value, `${file}: ${key} names the attribute ${attribute}, which the element does not have`);
        assert.equal(value![1].replace(/&quot;/g, '"'), en[key], `${file}: the ${attribute} of ${key}`);
      }
    }
  }
});

test("each page waits for its pack, and shows itself again whatever happens", () => {
  for (const file of HTML) assert.match(read(file), /<html lang="en" class="i18n-loading">/);
  for (const file of ["public/board/board.css"]) {
    const css = read(file);
    assert.match(css, /html\.i18n-loading body \{ visibility: hidden; animation: i18n-show 0s 2\.5s forwards; \}/);
    assert.match(css, /@keyframes i18n-show \{ to \{ visibility: visible; \} \}/);
  }
  // The scripts start only after init() has applied the pack.
  for (const file of SCRIPTS) assert.match(read(file), /^const INFO|const info = await init\(\);/m);
});

test("no text is left in the scripts that a visitor or the owner reads", () => {
  // A heuristic: a double-quoted string of words with a space, or a template with a space-separated word, that is not an id, a
  // selector, a header or a comment. Each hit would be English the pack cannot translate.
  for (const file of SCRIPTS) {
    const source = read(file).split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n").replace(/\/\/ .*$/gm, "");
    const hits = [...source.matchAll(/"([A-Z][a-z]+ [a-z][^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(hits, [], `${file} has English text that is not in the pack`);
  }
});

// The loader ------------------------------------------------------------------------------------------------------------

type Node = {
  dataset: Record<string, string>; attrs: Record<string, string>; textContent: string; children: unknown[];
  querySelectorAll(selector: string): Node[]; setAttribute(name: string, value: string): void; replaceChildren(...nodes: unknown[]): void;
};
function node(dataset: Record<string, string>, slots: Node[] = []): Node {
  return {
    dataset, attrs: {}, textContent: "", children: [],
    querySelectorAll: (selector) => (selector === "[data-slot]" ? slots : []),
    setAttribute(name, value) { this.attrs[name] = value; },
    replaceChildren(...nodes) { this.children = nodes; },
  };
}
async function loader(info: unknown, packs: Record<string, unknown>, nodes: Node[]) {
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  const state = { lang: "", removed: [] as string[] };
  Object.assign(globalThis, {
    fetch: async (url: string) => {
      fetched.push(url);
      if (url === "/api/info") return info === null ? { ok: false } : { ok: true, json: async () => info };
      const name = decodeURIComponent(url.replace("/i18n/", "").replace(/\.json$/, ""));
      return name in packs ? { ok: true, json: async () => packs[name] } : { ok: false };
    },
    document: {
      documentElement: { set lang(v: string) { state.lang = v; }, get lang() { return state.lang; }, classList: { remove: (name: string) => state.removed.push(name) } },
      querySelectorAll: (selector: string) => nodes.filter((n) => (selector === "[data-i18n]" ? "i18n" in n.dataset : "i18nAttr" in n.dataset)),
    },
  });
  // Each run needs its own copy of the module (it keeps the strings it loaded).
  const module = await import("../public/shared/i18n.js?" + Math.random());
  const result = await module.init();
  Object.assign(globalThis, { fetch: realFetch });
  delete (globalThis as { document?: unknown }).document;
  return { module, result, fetched, state };
}

test("the loader: the board's language, English underneath, placeholders, attributes, slots and the files variant", async () => {
  const heading = node({ i18n: "page.heading" }, [node({ slot: "br" })]);
  const plainText = node({ i18n: "page.text", i18nFiles: "page.text_files" });
  const field = node({ i18nAttr: "placeholder:page.hint; aria-label:page.label" });
  const untouched = node({ i18n: "page.only_in_english" });
  const { module, result, fetched, state } = await loader(
    { language: "zh-CN", files: true, projectName: "Demo" },
    {
      en: { "page.heading": "Help{br}us", "page.text": "Plain", "page.text_files": "With files", "page.hint": "Hint", "page.label": "Label", "page.only_in_english": "English", "page.size": "{n} of {total}" },
      "zh-CN": { "page.heading": "\u5e2e\u52a9{br}\u6211\u4eec", "page.text": "\u6587\u5b57", "page.text_files": "\u6709\u6587\u4ef6", "page.hint": "\u63d0\u793a", "page.label": "\u6807\u7b7e", "page.size": "{n} / {total}" },
    },
    [heading, plainText, field, untouched],
  );
  assert.deepEqual(result, { language: "zh-CN", files: true, projectName: "Demo" }); // what /api/info said
  assert.deepEqual(fetched.sort(), ["/api/info", "/i18n/en.json", "/i18n/zh-CN.json"]);
  assert.equal(state.lang, "zh-CN");
  assert.deepEqual(state.removed, ["i18n-loading"]);
  assert.deepEqual(heading.children, ["\u5e2e\u52a9", heading.querySelectorAll("[data-slot]")[0], "\u6211\u4eec"]); // the slot element goes where {br} is
  assert.equal(plainText.textContent, "\u6709\u6587\u4ef6"); // the board has files: the variant
  assert.deepEqual(field.attrs, { placeholder: "\u63d0\u793a", "aria-label": "\u6807\u7b7e" });
  assert.equal(untouched.textContent, "English"); // missing in zh-CN: English fills the gap
  assert.equal(module.t("page.size", { n: 3, total: 9 }), "3 / 9");
  assert.equal(module.t("page.only_in_english"), "English");
  assert.equal(module.t("page.nowhere"), "page.nowhere"); // an unknown id is the id, never undefined
  assert.equal(module.t("page.size", { n: 3 }), "3 / {total}"); // a missing parameter stays visible
  assert.equal(module.has("page.size"), true);
  assert.equal(module.has("page.nowhere"), false);
  assert.equal(module.language(), "zh-CN");
  assert.equal(module.locale(), "zh-CN");
  assert.equal(module.formatSize(300 * 1024), "300 KB");
  assert.equal(module.formatSize(4 * 1048576), "4 MB");
  assert.equal(module.formatSize(1.5 * 1048576), "1.5 MB");
});

test("the loader: English without files, and a missing pack, a failed /api/info or a bad language all fall back to English", async () => {
  const text = node({ i18n: "page.text", i18nFiles: "page.text_files" });
  const pack = { en: { "page.text": "Plain", "page.text_files": "With files" } };
  let run = await loader({ language: "en", files: false }, pack, [text]);
  assert.equal(text.textContent, "Plain");
  assert.deepEqual(run.fetched.sort(), ["/api/info", "/i18n/en.json"]); // English is not fetched twice
  assert.equal(run.state.lang, "en");

  // A language the board names but has no pack for: the page is English and says so in its lang attribute.
  run = await loader({ language: "fr-CA", files: true }, pack, [text]);
  assert.equal(text.textContent, "With files");
  assert.equal(run.state.lang, "en");
  assert.equal(run.module.language(), "en");

  // /api/info cannot be read: no files, English.
  run = await loader(null, pack, [text]);
  assert.deepEqual(run.result, {});
  assert.equal(text.textContent, "Plain");
  assert.deepEqual(run.state.removed, ["i18n-loading"]);

  // A language that is not a code is never fetched.
  run = await loader({ language: "../../secret" }, pack, [text]);
  assert.deepEqual(run.fetched.sort(), ["/api/info", "/i18n/en.json"]);
});

// What the Worker does with the language ------------------------------------------------------------------------------

test("the language is a code, or English", () => {
  for (const [given, wanted] of [["zh-CN", "zh-CN"], ["en", "en"], [" fr ", "fr"], ["pt-BR", "pt-BR"], [undefined, "en"], ["", "en"], ["x", "en"], ["../x", "en"], ["zh_CN", "en"], ["a".repeat(30), "en"], [7, "en"]] as const) {
    assert.equal(pageLanguage(given), wanted, String(given));
  }
});
