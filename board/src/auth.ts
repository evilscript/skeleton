import { AGENT_NAMES, LIMITED_AGENTS, OWNER_ASSIGNEE } from "./agents.ts";
// Who is calling: the owner (the owner's password, exchanged once for a signed
// session cookie) or an agent (a bearer key per agent). Anyone else is nobody and
// can read nothing. The agents are listed in src/agents.ts; a key is optional for
// each of them. The owner is always OWNER_ASSIGNEE from the same file.
export { AGENT_NAMES };
export type Actor = { kind: "owner"; name: string } | { kind: "agent"; name: string; limited?: boolean };

export interface AuthEnv {
  OWNER_PASSWORD: string; // the password the owner chose, at least MIN_PASSWORD characters (a Worker secret)
  SESSION_SECRET: string;
  AGENT_KEYS: string; // JSON: { "<agent name>": "<key>", ... }, one per agent in src/agents.ts
}

const SESSION_DAYS = 30;
const MIN_KEY = 32;
export const MIN_PASSWORD = 12;
export const FAILED_SIGN_IN_DELAY_MS = 600; // a wrong password waits this long before it is answered (src/index.ts signIn)
const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// Constant-time string comparison for keys and signatures.
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}

// Can anyone sign in at all? The password is a Worker secret of at least MIN_PASSWORD
// characters; one that is missing or shorter locks the sign-in out (a typo in the
// secret must never leave a weak door open).
export function passwordIsSet(env: AuthEnv): boolean {
  return typeof env.OWNER_PASSWORD === "string" && Array.from(env.OWNER_PASSWORD).length >= MIN_PASSWORD;
}
// Is this the owner's password? Compared exactly (no trimming). Both sides are hashed
// first, so the comparison takes the same time whatever was typed and the password's
// length is not revealed.
export async function isOwnerPassword(env: AuthEnv, given: string): Promise<boolean> {
  if (!passwordIsSet(env)) return false;
  const [a, b] = await Promise.all([given, env.OWNER_PASSWORD].map(async (k) => b64url(await crypto.subtle.digest("SHA-256", enc.encode(k)))));
  return same(a, b);
}

// The session cookie says "this browser is the owner": the owner's name from
// src/agents.ts and an expiry, signed with SESSION_SECRET.
export async function sessionCookie(env: AuthEnv): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const body = b64url(enc.encode(`${OWNER_ASSIGNEE.name}|${exp}`));
  const sig = await hmac(env.SESSION_SECRET, body);
  return `session=${body}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
export const CLEAR_COOKIE = "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

async function fromCookie(env: AuthEnv, request: Request): Promise<Actor | null> {
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)session=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/);
  if (!m || !env.SESSION_SECRET) return null;
  if (!same(await hmac(env.SESSION_SECRET, m[1]), m[2])) return null;
  const [name, exp] = new TextDecoder().decode(fromB64url(m[1])).split("|");
  if (!(Number(exp) >= Date.now() / 1000) || name !== OWNER_ASSIGNEE.name) return null;
  return { kind: "owner", name: OWNER_ASSIGNEE.name };
}

function fromKey(env: AuthEnv, request: Request): Actor | null {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(\S+)$/);
  if (!m || !env.AGENT_KEYS) return null;
  let keys: Record<string, string>;
  try {
    keys = JSON.parse(env.AGENT_KEYS);
  } catch {
    return null;
  }
  for (const name of AGENT_NAMES) {
    if (keys[name] && keys[name].length >= MIN_KEY && same(keys[name], m[1])) return { kind: "agent", name, limited: LIMITED_AGENTS.includes(name) };
  }
  return null;
}

// Cookie sessions also need the page's own header on writes, so another
// site can't make the owner's browser change cards (CSRF).
export async function actorOf(env: AuthEnv, request: Request): Promise<Actor | null> {
  const agent = fromKey(env, request);
  if (agent) return agent;
  const owner = await fromCookie(env, request);
  if (!owner) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const url = new URL(request.url);
    if (request.headers.get("origin") !== url.origin || request.headers.get("x-board") !== "1") return null;
  }
  return owner;
}

// The name written on comments, activity and updates: the owner's is OWNER_ASSIGNEE.name.
export function actorName(a: Actor): string {
  return a.name;
}
