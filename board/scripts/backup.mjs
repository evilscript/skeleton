#!/usr/bin/env node
// Run manually (npm run backup) with existing Wrangler authentication; never restores remotely.
// Wrangler finds the database by its binding name in wrangler.jsonc, so no database name is written down here.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { boardSettings } from "../cli/config.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const DATABASE = "DB";
export function outsideRepo(path, root = ROOT) {
  if (!isAbsolute(path)) throw new Error("Backup directory must be an absolute path outside the repository.");
  let parent = path;
  while (!existsSync(parent)) parent = dirname(parent);
  const canonical = resolve(realpathSync(parent), relative(parent, path));
  const rel = relative(realpathSync(root), canonical);
  if (rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel)))
    throw new Error("Backup directory must be outside the repository (including symlinks).");
  return canonical;
}
export function expiredBackups(names, date) {
  const cutoff = new Date(date + "T00:00:00Z").getTime() - 13 * 86_400_000;
  return names.filter((name) => /^board-\d{4}-\d{2}-\d{2}\.sql(?:\.json)?$/.test(name)
    && Date.parse(name.slice(6, 16) + "T00:00:00Z") < cutoff);
}
function wrangler(args) {
  const logs = mkdtempSync(join(tmpdir(), "board-backup-log-"));
  try {
    return execFileSync(process.execPath, [WRANGLER, ...args], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(logs, "wrangler.log") },
    });
  } catch (error) { throw new Error(`Wrangler ${args[1]} failed (${error.signal || error.status || "spawn error"}). Existing backups were kept; check authentication/network and retry.`); }
  finally { rmSync(logs, { recursive: true, force: true }); }
}
export function verifyRestore(sqlFile, run = wrangler) {
  const local = mkdtempSync(join(tmpdir(), "board-restore-"));
  try {
    run(["d1", "execute", DATABASE, "--local", "--persist-to", local, "--file", sqlFile, "--yes", "--json"]);
    const files = readdirSync(local, { recursive: true }).filter((file) => String(file).endsWith(".sqlite") && !String(file).endsWith("metadata.sqlite"));
    if (files.length !== 1) throw new Error("Local restore did not produce one database.");
    // D1 forbids PRAGMA integrity_check; inspect the actual restored local
    // SQLite file after Wrangler closes it, with a read-only connection.
    const db = new DatabaseSync(join(local, String(files[0])), { readOnly: true });
    try {
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
        || db.prepare("SELECT COUNT(*) AS bad FROM cards c WHERE c.comment_count <> (SELECT COUNT(*) FROM comments m WHERE m.card_no=c.no)").get()?.bad !== 0)
        throw new Error("Local restore verification failed; no backup retention cleanup was performed.");
      const counts = db.prepare("SELECT (SELECT COUNT(*) FROM cards) AS cards, (SELECT COUNT(*) FROM comments) AS comments, (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM chips) AS chips").get();
      if (!counts || !["cards", "comments", "files", "chips"].every((key) => Number.isInteger(counts[key])))
        throw new Error("Local restore returned unexpected table counts.");
      // New-schema backups also verify incremental statistics and trigger data.
      const hasColumn = (table, column) => Boolean(db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(column));
      const projects = hasColumn("cards", "project_id");
      if (db.prepare(`SELECT COUNT(*) AS bad FROM comments m LEFT JOIN cards c ON c.no=m.card_no
        WHERE c.no IS NULL${projects ? " OR m.project_id <> c.project_id" : ""}`).get()?.bad !== 0)
        throw new Error("Restored comments do not belong to their cards' projects.");
      if (hasColumn("chips", "used")) {
        const projectMatch = projects && hasColumn("chips", "project_id") ? " AND c.project_id=chips.project_id" : "";
        if (db.prepare(`SELECT COUNT(*) AS bad FROM chips WHERE used <> (SELECT COUNT(*) FROM cards c, json_each(c.chips) j
          WHERE c.removed_at IS NULL AND j.value=chips.name${projectMatch})`).get()?.bad !== 0)
          throw new Error("Restored chip counts are inconsistent.");
      }
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='column_counts'").get()) {
        const bad = db.prepare(`SELECT COUNT(*) AS bad FROM column_counts cc WHERE cc.n <> (SELECT COUNT(*) FROM cards c
          WHERE c.removed_at IS NULL AND c.project_id=cc.project_id AND c.col=cc.col)`).get()?.bad;
        const missing = db.prepare(`SELECT COUNT(*) AS bad FROM (SELECT project_id,col FROM cards WHERE removed_at IS NULL
          GROUP BY project_id,col) live LEFT JOIN column_counts cc ON cc.project_id=live.project_id AND cc.col=live.col
          WHERE cc.project_id IS NULL`).get()?.bad;
        if (bad !== 0 || missing !== 0) throw new Error("Restored column counts are inconsistent.");
      }
      return counts;
    } finally { db.close(); }
  } finally { rmSync(local, { recursive: true, force: true }); }
}
export function backup({ directory = process.env.BOARD_BACKUP_DIR || join(boardSettings().stateDir, "backups"), date = new Date().toISOString().slice(0, 10), run = wrangler } = {}) {
  const dest = outsideRepo(directory);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  chmodSync(dest, 0o700);
  const lock = join(dest, ".backup.lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error("Backup is already running, or a stale .backup.lock needs inspection."); }
  const final = join(dest, `board-${date}.sql`), partial = final + ".partial";
  try {
    // A rerun verifies the existing backup; it never replaces that day's copy.
    if (!existsSync(final)) {
      run(["d1", "export", DATABASE, "--remote", "--output", partial]);
      chmodSync(partial, 0o600);
    }
    const source = existsSync(final) ? final : partial;
    chmodSync(source, 0o600);
    const bytes = readFileSync(source);
    if (!bytes.length) throw new Error("Export is empty; existing backups were kept.");
    const counts = verifyRestore(source, run);
    if (source === partial) renameSync(partial, final);
    const manifest = { database: DATABASE, day: date, verifiedAt: new Date().toISOString(), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, localRestore: counts };
    writeFileSync(final + ".json", JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    for (const name of expiredBackups(readdirSync(dest), date)) rmSync(join(dest, name));
    return { file: final, ...manifest };
  } finally { rmSync(partial, { force: true }); rmSync(lock, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(backup(), null, 2)); }
  catch (error) { console.error("backup: " + error.message); process.exitCode = 1; }
}
