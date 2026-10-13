import { AGENT_NAMES, OWNER_ASSIGNEE } from "./agents.ts";
import { commentBodyError } from "../public/board/comment-rules.js";
export { MAX_COMMENT_BYTES, COMMENTS_PER_HOUR } from "../public/board/comment-rules.js";

export class InputError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
// The language of the pages (the BOARD_LANGUAGE variable): a code like en or zh-CN, which names the pack
// public/i18n/<code>.json. Anything that is not such a code, or nothing, is English.
export const DEFAULT_LANGUAGE = "en";
export function pageLanguage(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(value.trim()) ? value.trim() : DEFAULT_LANGUAGE;
}
export function imageExtension(type: string, bytes: Uint8Array): string {
  const b = bytes;
  if (
    type === "image/png" &&
    b.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v)
  )
    return "png";
  if (
    type === "image/jpeg" &&
    b.length >= 3 &&
    b[0] === 255 &&
    b[1] === 216 &&
    b[2] === 255
  )
    return "jpg";
  if (
    type === "image/webp" &&
    b.length >= 12 &&
    String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.slice(8, 12)) === "WEBP"
  )
    return "webp";
  throw new InputError("invalid_image");
}

// Projects. A project's key (slug) is what URLs, the CLI and the page use; it
// never changes. "all" is taken: comment listings use it for every project.
// The default project (id 1) is created by the first migrations; rename it with
// `board projects rename main "Project Name"`.
export const DEFAULT_PROJECT = "main";
export const MAX_PROJECTS = 50;
const RESERVED_KEYS = ["all"];
export function projectKey(v: unknown): string {
  if (typeof v !== "string") throw new InputError("invalid_key");
  const k = v.trim().toLowerCase();
  if (k.length < 1 || k.length > 30 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(k) || RESERVED_KEYS.includes(k)) throw new InputError("invalid_key");
  return k;
}
export function projectName(v: unknown): string {
  if (typeof v !== "string") throw new InputError("invalid_name");
  const n = v.trim();
  if (n.length < 1 || n.length > 60) throw new InputError("invalid_name");
  return n;
}
// A key from the name when none is given: "My App 2" -> "my-app-2". A name
// with no latin letters or digits needs a key of its own.
export function keyFromName(name: string): string {
  return projectKey(name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, ""));
}

// Who works on a card: the agents (src/agents.ts) and the owner. The cards
// table has no CHECK on it any more (migration 0012), so a new developer needs no
// migration: this list is the whole rule.
export const ASSIGNEES: readonly string[] = [...AGENT_NAMES, OWNER_ASSIGNEE.name];
export function assigneeValue(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !ASSIGNEES.includes(v)) throw new InputError("invalid_assignee");
  return v;
}
// A card's priority, lowest first; null is none.
export const PRIORITIES = ["minor", "major", "critical", "blocker"] as const;
export function priorityValue(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !(PRIORITIES as readonly string[]).includes(v)) throw new InputError("invalid_priority");
  return v;
}

// Comments.
export const COMMENT_TYPES = ["note", "assign", "started", "blocked", "question", "review", "merged", "decision"] as const;
// "owner" always addresses the owner, whatever the owner's assignee name is.
export const COMMENT_TARGETS: readonly string[] = [...new Set(["owner", OWNER_ASSIGNEE.name, ...AGENT_NAMES])];
export function commentFields(b: Record<string, unknown>) {
  if (typeof b.body !== "string") throw new InputError("invalid_fields");
  const body = b.body.trim();
  if (!body) throw new InputError("invalid_fields");
  if (commentBodyError(body)) throw new InputError("comment_too_long", 413);
  const type = b.type === undefined || b.type === null || b.type === "" ? "note" : b.type;
  if (typeof type !== "string" || !(COMMENT_TYPES as readonly string[]).includes(type)) throw new InputError("invalid_type");
  let to: string | null = null;
  if (b.to !== undefined && b.to !== null && b.to !== "") {
    if (typeof b.to !== "string" || !COMMENT_TARGETS.includes(b.to)) throw new InputError("invalid_to");
    to = b.to;
  }
  let ref = "";
  if (b.ref !== undefined && b.ref !== null && b.ref !== "") {
    // Links only: the page turns a ref into a link, so no javascript: and the like.
    if (typeof b.ref !== "string" || b.ref.length > 500 || !/^https?:\/\/\S+$/.test(b.ref.trim())) throw new InputError("invalid_ref");
    ref = b.ref.trim();
  }
  return { body, type, to, ref };
}
