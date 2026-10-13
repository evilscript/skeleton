// Where the bytes of screenshots and attachments live. The FILE_STORAGE variable
// says which:
//   "r2"    an object in the FILES R2 bucket, under the file's id (Cloudflare asks for a payment card before R2 can be used)
//   "d1"    a row in file_blobs (migration 0014), in the same database as the cards: no extra service and no card, but a row,
//           the bytes included, must stay under D1's 2 MB limit, so one file is capped at D1_MAX_FILE
//   "none"  no file storage (the default)
// A Worker that has the FILES binding and no FILE_STORAGE variable is an old deployment and keeps using R2.
// The rest of the Worker asks fileStore(env) and never branches on the mode: put, get and drop are the same calls in both.
import { InputError } from "./validation.ts";

export const MAX_ATTACHMENT = 25 * 1024 * 1024; // r2: one attachment
export const D1_MAX_FILE = Math.floor(1.5 * 1024 * 1024); // d1: one file, below the 2 MB row limit with room for the row itself

export type FileMode = "none" | "d1" | "r2";
export interface StorageEnv {
  DB: D1Database;
  FILES?: R2Bucket; // the R2 binding; absent without a bucket
  FILE_STORAGE?: string; // "none" | "d1" | "r2" (wrangler.jsonc vars)
}

export interface FileStore {
  mode: "d1" | "r2";
  maxBytes: number; // the largest single file
  put(id: string, bytes: Uint8Array, type: string): Promise<void>;
  get(id: string): Promise<BodyInit | null>;
  drop(ids: string[]): Promise<void>; // best effort: a failure leaves unreachable bytes, never a broken board
}

export function fileMode(env: StorageEnv): FileMode {
  const set = (env.FILE_STORAGE ?? "").trim().toLowerCase();
  if (set === "") return env.FILES ? "r2" : "none";
  if (set === "d1") return "d1";
  if (set === "r2" && env.FILES) return "r2";
  return "none"; // "none", an unknown word, or "r2" without a bucket to put anything in
}

// What D1 hands back for a BLOB depends on the binding's version: an ArrayBuffer, a typed array or a plain array of numbers.
export function bytesOf(value: unknown): Uint8Array {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") return new Uint8Array(value as ArrayBuffer);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error("unreadable file bytes");
}
// D1 binds an ArrayBuffer as a BLOB.
const bufferOf = (bytes: Uint8Array): ArrayBuffer =>
  (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;

function r2Store(bucket: R2Bucket): FileStore {
  return {
    mode: "r2",
    maxBytes: MAX_ATTACHMENT,
    async put(id, bytes, type) { await bucket.put(id, bytes, { httpMetadata: { contentType: type } }); },
    async get(id) { return (await bucket.get(id))?.body ?? null; },
    async drop(ids) { await bucket.delete(ids).catch(() => {}); },
  };
}

function d1Store(db: D1Database): FileStore {
  return {
    mode: "d1",
    maxBytes: D1_MAX_FILE,
    async put(id, bytes) { await db.prepare("INSERT INTO file_blobs(id, data) VALUES (?, ?)").bind(id, bufferOf(bytes)).run(); },
    async get(id) {
      const row = await db.prepare("SELECT data FROM file_blobs WHERE id = ?").bind(id).first<{ data: unknown }>();
      return row ? bytesOf(row.data) : null;
    },
    async drop(ids) {
      // A statement takes 100 bound values at most.
      const batches: D1PreparedStatement[] = [];
      for (let i = 0; i < ids.length; i += 50) {
        const part = ids.slice(i, i + 50);
        batches.push(db.prepare(`DELETE FROM file_blobs WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part));
      }
      if (batches.length) await db.batch(batches).catch(() => {});
    },
  };
}

// null: this board has no file storage.
export function fileStore(env: StorageEnv): FileStore | null {
  const mode = fileMode(env);
  if (mode === "r2") return r2Store(env.FILES!);
  if (mode === "d1") return d1Store(env.DB);
  return null;
}
export function requireStore(env: StorageEnv): FileStore {
  const store = fileStore(env);
  if (!store) throw new InputError("files_disabled", 501);
  return store;
}
// Best-effort cleanup of stored bytes; nothing to do without storage.
export async function dropObjects(env: StorageEnv, ids: string | string[]): Promise<void> {
  await fileStore(env)?.drop([ids].flat());
}
