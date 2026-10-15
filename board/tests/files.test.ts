import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import worker from "../src/index.ts";
import { bytesOf, D1_MAX_FILE, fileMode, MAX_ATTACHMENT } from "../src/storage.ts";
import { database, DEV, keyOf, ownerCookie, type Env } from "./support.ts";

// File storage is optional and has three modes (FILE_STORAGE): "r2" (the FILES bucket), "d1" (a table in the database) and
// "none". These tests run the Worker in each: with a bucket (an in-memory stand-in that records every call), with the
// database as the store, and with neither.
const ORIGIN = "http://localhost";
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
// A PNG-looking file of a given size.
const png = (size: number) => { const bytes = new Uint8Array(size); bytes.set(PNG); return bytes; };

function bucket() {
  const objects = new Map<string, { bytes: Uint8Array; type?: string }>();
  const calls: string[] = [];
  const store = {
    async put(id: string, bytes: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) { calls.push("put"); objects.set(id, { bytes, type: options?.httpMetadata?.contentType }); },
    async get(id: string) { calls.push("get"); const o = objects.get(id); return o ? { body: new Blob([o.bytes]).stream() } : null; },
    async delete(ids: string | string[]) { calls.push("delete"); for (const id of [ids].flat()) objects.delete(id); },
  };
  return { objects, calls, store };
}

const asDev = { authorization: "Bearer " + keyOf(DEV) };
function upload(env: Env, no: number, kind: string, name: string, type: string, bytes: Uint8Array = PNG) {
  const form = new FormData();
  form.set("kind", kind);
  form.append("file", new File([bytes], name, { type }));
  return worker.fetch(new Request(`${ORIGIN}/api/cards/${no}/files`, { method: "POST", headers: asDev, body: form }), env);
}
const get = (env: Env, path: string, method = "GET") => worker.fetch(new Request(ORIGIN + path, { method, headers: asDev }), env);
// The owner, as the board page does it: sign in with a one-time link, then send the cookie with the page's own headers.
async function asOwner(sqlite: Parameters<typeof ownerCookie>[0], env: Env, path: string, method: string) {
  const cookie = await ownerCookie(sqlite, env, ORIGIN);
  return worker.fetch(new Request(ORIGIN + path, { method, headers: { cookie, origin: ORIGIN, "x-board": "1" } }), env);
}
const idOf = async (res: Response) => ((await res.json()) as { files: { id: string }[] }).files[0].id;
const count = (sqlite: { prepare(sql: string): { get(): Record<string, unknown> | undefined } }, sql: string) => sqlite.prepare(sql).get()?.n;

test("which mode a board is in: FILE_STORAGE, and the old FILES binding alone means r2", () => {
  const bound = { DB: {}, FILES: {} };
  const env = (extra: Record<string, unknown>) => ({ DB: {}, ...extra }) as unknown as Parameters<typeof fileMode>[0];
  // No variable: a Worker with the binding is an old deployment and keeps using R2; without the binding there are no files.
  assert.equal(fileMode(env(bound)), "r2");
  assert.equal(fileMode(env({})), "none");
  assert.equal(fileMode(env({ FILE_STORAGE: "" })), "none");
  assert.equal(fileMode(env({ FILE_STORAGE: "", FILES: {} })), "r2");
  // The variable decides when it is set.
  assert.equal(fileMode(env({ FILE_STORAGE: "d1" })), "d1");
  assert.equal(fileMode(env({ FILE_STORAGE: "d1", FILES: {} })), "d1"); // a leftover binding is not used
  assert.equal(fileMode(env({ FILE_STORAGE: " D1 " })), "d1");
  assert.equal(fileMode(env({ FILE_STORAGE: "r2", FILES: {} })), "r2");
  assert.equal(fileMode(env({ FILE_STORAGE: "r2" })), "none"); // r2 with no bucket has nowhere to put anything
  assert.equal(fileMode(env({ FILE_STORAGE: "none", FILES: {} })), "none");
  assert.equal(fileMode(env({ FILE_STORAGE: "s3", FILES: {} })), "none"); // an unknown word is no storage
});

test("what D1 hands back for a BLOB is read as bytes whatever its shape", () => {
  const bytes = Uint8Array.from([1, 2, 3, 255]);
  assert.deepEqual(bytesOf(bytes), bytes);
  assert.deepEqual(bytesOf(bytes.buffer), bytes);
  assert.deepEqual(bytesOf([1, 2, 3, 255]), bytes);
  assert.deepEqual(bytesOf(new DataView(bytes.buffer)), bytes);
  assert.deepEqual(bytesOf(Buffer.from(bytes)), bytes);
  assert.throws(() => bytesOf("text"));
  assert.throws(() => bytesOf(null));
});

test("r2: info says so, uploads are stored, served and deleted", async () => {
  const r2 = bucket();
  const { sqlite, env } = database({ FILES: r2.store, FILE_STORAGE: "r2" });
  try {
    const info = await get(env, "/api/info");
    assert.deepEqual(await info.json(), { projectName: "Board", files: true, fileStorage: "r2", maxFileBytes: MAX_ATTACHMENT, language: "en" });

    const shot = await upload(env, 1, "screenshot", "shot.png", "image/png");
    assert.equal(shot.status, 201);
    const id = await idOf(shot);
    assert.equal(r2.objects.size, 1);
    assert.equal(r2.objects.get(id)?.type, "image/png");
    assert.equal(sqlite.prepare("SELECT kind FROM files WHERE id=?").get(id)?.kind, "screenshot");
    assert.equal((await upload(env, 1, "screenshot", "notes.txt", "text/plain")).status, 400); // not an image: refused, nothing stored
    assert.equal(r2.objects.size, 1);
    assert.equal((await upload(env, 1, "file", "notes.txt", "text/plain", new TextEncoder().encode("hello"))).status, 201);

    const served = await get(env, `/api/files/${id}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), PNG);

    // Deleting a file and purging a card clean the bucket as well.
    assert.equal((await get(env, `/api/files/${id}`, "DELETE")).status, 200);
    assert.equal(r2.objects.size, 1); // the attachment is left
    // Purging is the owner's.
    assert.equal((await get(env, "/api/cards/1", "DELETE")).status, 200);
    assert.equal((await asOwner(sqlite, env, "/api/cards/1?purge=1", "DELETE")).status, 200);
    assert.equal(r2.objects.size, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM files").get()?.n, 0);
    assert.equal(count(sqlite, "SELECT COUNT(*) AS n FROM file_blobs"), 0); // the database holds no bytes in this mode
  } finally { sqlite.close(); }
});

test("r2: a file over 25 MB is refused with file_too_large and nothing is stored", async () => {
  const r2 = bucket();
  const { sqlite, env } = database({ FILES: r2.store, FILE_STORAGE: "r2" });
  try {
    assert.equal((await upload(env, 1, "file", "ok.bin", "application/octet-stream", new Uint8Array(MAX_ATTACHMENT))).status, 201);
    const big = await upload(env, 1, "file", "big.bin", "application/octet-stream", new Uint8Array(MAX_ATTACHMENT + 1));
    assert.equal(big.status, 413);
    assert.deepEqual(await big.json(), { error: "file_too_large" });
    assert.equal(r2.objects.size, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM files").get()?.n, 1);
    assert.equal((await upload(env, 1, "file", "empty.txt", "text/plain", new Uint8Array(0))).status, 400);
  } finally { sqlite.close(); }
});

test("a Worker with the FILES binding and no FILE_STORAGE variable behaves as r2; FILE_STORAGE none switches the binding off", async () => {
  const old = bucket();
  const oldBoard = database({ FILES: old.store }); // no FILE_STORAGE: an old deployment
  try {
    assert.equal(((await (await get(oldBoard.env, "/api/info")).json()) as { fileStorage: string }).fileStorage, "r2");
    assert.equal((await upload(oldBoard.env, 1, "screenshot", "shot.png", "image/png")).status, 201);
    assert.equal(old.objects.size, 1);
  } finally { oldBoard.sqlite.close(); }

  const off = bucket();
  const none = database({ FILES: off.store, FILE_STORAGE: "none" });
  try {
    assert.deepEqual(await (await get(none.env, "/api/info")).json(), { projectName: "Board", files: false, fileStorage: "none", maxFileBytes: 0, language: "en" });
    const res = await upload(none.env, 1, "screenshot", "shot.png", "image/png");
    assert.equal(res.status, 501);
    assert.deepEqual(await res.json(), { error: "files_disabled" });
    assert.deepEqual(off.calls, []); // the bucket was never touched
  } finally { none.sqlite.close(); }
});

test("none: info says no files, and the file endpoints answer 501 files_disabled", async () => {
  const { sqlite, env } = database({ FILES: undefined });
  try {
    sqlite.exec("INSERT INTO files(id,card_no,kind,name,type,size,created_at,created_by) VALUES ('f1',1,'screenshot','old.png','image/png',12,'2026-10-03T00:00:00Z','x')");
    const info = await get(env, "/api/info");
    assert.equal(info.status, 200);
    assert.deepEqual(await info.json(), { projectName: "Board", files: false, fileStorage: "none", maxFileBytes: 0, language: "en" });

    for (const [res, what] of [
      [await upload(env, 1, "screenshot", "shot.png", "image/png"), "upload a screenshot"],
      [await upload(env, 1, "file", "notes.txt", "text/plain"), "upload a file"],
      [await get(env, "/api/files/f1"), "download a stored file"],
      [await get(env, "/api/files/no-such-file"), "download an unknown file"],
    ] as const) {
      assert.equal(res.status, 501, what);
      assert.deepEqual(await res.json(), { error: "files_disabled" }, what);
    }
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM files").get()?.n, 1); // nothing was added

    // Everything else keeps working; the row left over from a time with a bucket is still listed on its card.
    const card = (await (await get(env, "/api/cards/1")).json()) as { files: unknown[] };
    assert.equal(card.files.length, 1);
    assert.equal((await get(env, "/api/cards")).status, 200);
  } finally { sqlite.close(); }
});

test("none: deleting a file and purging a card with files still clean the database", async () => {
  const { sqlite, env } = database({ FILES: undefined });
  try {
    const row = (id: string) => sqlite.exec(`INSERT INTO files(id,card_no,kind,name,type,size,created_at,created_by) VALUES ('${id}',1,'file','a.txt','text/plain',1,'2026-10-03T00:00:00Z','x')`);
    row("f1"); row("f2");
    const removed = await get(env, "/api/files/f1", "DELETE");
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { id: "f1", deleted: true });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM files WHERE id='f1'").get()?.n, 0);
    assert.equal((await get(env, "/api/cards/1", "DELETE")).status, 200); // removed, not yet gone
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM files").get()?.n, 1);
    assert.equal((await asOwner(sqlite, env, "/api/cards/1?purge=1", "DELETE")).status, 200);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM files").get()?.n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM cards WHERE no=1").get()?.n, 0);
  } finally { sqlite.close(); }
});

test("d1: info says so, a file round-trips through the database, delete and purge remove the bytes too", async () => {
  const { sqlite, env } = database({ FILES: undefined, FILE_STORAGE: "d1" });
  try {
    const info = await get(env, "/api/info");
    assert.deepEqual(await info.json(), { projectName: "Board", files: true, fileStorage: "d1", maxFileBytes: D1_MAX_FILE, language: "en" });
    assert.ok(D1_MAX_FILE < 2_000_000, "a row, the bytes included, must stay under D1's 2 MB limit");

    const shot = await upload(env, 1, "screenshot", "shot.png", "image/png", png(5000));
    assert.equal(shot.status, 201);
    const id = await idOf(shot);
    assert.equal(count(sqlite, "SELECT COUNT(*) AS n FROM file_blobs"), 1);
    assert.equal(sqlite.prepare("SELECT length(data) AS n FROM file_blobs WHERE id=?").get(id)?.n, 5000);
    assert.equal(sqlite.prepare("SELECT kind, size FROM files WHERE id=?").get(id)?.size, 5000);
    assert.equal((await upload(env, 1, "screenshot", "notes.txt", "text/plain")).status, 400); // not an image: refused, nothing stored
    assert.equal(count(sqlite, "SELECT COUNT(*) AS n FROM file_blobs"), 1);
    const text = await upload(env, 1, "file", "notes.txt", "text/plain", new TextEncoder().encode("hello"));
    assert.equal(text.status, 201);
    const textId = await idOf(text);

    // The same bytes come back, an image inline and anything else as a download.
    const served = await get(env, `/api/files/${id}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.match(served.headers.get("content-disposition") ?? "", /^inline/);
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), png(5000));
    const attachment = await get(env, `/api/files/${textId}`);
    assert.equal(attachment.headers.get("content-type"), "application/octet-stream");
    assert.match(attachment.headers.get("content-disposition") ?? "", /^attachment/);
    assert.equal(await attachment.text(), "hello");
    assert.equal((await get(env, "/api/files/no-such-file")).status, 404);
    sqlite.exec("INSERT INTO files(id,card_no,kind,name,type,size,created_at,created_by) VALUES ('gone',1,'file','x.txt','text/plain',1,'2026-10-03T00:00:00Z','x')");
    assert.equal((await get(env, "/api/files/gone")).status, 404); // a row whose bytes are missing

    // Deleting a file takes its bytes with it.
    assert.equal((await get(env, `/api/files/${textId}`, "DELETE")).status, 200);
    assert.equal(count(sqlite, "SELECT COUNT(*) AS n FROM file_blobs WHERE id='" + textId + "'"), 0);
    assert.equal(count(sqlite, "SELECT COUNT(*) AS n FROM file_blobs"), 1);

    // A second card keeps its bytes when the first is purged (a purge of 120 files also stays within D1's 100 values per statement).
    sqlite.exec("INSERT INTO cards(no,col,title,created_at,updated_at) VALUES (2,'backlog','other','2026-10-03T00:00:00Z','2026-10-03T00:00:00Z')");
    const other = await idOf(await upload(env, 2, "screenshot", "keep.png", "image/png"));
    for (let i = 0; i < 120; i++) {
      sqlite.exec(`INSERT INTO files(id,card_no,kind,name,type,size,created_at,created_by) VALUES ('m${i}',1,'file','a.bin','application/octet-stream',1,'2026-10-03T00:00:00Z','x')`);
      sqlite.exec(`INSERT INTO file_blobs(id,data) VALUES ('m${i}', x'00')`);
    }
    assert.equal((await get(env, "/api/cards/1", "DELETE")).status, 200);
    assert.equal((await asOwner(sqlite, env, "/api/cards/1?purge=1", "DELETE")).status, 200);
    assert.equal(count(sqlite, "SELECT COUNT(*) AS n FROM file_blobs"), 1);
    assert.equal(sqlite.prepare("SELECT id FROM file_blobs").get()?.id, other);
    assert.equal(count(sqlite, "SELECT COUNT(*) AS n FROM files"), 1);
    assert.equal((await get(env, `/api/files/${other}`)).status, 200);
  } finally { sqlite.close(); }
});

test("d1: a file over the cap is refused with file_too_large, one exactly at it is stored", async () => {
  const { sqlite, env } = database({ FILES: undefined, FILE_STORAGE: "d1" });
  try {
    assert.equal((await upload(env, 1, "screenshot", "edge.png", "image/png", png(D1_MAX_FILE))).status, 201);
    const stored = sqlite.prepare("SELECT length(data) AS n FROM file_blobs").get()?.n;
    assert.equal(stored, D1_MAX_FILE);
    for (const [kind, name, type, bytes] of [
      ["screenshot", "big.png", "image/png", png(D1_MAX_FILE + 1)],
      ["file", "big.bin", "application/octet-stream", new Uint8Array(D1_MAX_FILE + 1)],
    ] as const) {
      const res = await upload(env, 1, kind, name, type, bytes);
      assert.equal(res.status, 413, kind);
      assert.deepEqual(await res.json(), { error: "file_too_large" }, kind);
    }
    // Nothing of the refused files was stored.
    assert.equal(count(sqlite, "SELECT COUNT(*) AS n FROM files"), 1);
    assert.equal(count(sqlite, "SELECT COUNT(*) AS n FROM file_blobs"), 1);
  } finally { sqlite.close(); }
});

test("d1: bytes that D1 returns as an array of numbers are served correctly", async () => {
  const { sqlite, env, DB } = database({ FILES: undefined, FILE_STORAGE: "d1" });
  try {
    const id = await idOf(await upload(env, 1, "screenshot", "shot.png", "image/png", png(3000)));
    // The binding answers a BLOB column as a plain array of numbers.
    type Prepared = ReturnType<typeof DB.prepare>;
    const arrays = (statement: Prepared): Prepared => ({
      bind: (...values: unknown[]) => arrays(statement.bind(...values)),
      first: async (column?: string) => {
        const row = (await statement.first(column)) as { data?: unknown } | null;
        return row && row.data instanceof Uint8Array ? { ...row, data: Array.from(row.data) } : row;
      },
      all: () => statement.all(),
      run: () => statement.run(),
    }) as unknown as Prepared;
    const asArrays = { ...env, DB: { prepare: (sql: string) => arrays(DB.prepare(sql)), batch: DB.batch } } as unknown as Env;
    const served = await get(asArrays, `/api/files/${id}`);
    assert.equal(served.status, 200);
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), png(3000));
  } finally { sqlite.close(); }
});

test("a failed batch after the bytes were stored removes the bytes again", async () => {
  const { sqlite, env, DB } = database({ FILES: undefined, FILE_STORAGE: "d1" });
  const log = console.error;
  console.error = () => {}; // the Worker logs the failure it answers with 503
  try {
    // The first batch (the files row) fails, the cleanup after it works.
    let failed = false;
    const flaky = { ...env, DB: { prepare: DB.prepare, batch: async (statements: Parameters<typeof DB.batch>[0]) => {
      if (!failed) { failed = true; throw new Error("the database went away"); }
      return DB.batch(statements);
    } } } as unknown as Env;
    const res = await upload(flaky, 1, "screenshot", "shot.png", "image/png");
    assert.equal(res.status, 503);
    assert.equal(count(sqlite, "SELECT COUNT(*) AS n FROM file_blobs"), 0);
    assert.equal(count(sqlite, "SELECT COUNT(*) AS n FROM files"), 0);
  } finally { console.error = log; sqlite.close(); }
});

test("every use of the file store in the Worker goes through the guards", () => {
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  // The Worker never touches the bucket or the blob table itself, and never branches on the mode.
  assert.equal(index.match(/env\.FILES/g), null);
  assert.equal(index.match(/file_blobs/g), null);
  assert.equal(index.match(/store\.mode|\.mode ===/g), null);
  const storage = readFileSync(new URL("../src/storage.ts", import.meta.url), "utf8");
  // The R2 binding is read in fileMode() and handed to r2Store(); only r2Store calls it.
  assert.deepEqual(storage.match(/bucket\.(put|get|delete)\(/g), ["bucket.put(", "bucket.get(", "bucket.delete("]);
  assert.deepEqual(storage.match(/env\.FILES\b/g), ["env.FILES", "env.FILES", "env.FILES"]);
  assert.match(storage, /FILES\?: R2Bucket/);
  assert.match(storage, /FILE_STORAGE\?: string/);
});
