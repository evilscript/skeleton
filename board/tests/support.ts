import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import worker from "../src/index.ts";
import { AGENT_NAMES, LIMITED_AGENTS } from "../src/agents.ts";

// The agents come from src/agents.ts, so these tests keep passing after the
// project's own roles replace the placeholders: LEAD and DEV have full rights
// (the same one when only one agent does), OTHER is any second agent, QA is the
// limited one (undefined when no role is limited).
export const FULL = AGENT_NAMES.filter((name) => !LIMITED_AGENTS.includes(name));
export const LEAD = FULL[0], DEV = FULL[1] ?? FULL[0];
export const OTHER = AGENT_NAMES.find((name) => name !== DEV)!;
export const QA = LIMITED_AGENTS[0];
assert.ok(LEAD && AGENT_NAMES.length >= 2, "these tests need at least two agents in src/agents.ts, one with full rights");
export const keyOf = (name: string) => `test-key-${name}-`.repeat(4); // a key is at least 32 characters

export type Env = Parameters<typeof worker.fetch>[1];
// A SESSION_SECRET and an OWNER_PASSWORD for the tests (a password is at least 12 characters).
export const SESSION_SECRET = "test-session-secret-".repeat(3);
export const OWNER_PASSWORD = "a test password, not a real one";

// An in-memory D1 and a Worker environment. `overrides` replaces environment values:
// database({ FILES: undefined }) is a board without file storage, database({ FILES: undefined, FILE_STORAGE: "d1" }) one
// that keeps its files in the database.
export function database(overrides: Record<string, unknown> = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).sort())
    sqlite.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  sqlite.exec("INSERT INTO cards(no,col,title,created_at,updated_at) VALUES (1,'backlog','test','2026-10-03T00:00:00Z','2026-10-03T00:00:00Z')");
  sqlite.exec("INSERT INTO column_counts(project_id,col,n) VALUES (1,'backlog',1)");
  const queries: string[] = [];
  class Statement {
    sql: string;
    values: SQLInputValue[];
    constructor(sql: string, values: SQLInputValue[] = []) { this.sql = sql; this.values = values; queries.push(sql); }
    // D1 binds an ArrayBuffer as a BLOB; node:sqlite wants a typed array.
    bind(...values: unknown[]) { return new Statement(this.sql, values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)) as SQLInputValue[]); }
    rows() {
      const statement = sqlite.prepare(this.sql);
      // D1 bind() accepts positional values for numbered SQLite parameters;
      // node:sqlite treats ?1 as named, so adapt the binding, not the query.
      return /\?\d+/.test(this.sql)
        ? statement.all(Object.fromEntries(this.values.map((value, i) => [`?${i + 1}`, value])))
        : statement.all(...this.values);
    }
    async first(column?: string) {
      const row = this.rows()[0];
      return row ? (column ? row[column] : row) : null;
    }
    async all() { return { results: this.rows(), success: true }; }
    async run() { this.rows(); return { success: true }; }
  }
  const DB = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        // SQLite executes a transaction synchronously; do not interleave a
        // second request while awaiting this in-memory adapter's statements.
        const results = statements.map((statement) => ({ results: statement.rows(), success: true }));
        sqlite.exec("COMMIT"); return results;
      }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const env = {
    DB, AGENT_KEYS: JSON.stringify(Object.fromEntries(AGENT_NAMES.map((name) => [name, keyOf(name)]))),
    OWNER_PASSWORD, SESSION_SECRET, ENVIRONMENT: "development", FILES: {}, SIGN_IN_DELAY_MS: 0, ...overrides,
  } as unknown as Env;
  const request = (path: string, method = "GET", body?: unknown, author = DEV) => worker.fetch(new Request("http://localhost" + path, {
    method, headers: { authorization: "Bearer " + keyOf(author), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), env);
  return { sqlite, DB, request, env, queries };
}

