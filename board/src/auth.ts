import { AGENT_NAMES, LIMITED_AGENTS } from "./agents.ts";
// Who is calling: the owner (Google sign-in, then a signed session cookie)
// or an agent (a bearer key per agent). Visitors on /feedback are nobody: they
// can only create a feedback card. The agents are listed in src/agents.ts; a
// key is optional for each of them.
export { AGENT_NAMES };
export type Actor = { kind: "owner"; name: string } | { kind: "agent"; name: string; limited?: boolean };

export interface AuthEnv {
  GOOGLE_CLIENT_ID: string;
  OWNER_EMAILS: string;
  SESSION_SECRET: string;
  AGENT_KEYS: string; // JSON: { "<agent name>": "<key>", ... }, one per agent in src/agents.ts
}

const SESSION_DAYS = 30;
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

export function owners(env: AuthEnv): string[] {
  return env.OWNER_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

// Google's signing keys change every few days; keep them for an hour.
let jwks: { at: number; keys: JsonWebKey[] } | null = null;
async function googleKeys(): Promise<JsonWebKey[]> {
  if (jwks && Date.now() - jwks.at < 3600_000) return jwks.keys;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs", { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("google_keys");
  const body = (await res.json()) as { keys: JsonWebKey[] };
  jwks = { at: Date.now(), keys: body.keys };
  return body.keys;
}

// Verify a Google Identity Services ID token (RS256 JWT) and return the
// owner's email, or null. Only the public client ID is needed.
export async function verifyGoogle(env: AuthEnv, token: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !env.GOOGLE_CLIENT_ID) return null;
  let header: { kid?: string; alg?: string }, claims: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const jwk = (await googleKeys()).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  const now = Date.now() / 1000;
  if (claims.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") return null;
  if (typeof claims.exp !== "number" || claims.exp < now) return null;
  if (claims.email_verified !== true || typeof claims.email !== "string") return null;
  const email = claims.email.toLowerCase();
  return owners(env).includes(email) ? email : null;
}

export async function sessionCookie(env: AuthEnv, email: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const body = b64url(enc.encode(`${email}|${exp}`));
  const sig = await hmac(env.SESSION_SECRET, body);
  return `session=${body}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
export const CLEAR_COOKIE = "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

async function fromCookie(env: AuthEnv, request: Request): Promise<Actor | null> {
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)session=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/);
  if (!m || !env.SESSION_SECRET) return null;
  if (!same(await hmac(env.SESSION_SECRET, m[1]), m[2])) return null;
  const [email, exp] = new TextDecoder().decode(fromB64url(m[1])).split("|");
  if (Number(exp) < Date.now() / 1000 || !owners(env).includes(email)) return null;
  return { kind: "owner", name: email };
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
    if (keys[name] && keys[name].length >= 32 && same(keys[name], m[1])) return { kind: "agent", name, limited: LIMITED_AGENTS.includes(name) };
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

export function actorName(a: Actor): string {
  return a.kind === "owner" ? "owner" : a.name;
}
