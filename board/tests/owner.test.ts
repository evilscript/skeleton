import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import worker from "../src/index.ts";
import { OWNER_ASSIGNEE } from "../src/agents.ts";
import { database, keyOf, LEAD, OWNER_KEY, SESSION_SECRET, type Env } from "./support.ts";

// The owner signs in with the owner key (OWNER_KEY) and gets a signed session cookie.
const ORIGIN = "http://localhost";
const signIn = (env: Env, body: unknown, origin = ORIGIN) => worker.fetch(new Request(origin + "/api/session", {
  method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
}), env);
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
// What the board page sends: the cookie, its own origin and the CSRF header.
const page = (env: Env, cookie: string, path: string, method = "GET", body?: unknown) => worker.fetch(new Request(ORIGIN + path, {
  method, headers: { cookie, origin: ORIGIN, "x-board": "1", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
}), env);
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
// A cookie built by hand, to test what the Worker accepts: "session=<name|exp>.<HMAC>".
function forge(secret: string, name: string, exp: number) {
  const body = b64url(`${name}|${exp}`);
  return `session=${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
const soon = () => Math.floor(Date.now() / 1000) + 3600;

test("a wrong owner key is refused; the right one sets the session cookie", async () => {
  const { sqlite, env } = database();
  try {
    for (const key of ["wrong", OWNER_KEY.slice(0, -1), OWNER_KEY + "x", "x".repeat(OWNER_KEY.length)]) {
      const res = await signIn(env, { key });
      assert.equal(res.status, 403, key);
      assert.deepEqual(await res.json(), { error: "not_owner" });
      assert.equal(res.headers.get("set-cookie"), null);
    }
    // No key at all, or not text, is a malformed request, not a wrong key.
    assert.equal((await signIn(env, {})).status, 400);
    assert.equal((await signIn(env, { key: 12345 })).status, 400);
    // The sign-in has to come from the board's own origin.
    const bad = await worker.fetch(new Request(ORIGIN + "/api/session", {
      method: "POST", headers: { origin: "https://elsewhere.example.test", "content-type": "application/json" }, body: JSON.stringify({ key: OWNER_KEY }),
    }), env);
    assert.equal(bad.status, 403);
    assert.deepEqual(await bad.json(), { error: "invalid_origin" });

    const ok = await signIn(env, { key: OWNER_KEY });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { name: OWNER_ASSIGNEE.name });
    const header = ok.headers.get("set-cookie") ?? "";
    assert.match(header, /^session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax"]) assert.ok(header.includes(flag), flag);
    // A pasted key often carries a trailing newline or spaces.
    assert.equal((await signIn(env, { key: ` ${OWNER_KEY}\n` })).status, 200);
  } finally { sqlite.close(); }
});

test("the session cookie makes the caller the owner, as OWNER_ASSIGNEE", async () => {
  const { sqlite, env } = database();
  try {
    const cookie = cookieOf(await signIn(env, { key: OWNER_KEY }));
    assert.ok(cookie.startsWith("session="));
    const none = await worker.fetch(new Request(ORIGIN + "/api/me"), env);
    assert.equal(none.status, 401);
    const me = await page(env, cookie, "/api/me");
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { actor: "owner", name: OWNER_ASSIGNEE.name });
    assert.equal((await page(env, cookie, "/api/cards")).status, 200);

    // Writes carry the owner's name on the card and in the activity log.
    const made = await page(env, cookie, "/api/cards", "POST", { title: "Made by the owner" });
    assert.equal(made.status, 201);
    const no = ((await made.json()) as { no: number }).no;
    assert.equal(sqlite.prepare("SELECT updated_by FROM cards WHERE no=?").get(no)?.updated_by, OWNER_ASSIGNEE.name);
    assert.equal(sqlite.prepare("SELECT actor FROM activity WHERE card_no=? AND action='create'").get(no)?.actor, OWNER_ASSIGNEE.name);
    assert.equal((await page(env, cookie, `/api/cards/${no}/comments`, "POST", { body: "hello", to: LEAD })).status, 201);
    assert.equal(sqlite.prepare("SELECT author FROM comments WHERE card_no=?").get(no)?.author, OWNER_ASSIGNEE.name);

    // A cookie alone is not enough for a write: the page's own origin and header are needed (CSRF).
    const blind = await worker.fetch(new Request(ORIGIN + "/api/cards", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ title: "from another site" }),
    }), env);
    assert.equal(blind.status, 401);

    // Only the owner can delete for good; an agent's key cannot.
    const agentPurge = async () => worker.fetch(new Request(`${ORIGIN}/api/cards/${no}?purge=1`, { method: "DELETE", headers: { authorization: "Bearer " + keyOf(LEAD) } }), env);
    assert.equal((await page(env, cookie, `/api/cards/${no}`, "DELETE")).status, 200);
    assert.equal((await agentPurge()).status, 403);
    assert.equal((await page(env, cookie, `/api/cards/${no}?purge=1`, "DELETE")).status, 200);

    // Signing out clears the cookie.
    const out = await worker.fetch(new Request(ORIGIN + "/api/session", { method: "DELETE" }), env);
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
  } finally { sqlite.close(); }
});

test("a cookie signed with another secret, expired, tampered or for another name is refused", async () => {
  const { sqlite, env } = database();
  try {
    const me = (cookie: string) => page(env, cookie, "/api/me");
    // The hand-built cookie is accepted when it is right, so the refusals below mean something.
    assert.equal((await me(forge(SESSION_SECRET, OWNER_ASSIGNEE.name, soon()))).status, 200);
    // Signed with another secret: a real cookie from another board.
    const other = database({ SESSION_SECRET: "another-secret-".repeat(4) });
    try {
      const foreign = cookieOf(await signIn(other.env, { key: OWNER_KEY }));
      assert.ok(foreign.startsWith("session="));
      assert.equal((await me(foreign)).status, 401);
    } finally { other.sqlite.close(); }
    assert.equal((await me(forge("another-secret-".repeat(4), OWNER_ASSIGNEE.name, soon()))).status, 401);
    // Expired, or no expiry at all.
    assert.equal((await me(forge(SESSION_SECRET, OWNER_ASSIGNEE.name, Math.floor(Date.now() / 1000) - 10))).status, 401);
    assert.equal((await me(forge(SESSION_SECRET, OWNER_ASSIGNEE.name, Number.NaN))).status, 401);
    // Signed correctly, but for somebody who is not the owner.
    assert.equal((await me(forge(SESSION_SECRET, "someone-else", soon()))).status, 401);
    // A valid body with another body's signature, and garbage.
    const good = forge(SESSION_SECRET, OWNER_ASSIGNEE.name, soon());
    const [body, sig] = good.slice("session=".length).split(".");
    const otherBody = b64url(`${OWNER_ASSIGNEE.name}|${soon() + 86400 * 365}`);
    assert.equal((await me(`session=${otherBody}.${sig}`)).status, 401);
    assert.equal((await me(`session=${body}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`)).status, 401);
    assert.equal((await me("session=not-a-cookie")).status, 401);
    // Without a SESSION_SECRET on the Worker no cookie is accepted at all.
    const bare = database({ SESSION_SECRET: undefined });
    try { assert.equal((await page(bare.env, good, "/api/me")).status, 401); } finally { bare.sqlite.close(); }
  } finally { sqlite.close(); }
});

test("the owner key is only for signing in; a missing or short OWNER_KEY locks the owner out", async () => {
  const { sqlite, env } = database();
  try {
    // It is not an agent key: as a bearer token it opens nothing.
    const bearer = await worker.fetch(new Request(ORIGIN + "/api/me", { headers: { authorization: "Bearer " + OWNER_KEY } }), env);
    assert.equal(bearer.status, 401);
  } finally { sqlite.close(); }
  for (const OWNER of [undefined, "", "short-key", "x".repeat(31)]) {
    const board = database({ OWNER_KEY: OWNER });
    try {
      const res = await signIn(board.env, { key: OWNER || "anything" });
      assert.equal(res.status, 403, String(OWNER));
      assert.equal(res.headers.get("set-cookie"), null);
    } finally { board.sqlite.close(); }
  }
  // 32 characters is enough.
  const exact = database({ OWNER_KEY: "k".repeat(32) });
  try { assert.equal((await signIn(exact.env, { key: "k".repeat(32) })).status, 200); } finally { exact.sqlite.close(); }
  // Without a SESSION_SECRET no cookie can be signed, so even the right key is refused.
  const bare = database({ SESSION_SECRET: undefined });
  try { assert.equal((await signIn(bare.env, { key: OWNER_KEY })).status, 403); } finally { bare.sqlite.close(); }
});

test("the development sign-in works only on localhost with ENVIRONMENT=development", async () => {
  const { sqlite, env } = database();
  try {
    const dev = await signIn(env, { dev: true });
    assert.equal(dev.status, 200);
    assert.deepEqual(await dev.json(), { name: OWNER_ASSIGNEE.name });
    assert.equal((await page(env, cookieOf(dev), "/api/me")).status, 200);
    // Production, or a real host: `dev` is just a request without a key.
    const production = database({ ENVIRONMENT: "production" });
    try {
      const res = await signIn(production.env, { dev: true });
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("set-cookie"), null);
    } finally { production.sqlite.close(); }
    const remote = await signIn(env, { dev: true }, "https://board.example.test");
    assert.equal(remote.status, 400);
    assert.equal(remote.headers.get("set-cookie"), null);
  } finally { sqlite.close(); }
});

test("the public config has no sign-in provider in it", async () => {
  const { sqlite, env } = database({ TURNSTILE_SITE_KEY: "site-key" });
  try {
    const res = await worker.fetch(new Request(ORIGIN + "/api/config"), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { siteKey: "site-key", development: true });
  } finally { sqlite.close(); }
});
