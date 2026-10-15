import { AGENT_NAMES, LIMITED_AGENTS, OWNER_ASSIGNEE } from "./agents.ts";
// Who is calling: the owner (a one-time sign-in link, exchanged once for a signed
// session cookie) or an agent (a bearer key per agent). Anyone else is nobody and
// can read nothing. The agents are listed in src/agents.ts; a key is optional for
// each of them. The owner is always OWNER_ASSIGNEE from the same file. The owner has
// no password: `npm run owner-link` (scripts/owner-link.sh) stores the hash of a random
// token in the database and opens the link in the owner's browser; the page sends the
// token once (src/index.ts signIn) and it is used up.
export { AGENT_NAMES };
export type Actor = { kind: "owner"; name: string } | { kind: "agent"; name: string; limited?: boolean } | { kind: "viewer"; name: string };

export interface AuthEnv {
  SESSION_SECRET: string; // signs the owner's session cookie (a Worker secret)
  BOARD_ACCESS?: string; // who may use the page without signing in: "open" (anybody is the owner), "view" (anybody reads) or "private" (nobody)
  AGENT_KEYS: string; // JSON: { "<agent name>": "<key>", ... }, one per agent in src/agents.ts
}

const SESSION_DAYS = 30;
const MIN_KEY = 32;
export const LINK_MINUTES = 15; // how long a sign-in link can be used (scripts/owner-link.sh writes the same number into the database)
export const LINK_PATTERN = /^[A-Za-z0-9_-]{32,128}$/; // what a sign-in link's token looks like (scripts/owner-link.sh makes 43 characters)
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

// The hash a sign-in link is stored under: SHA-256 of its token, in hex (the token itself is never stored).
export async function linkHash(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(token));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
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

// Who may use the page without signing in (the Worker variable BOARD_ACCESS, board.access in skeleton.config.json):
//   open     anybody who has the address is the owner: no sign-in at all (the kit's default: the simplest start; a prototype or a demo)
//   view     anybody can READ the board; changing it needs the owner's sign-in link or an agent's key
//   private  nobody: every request needs the owner's cookie (a sign-in link) or an agent's key
// A missing or misspelt value is private: a typo must never open a board. The Worker's own default is private; the kit's
// configuration (board.access) sets the variable, so a board made from the kit starts open and the team locks it down when it wants to.
export type Access = "open" | "view" | "private";
export function accessMode(env: AuthEnv): Access {
  return env.BOARD_ACCESS === "open" || env.BOARD_ACCESS === "view" ? env.BOARD_ACCESS : "private";
}
export const VISITOR: Actor = { kind: "viewer", name: "visitor" };

// Cookie sessions (and the open mode) also need the page's own origin and header on writes, so another
// site can't make the owner's browser change cards (CSRF).
export async function actorOf(env: AuthEnv, request: Request): Promise<Actor | null> {
  // A request that brings a key is an agent or nobody: a wrong key never falls back to a visitor or the open owner, so a broken
  // credential shows up as a 401 instead of silently working with fewer rights.
  if (/^Bearer\s/i.test(request.headers.get("authorization") || "")) return fromKey(env, request);
  const mode = accessMode(env);
  const owner = (await fromCookie(env, request)) ?? (mode === "open" ? ({ kind: "owner", name: OWNER_ASSIGNEE.name } as Actor) : null);
  const read = request.method === "GET" || request.method === "HEAD";
  if (!owner) return read && mode === "view" ? VISITOR : null;
  if (!read) {
    const url = new URL(request.url);
    if (request.headers.get("origin") !== url.origin || request.headers.get("x-board") !== "1") return null;
  }
  return owner;
}

// The name written on comments, activity and updates: the owner's is OWNER_ASSIGNEE.name.
export function actorName(a: Actor): string {
  return a.name;
}
