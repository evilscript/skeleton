import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import worker from "../src/index.ts";
import { OWNER_ASSIGNEE } from "../src/agents.ts";
import { database, keyOf, LEAD, ownerCookie, ownerLink, SESSION_SECRET, type Env } from "./support.ts";

// The owner has no password: a one-time link (a row in owner_links, made by scripts/owner-link.sh) is exchanged for a signed session cookie.
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

test("a sign-in link works once and sets the session cookie; a wrong one is refused", async () => {
  const { sqlite, env } = database();
  try {
    // No link at all, or not text, or the wrong shape, or the old password field, is a malformed request, not a wrong link.
    for (const body of [{}, { link: 12345 }, { link: "" }, { link: "short" }, { link: "x".repeat(129) }, { link: "has spaces in it " + "x".repeat(30) }, { password: "a test password, not a real one" }]) {
      assert.equal((await signIn(env, body)).status, 400, JSON.stringify(body).slice(0, 40));
    }
    // A well-formed token nobody made is refused, and sets no cookie.
    const wrong = await signIn(env, { link: "A".repeat(43) });
    assert.equal(wrong.status, 403);
    assert.deepEqual(await wrong.json(), { error: "link_invalid" });
    assert.equal(wrong.headers.get("set-cookie"), null);

    // The sign-in has to come from the board's own origin, and a refused one does not use the link up.
    const token = ownerLink(sqlite);
    const elsewhere = await worker.fetch(new Request(ORIGIN + "/api/session", {
      method: "POST", headers: { origin: "https://elsewhere.example.test", "content-type": "application/json" }, body: JSON.stringify({ link: token }),
    }), env);
    assert.equal(elsewhere.status, 403);
    assert.deepEqual(await elsewhere.json(), { error: "invalid_origin" });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM owner_links").get()?.n, 1);

    const ok = await signIn(env, { link: token });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { name: OWNER_ASSIGNEE.name });
    const header = ok.headers.get("set-cookie") ?? "";
    assert.match(header, /^session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax"]) assert.ok(header.includes(flag), flag);

    // The link is used up: the same one again is refused, and its row is gone.
    const again = await signIn(env, { link: token });
    assert.equal(again.status, 403);
    assert.deepEqual(await again.json(), { error: "link_invalid" });
    assert.equal(again.headers.get("set-cookie"), null);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM owner_links").get()?.n, 0);
  } finally { sqlite.close(); }
});

test("a link older than its 15 minutes is refused, and expired rows are cleared when anyone tries", async () => {
  const { sqlite, env } = database();
  try {
    const old = ownerLink(sqlite, -1);
    const stale = ownerLink(sqlite, -3600);
    const fresh = ownerLink(sqlite, 60);
    const res = await signIn(env, { link: old });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "link_invalid" });
    assert.equal(res.headers.get("set-cookie"), null);
    // Every attempt sweeps the expired rows (the stale one went too); the fresh one stays and still works.
    const left = sqlite.prepare("SELECT COUNT(*) AS n FROM owner_links").get()?.n;
    assert.equal(left, 1);
    assert.equal((await signIn(env, { link: stale })).status, 403);
    assert.equal((await signIn(env, { link: fresh })).status, 200);
  } finally { sqlite.close(); }
});

test("only the hash of a link is stored, and requests that arrive together cannot all use the same link", async () => {
  const { sqlite, env } = database();
  try {
    const token = ownerLink(sqlite);
    const rows = sqlite.prepare("SELECT hash, expires_at FROM owner_links").all() as { hash: string; expires_at: number }[];
    assert.equal(rows.length, 1);
    assert.match(rows[0].hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(rows).includes(token));
    const left = rows[0].expires_at - Math.floor(Date.now() / 1000);
    assert.ok(left > 890 && left <= 900, `${left} seconds`);
    // Twelve requests with the one link: exactly one gets in.
    const results = await Promise.all(Array.from({ length: 12 }, () => signIn(env, { link: token })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, ...Array(11).fill(403)]);
  } finally { sqlite.close(); }
});

test("a link is not an agent key and a key is not a link; without a SESSION_SECRET nobody can sign in and the link is kept", async () => {
  const { sqlite, env } = database();
  try {
    // The token as a bearer token opens nothing.
    const token = ownerLink(sqlite);
    const bearer = await worker.fetch(new Request(ORIGIN + "/api/me", { headers: { authorization: "Bearer " + token } }), env);
    assert.equal(bearer.status, 401);
    // An agent's key, offered as a link, gets nobody a cookie.
    const asLink = await signIn(env, { link: keyOf(LEAD) });
    assert.notEqual(asLink.status, 200);
    assert.equal(asLink.headers.get("set-cookie"), null);
  } finally { sqlite.close(); }
  // Without a SESSION_SECRET no cookie can be signed: the sign-in is switched off, and the link is not spent on it.
  const bare = database({ SESSION_SECRET: undefined });
  try {
    const token = ownerLink(bare.sqlite);
    const res = await signIn(bare.env, { link: token });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "sign_in_locked" });
    assert.equal(res.headers.get("set-cookie"), null);
    assert.equal(bare.sqlite.prepare("SELECT COUNT(*) AS n FROM owner_links").get()?.n, 1);
  } finally { bare.sqlite.close(); }
});

test("the password tables and setting are gone: no OWNER_PASSWORD, no sign-in counter", async () => {
  const { sqlite, env } = database({ OWNER_PASSWORD: "a leftover secret from an old deployment" });
  try {
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sign_in_attempts'").get()?.n, 0);
    // A Worker that still has the old secret set ignores it: a password gets nobody in.
    const res = await signIn(env, { password: "a leftover secret from an old deployment" });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("set-cookie"), null);
  } finally { sqlite.close(); }
});

test("the session cookie makes the caller the owner, as OWNER_ASSIGNEE", async () => {
  const { sqlite, env } = database();
  try {
    const cookie = await ownerCookie(sqlite, env);
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
      const foreign = await ownerCookie(other.sqlite, other.env);
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

test("the development sign-in works only on localhost with ENVIRONMENT=development", async () => {
  const { sqlite, env } = database();
  try {
    const dev = await signIn(env, { dev: true });
    assert.equal(dev.status, 200);
    assert.deepEqual(await dev.json(), { name: OWNER_ASSIGNEE.name });
    assert.equal((await page(env, cookieOf(dev), "/api/me")).status, 200);
    // Production, or a real host: `dev` is just a request without a link.
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

test("the public config says only whether this is local development", async () => {
  const { sqlite, env } = database();
  try {
    const res = await worker.fetch(new Request(ORIGIN + "/api/config"), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { development: true });
    const production = await worker.fetch(new Request("https://board.example.test/api/config"), env);
    assert.deepEqual(await production.json(), { development: false });
  } finally { sqlite.close(); }
});

// ---------------------------------------------------------------- who may use the page without signing in (BOARD_ACCESS)

const fetchAs = (env: Env, path: string, method = "GET", extra: Record<string, string> = {}, body?: unknown) => worker.fetch(new Request(ORIGIN + path, {
  method, headers: { "content-type": "application/json", ...extra }, ...(body ? { body: JSON.stringify(body) } : {}),
}), env);
const pageHeaders = { origin: ORIGIN, "x-board": "1" }; // what the board page itself sends with a write

test("private is the Worker's own default: no cookie, no key, nothing; a missing or misspelt BOARD_ACCESS is private too", async () => {
  for (const BOARD_ACCESS of [undefined, "", "private", "Open", "everyone", "OPEN "]) {
    const { sqlite, env } = database({ BOARD_ACCESS });
    try {
      assert.equal((await fetchAs(env, "/api/me")).status, 401, String(BOARD_ACCESS));
      assert.equal((await fetchAs(env, "/api/cards")).status, 401);
      assert.equal((await fetchAs(env, "/api/cards", "POST", pageHeaders, { title: "x" })).status, 401);
      assert.equal(((await (await fetchAs(env, "/api/info")).json()) as { access: string }).access, "private");
    } finally { sqlite.close(); }
  }
});

test("view: anybody reads without signing in and is a visitor; only the owner and the agents write", async () => {
  const { sqlite, env } = database({ BOARD_ACCESS: "view" });
  try {
    const me = await fetchAs(env, "/api/me");
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { actor: "viewer", name: "visitor" });
    for (const path of ["/api/cards", "/api/cards/1", "/api/cards/1/comments", "/api/agents", "/api/version", "/api/projects", "/api/activity", "/api/chips"]) {
      assert.equal((await fetchAs(env, path)).status, 200, path);
    }
    assert.equal(((await (await fetchAs(env, "/api/info")).json()) as { access: string }).access, "view");
    // A visitor changes nothing, with or without the page's own headers.
    for (const headers of [{}, pageHeaders]) {
      assert.equal((await fetchAs(env, "/api/cards", "POST", headers, { title: "from a visitor" })).status, 401);
      assert.equal((await fetchAs(env, "/api/cards/1", "PATCH", headers, { title: "changed" })).status, 401);
      assert.equal((await fetchAs(env, "/api/cards/1", "DELETE", headers)).status, 401);
      assert.equal((await fetchAs(env, "/api/cards/1/comments", "POST", headers, { body: "hi", to: LEAD })).status, 401);
      assert.equal((await fetchAs(env, "/api/projects", "POST", headers, { name: "Another" })).status, 401);
    }
    assert.equal(sqlite.prepare("SELECT title FROM cards WHERE no = 1").get()?.title, "test");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM cards").get()?.n, 1);
    // The owner (a sign-in link) and an agent (a key) still write.
    const cookie = await ownerCookie(sqlite, env);
    assert.equal((await fetchAs(env, "/api/me", "GET", { cookie })).status, 200);
    assert.equal((await fetchAs(env, "/api/cards", "POST", { cookie, ...pageHeaders }, { title: "from the owner" })).status, 201);
    assert.equal((await fetchAs(env, "/api/cards", "POST", { authorization: "Bearer " + keyOf(LEAD) }, { title: "from an agent" })).status, 201);
    // A wrong key is a 401, not a visitor: a broken credential must show up.
    assert.equal((await fetchAs(env, "/api/cards", "GET", { authorization: "Bearer " + "wrong-key-".repeat(5) })).status, 401);
  } finally { sqlite.close(); }
});

test("open: nobody signs in; anybody is the owner, and a write still needs the page's own origin and header", async () => {
  const { sqlite, env } = database({ BOARD_ACCESS: "open" });
  try {
    const me = await fetchAs(env, "/api/me");
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { actor: "owner", name: OWNER_ASSIGNEE.name });
    assert.equal(((await (await fetchAs(env, "/api/info")).json()) as { access: string }).access, "open");
    // Another site cannot make a browser change cards: without the page's own origin and header a write is refused.
    assert.equal((await fetchAs(env, "/api/cards", "POST", {}, { title: "blind" })).status, 401);
    assert.equal((await fetchAs(env, "/api/cards", "POST", { origin: "https://elsewhere.example.test", "x-board": "1" }, { title: "elsewhere" })).status, 401);
    const made = await fetchAs(env, "/api/cards", "POST", pageHeaders, { title: "made on an open board" });
    assert.equal(made.status, 201);
    const no = ((await made.json()) as { no: number }).no;
    assert.equal(sqlite.prepare("SELECT updated_by FROM cards WHERE no=?").get(no)?.updated_by, OWNER_ASSIGNEE.name);
    // The owner's powers are open too, purging a card included.
    assert.equal((await fetchAs(env, `/api/cards/${no}`, "DELETE", pageHeaders)).status, 200);
    assert.equal((await fetchAs(env, `/api/cards/${no}?purge=1`, "DELETE", pageHeaders)).status, 200);
    // A wrong key is still a 401; a right one is still an agent, not the owner.
    assert.equal((await fetchAs(env, "/api/cards", "GET", { authorization: "Bearer " + "wrong-key-".repeat(5) })).status, 401);
    const agent = await fetchAs(env, "/api/me", "GET", { authorization: "Bearer " + keyOf(LEAD) });
    assert.deepEqual(await agent.json(), { actor: "agent", name: LEAD });
  } finally { sqlite.close(); }
});
