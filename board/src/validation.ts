import { AGENT_NAMES, OWNER_ASSIGNEE } from "./agents.ts";
import { commentBodyError } from "../public/board/comment-rules.js";
export { MAX_COMMENT_BYTES, COMMENTS_PER_HOUR } from "../public/board/comment-rules.js";

export const MAX_IMAGES = 6;
export const MAX_FILE = 4 * 1024 * 1024;
export const MAX_BODY = 25 * 1024 * 1024;
export class InputError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function textField(
  form: FormData,
  name: string,
  min: number,
  max: number,
): string {
  const value = form.get(name);
  if (value !== null && typeof value !== "string")
    throw new InputError("invalid_fields");
  const text = (value || "").trim();
  if (text.length < min || text.length > max)
    throw new InputError("invalid_fields");
  return text;
}
export function fields(form: FormData) {
  const requestId = textField(form, "requestId", 36, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requestId,
    )
  )
    throw new InputError("invalid_fields");
  // Everything the visitor writes is optional: the page only asks for at least
  // one thing, see hasContent. An old page's "kind" is ignored.
  return {
    requestId,
    title: textField(form, "title", 0, 120),
    description: textField(form, "description", 0, 6000),
    report: textField(form, "report", 0, 80000),
    contact: textField(form, "contact", 0, 200),
    locale: "en", // the pages are English only; the database column stays
    token: textField(form, "cf-turnstile-response", 0, 2048),
  };
}
type Written = { title: string; description: string; report: string; contact: string; locale: string };
// At least one of the optional things must be there to submit.
export function hasContent(data: Written, imageCount: number): boolean {
  return Boolean(data.title || data.description || data.report || data.contact || imageCount > 0);
}
// The card's title: the visitor's own, else the first line of the
// description, else what the card holds.
export function cardTitle(data: Written, imageCount: number): string {
  if (data.title) return data.title;
  const line = data.description.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (line) return line.length > 80 ? line.slice(0, 79) + "…" : line;
  if (data.report) return "(diagnostics only)";
  if (imageCount > 0) return `(screenshots only, ${imageCount})`;
  return "(contact only)";
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
export async function boundedForm(request: Request): Promise<FormData> {
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data;"))
    throw new InputError("invalid_fields");
  if (Number(request.headers.get("content-length")) > MAX_BODY)
    throw new InputError("too_large", 413);
  if (!request.body) throw new InputError("invalid_fields");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY) {
      await reader.cancel();
      throw new InputError("too_large", 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(body, {
      headers: { "content-type": request.headers.get("content-type")! },
    }).formData();
  } catch {
    throw new InputError("invalid_fields");
  }
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
