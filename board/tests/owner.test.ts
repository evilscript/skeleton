import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import worker from "../src/index.ts";
import { FAILED_SIGN_IN_DELAY_MS } from "../src/auth.ts";
import { OWNER_ASSIGNEE } from "../src/agents.ts";
import { database, keyOf, LEAD, OWNER_PASSWORD, SESSION_SECRET, type Env } from "./support.ts";

// The owner signs in with the password they chose (OWNER_PASSWORD) and gets a signed session cookie.
const ORIGIN = "http://localhost";
const signIn = (env: Env, body: unknown, origin = ORIGIN, ip?: string) => worker.fetch(new Request(origin + "/api/session", {
  method: "POST", headers: { origin, "content-type": "application/json", ...(ip ? { "cf-connecting-ip": ip } : {}) }, body: JSON.stringify(body),
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

test("a wrong password is refused; the right one sets the session cookie", async () => {
  const { sqlite, env } = database();
  try {
    // (each from its own address, so the throttling that the later tests cover does not come into it)
    let n = 0;
    const from = () => `192.0.2.${++n}`;
    for (const password of ["wrong", OWNER_PASSWORD.slice(0, -1), OWNER_PASSWORD + "x", "x".repeat(OWNER_PASSWORD.length), OWNER_PASSWORD.toUpperCase()]) {
      const res = await signIn(env, { password }, ORIGIN, from());
      assert.equal(res.status, 403, password);
      assert.deepEqual(await res.json(), { error: "wrong_password" });
      assert.equal(res.headers.get("set-cookie"), null);
    }
    // No password at all, or not text, or the old field, is a malformed request, not a wrong password.
    for (const body of [{}, { password: 12345 }, { password: "" }, { password: "x".repeat(501) }, { key: OWNER_PASSWORD }]) {
      assert.equal((await signIn(env, body)).status, 400, JSON.stringify(body).slice(0, 40));
    }
    // The sign-in has to come from the board's own origin.
    const bad = await worker.fetch(new Request(ORIGIN + "/api/session", {
      method: "POST", headers: { origin: "https://elsewhere.example.test", "content-type": "application/json" }, body: JSON.stringify({ password: OWNER_PASSWORD }),
    }), env);
    assert.equal(bad.status, 403);
    assert.deepEqual(await bad.json(), { error: "invalid_origin" });

    const ok = await signIn(env, { password: OWNER_PASSWORD }, ORIGIN, from());
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { name: OWNER_ASSIGNEE.name });
    const header = ok.headers.get("set-cookie") ?? "";
    assert.match(header, /^session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax"]) assert.ok(header.includes(flag), flag);
    // A password is compared as typed: spaces and a newline around it make it a different password.
    for (const typed of [` ${OWNER_PASSWORD}`, `${OWNER_PASSWORD} `, `${OWNER_PASSWORD}\n`]) assert.equal((await signIn(env, { password: typed }, ORIGIN, from())).status, 403, JSON.stringify(typed));
  } finally { sqlite.close(); }
});

test("a password with spaces or characters outside ASCII works, and 12 characters is the least", async () => {
  // Spaces inside are part of the password; so are characters outside ASCII (written as escapes here).
  for (const password of ["correct horse battery staple", "\u5bc6\u7801".repeat(6), "p\u00e4ssw\u00f6rd-\u00fcber", "\u{1F600}".repeat(12)]) {
    const board = database({ OWNER_PASSWORD: password });
    try {
      assert.equal((await signIn(board.env, { password })).status, 200, password);
      assert.equal((await signIn(board.env, { password: password + "!" })).status, 403, password);
    } finally { board.sqlite.close(); }
  }
});

test("the password is only for signing in; a missing or short OWNER_PASSWORD locks the sign-in out", async () => {
  const { sqlite, env } = database();
  try {
    // It is not an agent key: as a bearer token it opens nothing.
    const bearer = await worker.fetch(new Request(ORIGIN + "/api/me", { headers: { authorization: "Bearer " + OWNER_PASSWORD } }), env);
    assert.equal(bearer.status, 401);
  } finally { sqlite.close(); }
  // Fewer than 12 characters (counted as characters, not bytes), or none at all: nobody gets in, not even with that very value.
  for (const OWNER of [undefined, "", "short", "x".repeat(11), "\u5bc6".repeat(11), "\u{1F600}".repeat(6)]) {
    const board = database({ OWNER_PASSWORD: OWNER });
    try {
      const res = await signIn(board.env, { password: OWNER || "anything at all" });
      assert.equal(res.status, 503, String(OWNER));
      assert.deepEqual(await res.json(), { error: "sign_in_locked" });
      assert.equal(res.headers.get("set-cookie"), null);
      assert.equal(board.sqlite.prepare("SELECT COUNT(*) AS n FROM sign_in_attempts").get()?.n, 0); // a locked-out attempt is not counted
    } finally { board.sqlite.close(); }
  }
  // Exactly 12 is enough.
  const exact = database({ OWNER_PASSWORD: "k".repeat(12) });
  try { assert.equal((await signIn(exact.env, { password: "k".repeat(12) })).status, 200); } finally { exact.sqlite.close(); }
  // Without a SESSION_SECRET no cookie can be signed, so even the right password is refused.
  const bare = database({ SESSION_SECRET: undefined });
  try { assert.equal((await signIn(bare.env, { password: OWNER_PASSWORD })).status, 503); } finally { bare.sqlite.close(); }
});

test("after 5 failed sign-ins from one source, the sign-in answers 429 until the 15 minutes are over", async () => {
  const { sqlite, env } = database();
  try {
    const ip = "198.51.100.7";
    for (let i = 1; i <= 5; i++) assert.equal((await signIn(env, { password: "wrong " + i }, ORIGIN, ip)).status, 403, `attempt ${i}`);
    // The sixth is refused, even with the right password, and says when to come back.
    const locked = await signIn(env, { password: OWNER_PASSWORD }, ORIGIN, ip);
    assert.equal(locked.status, 429);
    assert.deepEqual(await locked.json(), { error: "too_many_attempts" });
    assert.equal(locked.headers.get("set-cookie"), null);
    const wait = Number(locked.headers.get("retry-after"));
    assert.ok(wait > 890 && wait <= 900, `Retry-After ${wait}`);
    assert.equal((await signIn(env, { password: "wrong again" }, ORIGIN, ip)).status, 429);
    // Another source is not affected.
    assert.equal((await signIn(env, { password: "wrong" }, ORIGIN, "198.51.100.8")).status, 403);
    assert.equal((await signIn(env, { password: OWNER_PASSWORD }, ORIGIN, "198.51.100.9")).status, 200);
    // The counter holds a hash, never the address; the window is 15 minutes from the first failure.
    const rows = sqlite.prepare("SELECT key, count, expires_at FROM sign_in_attempts ORDER BY count DESC").all() as { key: string; count: number; expires_at: number }[];
    assert.match(rows[0].key, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(rows).includes("198.51.100"));
    assert.equal(rows[0].count, 7);
    // When the window is over the source may try again, and the count starts from one.
    sqlite.exec("UPDATE sign_in_attempts SET expires_at = expires_at - 901");
    assert.equal((await signIn(env, { password: "wrong" }, ORIGIN, ip)).status, 403);
    assert.equal(sqlite.prepare("SELECT count FROM sign_in_attempts WHERE count = 1 AND expires_at > ?").all(Math.floor(Date.now() / 1000)).length >= 1, true);
    assert.equal((await signIn(env, { password: OWNER_PASSWORD }, ORIGIN, ip)).status, 200);
  } finally { sqlite.close(); }
});

test("a right password clears the count; rows of other sources are removed when their window is over", async () => {
  const { sqlite, env } = database();
  try {
    const ip = "203.0.113.5";
    for (let i = 0; i < 4; i++) assert.equal((await signIn(env, { password: "nope" }, ORIGIN, ip)).status, 403);
    assert.equal((await signIn(env, { password: OWNER_PASSWORD }, ORIGIN, ip)).status, 200);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sign_in_attempts").get()?.n, 0); // cleared
    // So four more failures and a success still work, and the fifth failure is the last one allowed.
    for (let i = 0; i < 4; i++) assert.equal((await signIn(env, { password: "nope" }, ORIGIN, ip)).status, 403);
    assert.equal((await signIn(env, { password: OWNER_PASSWORD }, ORIGIN, ip)).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await signIn(env, { password: "nope" }, ORIGIN, ip)).status, 403);
    assert.equal((await signIn(env, { password: OWNER_PASSWORD }, ORIGIN, ip)).status, 429);
    // An old row of somebody else goes when anyone tries.
    sqlite.exec("INSERT INTO sign_in_attempts(key,count,expires_at) VALUES ('old-source',5,1)");
    assert.equal((await signIn(env, { password: "nope" }, ORIGIN, "203.0.113.6")).status, 403);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sign_in_attempts WHERE key='old-source'").get()?.n, 0);
  } finally { sqlite.close(); }
});

test("attempts that arrive together are counted one by one: only 5 get as far as the password", async () => {
  const { sqlite, env } = database();
  try {
    const ip = "192.0.2.44";
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => signIn(env, { password: "guess " + i }, ORIGIN, ip)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429, 429, 429, 429, 429, 429, 429]);
  } finally { sqlite.close(); }
});

test("a failed sign-in waits a moment before it answers; a right one does not", async () => {
  const { sqlite, env } = database({ SIGN_IN_DELAY_MS: undefined }); // the Worker's own delay, not the tests' zero
  try {
    assert.ok(FAILED_SIGN_IN_DELAY_MS >= 500);
    let started = Date.now();
    assert.equal((await signIn(env, { password: "wrong" })).status, 403);
    assert.ok(Date.now() - started >= FAILED_SIGN_IN_DELAY_MS - 50, "a wrong password was answered at once");
    started = Date.now();
    assert.equal((await signIn(env, { password: OWNER_PASSWORD })).status, 200);
    assert.ok(Date.now() - started < FAILED_SIGN_IN_DELAY_MS, "the right password waited");
  } finally { sqlite.close(); }
});

test("the session cookie makes the caller the owner, as OWNER_ASSIGNEE", async () => {
  const { sqlite, env } = database();
  try {
    const cookie = cookieOf(await signIn(env, { password: OWNER_PASSWORD }));
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
      const foreign = cookieOf(await signIn(other.env, { password: OWNER_PASSWORD }));
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
    // It needs no password and is not counted: a source that is locked out can still use it on localhost.
    const ip = "198.51.100.77";
    for (let i = 0; i < 6; i++) await signIn(env, { password: "nope" }, ORIGIN, ip);
    assert.equal((await signIn(env, { password: OWNER_PASSWORD }, ORIGIN, ip)).status, 429);
    assert.equal((await signIn(env, { dev: true }, ORIGIN, ip)).status, 200);
    // Production, or a real host: `dev` is just a request without a password.
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
