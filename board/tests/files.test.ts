import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import worker from "../src/index.ts";
import { database, DEV, keyOf, OWNER_KEY, type Env } from "./support.ts";

// File storage (the R2 bucket, the FILES binding) is optional. These tests run the Worker
// in both modes: with a bucket (an in-memory stand-in that records every call) and without.
const ORIGIN = "http://localhost";
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

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
function feedback(env: Env, images: number) {
  const form = new FormData();
  form.set("requestId", crypto.randomUUID());
  form.set("description", "A visitor's report");
  for (let i = 0; i < images; i++) form.append("images", new File([PNG], `s${i}.png`, { type: "image/png" }));
  return worker.fetch(new Request(ORIGIN + "/api/feedback", { method: "POST", headers: { origin: ORIGIN }, body: form }), env);
}
const get = (env: Env, path: string, method = "GET") => worker.fetch(new Request(ORIGIN + path, { method, headers: asDev }), env);
// The owner, as the board page does it: sign in with the owner key, then send the cookie with the page's own headers.
async function asOwner(env: Env, path: string, method: string) {
  const session = await worker.fetch(new Request(ORIGIN + "/api/session", {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ key: OWNER_KEY }),
  }), env);
  const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0];
  return worker.fetch(new Request(ORIGIN + path, { method, headers: { cookie, origin: ORIGIN, "x-board": "1" } }), env);
}

test("with a bucket: info says files, uploads are stored, served and deleted, feedback keeps its images", async () => {
  const r2 = bucket();
  const { sqlite, env } = database({ FILES: r2.store });
  try {
    const info = await get(env, "/api/info");
    assert.deepEqual(await info.json(), { projectName: "Board", files: true });

    const shot = await upload(env, 1, "screenshot", "shot.png", "image/png");
    assert.equal(shot.status, 201);
    const id = ((await shot.json()) as { files: { id: string }[] }).files[0].id;
    assert.equal(r2.objects.size, 1);
    assert.equal(sqlite.prepare("SELECT kind FROM files WHERE id=?").get(id)?.kind, "screenshot");
    assert.equal((await upload(env, 1, "screenshot", "notes.txt", "text/plain")).status, 400); // not an image: refused, nothing stored
    assert.equal(r2.objects.size, 1);
    assert.equal((await upload(env, 1, "file", "notes.txt", "text/plain", new TextEncoder().encode("hello"))).status, 201);

    const served = await get(env, `/api/files/${id}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), PNG);

    // A visitor's feedback with an image stores it and files it on the card.
    assert.equal((await feedback(env, 1)).status, 201);
    assert.equal(r2.objects.size, 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM files WHERE created_by='visitor'").get()?.n, 1);

    // Deleting a file and purging a card clean the bucket as well.
    assert.equal((await get(env, `/api/files/${id}`, "DELETE")).status, 200);
    assert.equal(r2.objects.size, 2);
    // Purging is the owner's.
    assert.equal((await get(env, "/api/cards/1", "DELETE")).status, 200);
    assert.equal((await asOwner(env, "/api/cards/1?purge=1", "DELETE")).status, 200);
    assert.equal(r2.objects.size, 1); // only the feedback image is left
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM files").get()?.n, 1);
  } finally { sqlite.close(); }
});

test("without a bucket: info says no files, and the file endpoints answer 501 files_disabled", async () => {
  const { sqlite, env } = database({ FILES: undefined });
  try {
    sqlite.exec("INSERT INTO files(id,card_no,kind,name,type,size,created_at,created_by) VALUES ('f1',1,'screenshot','old.png','image/png',12,'2026-10-03T00:00:00Z','x')");
    const info = await get(env, "/api/info");
    assert.equal(info.status, 200);
    assert.deepEqual(await info.json(), { projectName: "Board", files: false });

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

test("without a bucket: deleting a file and purging a card with files still clean the database", async () => {
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
    assert.equal((await asOwner(env, "/api/cards/1?purge=1", "DELETE")).status, 200);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM files").get()?.n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM cards WHERE no=1").get()?.n, 0);
  } finally { sqlite.close(); }
});

test("without a bucket the public feedback form works without images and refuses images", async () => {
  const { sqlite, env } = database({ FILES: undefined });
  try {
    const ok = await feedback(env, 0);
    assert.equal(ok.status, 201);
    const card = sqlite.prepare("SELECT col,status,description FROM cards WHERE source='feedback'").get() as { col: string; status: string; description: string };
    assert.deepEqual({ ...card }, { col: "feedback", status: "feedback", description: "A visitor's report" });

    const refused = await feedback(env, 1);
    assert.equal(refused.status, 501);
    assert.deepEqual(await refused.json(), { error: "files_disabled" });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM cards WHERE source='feedback'").get()?.n, 1); // no half-made card
  } finally { sqlite.close(); }
});

test("every use of the bucket in the Worker goes through the guards", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  // env.FILES is read in `bucket()` and used directly only in `dropObjects()`, after its own check.
  assert.deepEqual(source.match(/env\.FILES\.\w+/g), ["env.FILES.delete"]);
  assert.match(source, /FILES\?: R2Bucket/);
});

test("the pages hide the image and attach controls when the board has no file storage", () => {
  const feedback = readFileSync(new URL("../public/feedback/index.html", import.meta.url), "utf8");
  // The screenshot field, its drop zone and the previews start hidden and are shown only when /api/info says files.
  assert.match(feedback, /<div\s+id="dropzone"\s+data-needs-files\s+hidden/);
  assert.match(feedback, /<div id="previews"[^>]*data-needs-files hidden/);
  assert.match(feedback, /<div class="label-row" data-needs-files hidden>/);
  const app = readFileSync(new URL("../public/feedback/app.js", import.meta.url), "utf8");
  assert.match(app, /info\.files === true/);
  assert.match(app, /if \(busy \|\| !filesEnabled\) return;/); // no image can be added, pasted or dropped
  const board = readFileSync(new URL("../public/board/board.js", import.meta.url), "utf8");
  assert.match(board, /FILES = info\.files !== false/);
  assert.match(board, /FILES && \[/); // the screenshots and files rows of the card dialog
  assert.match(board, /if \(!FILES \|\| !openNo/); // pasting an image
});
