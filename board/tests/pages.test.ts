import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// The board page is a plain file with no build step; these checks pin the wiring that the Worker's behaviour depends on.
const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("the only public pages are the sign-in and the static files: no other page, no form, no captcha", () => {
  assert.deepEqual(readdirSync(new URL("../public/", import.meta.url)).sort(), ["_headers", "board", "i18n", "shared"]);
  assert.ok(!existsSync(new URL("../public/index.html", import.meta.url)));
  const worker = read("wrangler.jsonc.tmpl");
  assert.match(worker, /"run_worker_first": \["\/api\/\*", "\/", "\/board"\]/);
});

test("the board page hides the screenshot and attach controls when the board has no file storage", () => {
  const board = read("public/board/board.js");
  assert.match(board, /FILES = INFO\.files !== false/);
  assert.match(board, /FILES && \[/); // the screenshots and files rows of the card dialog
  assert.match(board, /FILES && c\.thumb/); // the card's thumbnail
  assert.match(board, /if \(!FILES \|\| !openNo/); // pasting an image
});

test("pictures are shrunk before upload only on a board that keeps its files in its database, and the result is still checked", () => {
  const board = read("public/board/board.js");
  assert.match(board, /SHRINK = INFO\.fileStorage === "d1" \? MAX_FILE : 0/);
  assert.match(board, /await fitImage\(original, SHRINK\)/);
  assert.match(board, /if \(MAX_FILE && f\.size > MAX_FILE\)/); // a file still over the limit is not sent
  const shrink = read("public/shared/shrink.js");
  assert.match(shrink, /if \(!maxBytes \|\| file\.size <= maxBytes \|\| !SHRINKABLE\.includes\(file\.type\)\) return file;/); // nothing to do: the file as it is
  assert.match(shrink, /1600/); // the longest side
  assert.match(shrink, /catch \{\}\s*return file;/); // a canvas that fails: the file as it is
});

test("the sign-in page has no password: it takes a one-time link from the address fragment, sends it once and removes it from the address", () => {
  const html = read("public/board/index.html");
  assert.doesNotMatch(html, /type="password"|<form[^>]*id="gate-form"/); // nothing to type
  const board = read("public/board/board.js");
  assert.match(board, /location\.hash\.match\(\/\^#link=\(\[A-Za-z0-9_-\]\+\)\$\/\)/); // only the fragment, never the query string
  assert.match(board, /history\.replaceState\(null, "", location\.pathname \+ location\.search\);[\s\S]*\{ link: m\[1\] \}/); // out of the address bar before it is sent
  assert.doesNotMatch(board + html, /owner key|owner-key|password/i);
});

test("the content security policy is as strict as it can be: same-origin scripts, styles and requests only", () => {
  const headers = read("public/_headers");
  const policy = /Content-Security-Policy: (.*)/.exec(headers)?.[1] ?? "";
  assert.equal(policy, "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' blob: data:; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  // The scripts and the packs are same-origin files: no inline script, style or handler, no other host.
  const html = read("public/board/index.html");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, "an inline script");
  assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/, "an inline style or handler");
  for (const file of ["public/shared/i18n.js", "public/shared/shrink.js", "public/board/board.js", "public/board/index.html"]) {
    assert.doesNotMatch(read(file), /https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i, `${file}: a host`);
  }
  // Packs and shared scripts are not cached, like the page, so a changed translation shows at once.
  assert.match(headers, /\/shared\/\*\n\s+Cache-Control: no-cache/);
  assert.match(headers, /\/i18n\/\*\n\s+Cache-Control: no-cache/);
});

test("the access modes reach the page: a visitor reads (nothing to edit, cards locked), an open board has no sign-out", () => {
  const board = read("public/board/board.js");
  const css = read("public/board/board.css");
  assert.match(board, /document\.body\.classList\.toggle\("open", INFO\.access === "open"\)/);
  assert.match(board, /document\.body\.classList\.toggle\("readonly", me\.actor === "viewer"\)/);
  assert.match(board, /draggable: me\.actor === "viewer" \? "false" : "true"/);
  assert.match(board, /me && me\.actor === "viewer" && method !== "GET"/); // a write is never sent for a visitor
  assert.match(board, /if \(me\.actor === "viewer"\) for \(const x of \$\("card-form"\)/); // an open card is locked
  assert.match(css, /body\.open #logout \{ display: none; \}/);
  for (const id of ["new", "manage-chips", "projects-btn", "removed"]) assert.ok(css.includes(`body.readonly #${id}`), id);
  for (const code of ["board.readonly.who", "board.readonly.toast"]) {
    for (const lang of ["en", "zh-CN"]) assert.ok(read(`public/i18n/${lang}.json`).includes(`"${code}"`), `${lang} ${code}`);
  }
});
