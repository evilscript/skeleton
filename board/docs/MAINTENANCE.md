# Board quotas, usage and backups

## Credentials

`npm run setup:secrets` (run by the Owner, in their own terminal) sets three secrets and never prints them:

| Secret | What it is for | Where a copy is kept |
|---|---|---|
| `OWNER_PASSWORD` | the Owner's sign-in on the board page: the password the Owner chose, at least 12 characters, compared exactly and in constant time (both sides hashed first) | nowhere: the Owner knows it. It is asked at a hidden prompt, typed twice, and goes to Wrangler on its standard input only |
| `SESSION_SECRET` | signs the session cookie the page gets after a right password (30 days) and hashes the sign-in throttle's source | none (not needed again) |
| `AGENT_KEYS` | one key per agent in `src/agents.ts` | Keychain or key file, account = the agent's board name |

A missing `OWNER_PASSWORD`, or one shorter than 12 characters, locks the sign-in out (`503 sign_in_locked`): fix the secret, do not
lower the rule.

**A lost password is replaced, not recovered** (a Worker secret cannot be read back from Cloudflare, and nothing here stores it):
`npm run setup:secrets -- --password-only` asks for a new one and makes a new `SESSION_SECRET`, so every signed-in browser has to sign in
again; the agent keys are not touched. `-- --keys-only` renews the agent keys and nothing else (every agent's key has to be placed again,
a cloud session's credential too). With no option the script does both. `scripts/add-agent.sh <name>` adds one agent without touching the
others. An agent never reads, prints or copies the password and never runs the script.

## Sign-in throttle

A person's password can be guessed, so the Worker allows **5 failed sign-ins per source in 15 minutes**, then answers `429 too_many_attempts`
with `Retry-After` until the window (counted from the first failure) is over. The source is the client address hashed with `SESSION_SECRET`;
the table `sign_in_attempts` (migration `0015`) holds that hash, a count and the end of the window, never the address. A right password
deletes the row, and expired rows are deleted by the next attempt. A failed attempt also waits 600 ms before it is answered (the optional
Worker variable `SIGN_IN_DELAY_MS` changes that; the tests set it to 0). Someone locked
out by mistake waits for the window to end, or the Owner clears it: `npx wrangler d1 execute DB --remote --command "DELETE FROM sign_in_attempts"`.
The development sign-in on `localhost` is not counted.

## Comment quota

Comments are limited to **60 successful posts per author per UTC clock hour** (across all cards and projects) and **4096 UTF-8 bytes after
trimming** per stored body. The Worker, the browser and the CLI share the size rule and its error messages (`public/board/comment-rules.js`);
long content belongs in a link. A 429 response includes `Retry-After` until the next UTC hour. A database trigger checks and charges the
quota in the comment insert transaction, so rejected or rolled-back writes do not consume it. The browser ignores a second Send while the
first request is pending. Separate completed POST requests are separate comments, even with equal text.

The quota counters live in their own table (`comment_limits`, migration `0008`), separate from the older reservation table, so a Worker
deployed before the migration and one deployed after it never double-charge the same row. The card comment counter stays in the Worker's
atomic insert/update batch; the trigger updates only the quota counter.

## Stored counts

Chip `used` counts are maintained transactionally by triggers on card creation, chip edits, removal, restoration and purge. Renaming a chip
resets the renamed chip's counter through a name-update trigger before its cards are rewritten in the same transaction. A rename performs a
one-time scan for the destination name within the same project; ordinary statistics reads and comment writes never scan cards for chip
counts. `GET /api/chips` reads only the selected project's chip rows, with no card/JSON scan and no stale cache. Cards with equal chip names
in different projects have independent counts; renaming a chip never changes another project's cards. The Worker also maintains
`column_counts` on each card write without recounting the cards.

When a migration rebuilds the cards table it must drop and recreate these triggers (see `0009`, `0010`, `0012`, `0013`), and a migration
must not use `CASE ... END` inside a trigger body: D1's remote parser takes the `END` for the end of the trigger (use `SELECT ... WHERE`).

## Today's use

```bash
node cli/board.mjs usage
node cli/board.mjs usage --json
```

This uses the existing **Wrangler authentication**, not a board key. It requests up to 10,000 query groups from `wrangler d1 insights`
(the database is found by its binding name `DB` in `wrangler.jsonc`), selects **today's UTC hourly buckets** and sums `totalRowsRead` and
`totalRowsWritten`. Wrangler's default five-query output and rolling `1d` window would give a misleading total, so neither is used. The
output labels truncated results as a lower bound and notes analytics sampling and lag. Authentication or format failures report
"unavailable", never zero. Only this database is counted; the free daily allowance (5,000,000 reads and 100,000 writes, reset 00:00 UTC)
is **shared across the Cloudflare account**.

Read budget example (an estimate, not a billing measurement): three participants polling every 30 seconds for eight hours cost 2,880 reads
for the comment MAX-id check. 200 comment writes at roughly four indexed row reads plus two fetched feed/title rows each add about 1,200
reads. Together that is about 4,080 reads, **0.082%** of the free daily read allowance. Continuous 24-hour polling, more participants and
extra page or thread opens increase this. Inspect the real `usage` after a change; local D1 metadata does not expose billable row counts.

Sources: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 metrics and insights](https://developers.cloudflare.com/d1/observability/metrics-analytics/),
[Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/).

## Verified manual SQL backups

```bash
# Node 22.14+ and npm dependencies are required. Use the existing Wrangler login.
BOARD_BACKUP_DIR=/absolute/path/outside/the/repository npm run backup
```

The default directory is `~/.boardkit/<project slug>/backups`. Repository paths, including symlinks into the repository, are rejected. The
directory is private (0700); SQL files and verification manifests are 0600. Every run:

1. Uses `wrangler d1 export DB --remote` to write an unpublished partial file.
2. Imports it with Wrangler into a **new temporary local D1 database**.
3. Checks the restored SQLite file read-only for integrity, card and comment counts and project membership and, when present in the
   schema, each project's chip and column counts. D1 itself forbids `PRAGMA integrity_check`, so this check uses Node's SQLite connection.
4. Publishes the SQL plus a SHA-256/count manifest only after verification.
5. Deletes only this script's dated backups (`board-YYYY-MM-DD.sql` and its `.json`) older than the latest 14 UTC dates. Failed exports or
   restores never prune existing backups.

One copy is kept per UTC date; reruns verify the existing copy. A directory lock prevents overlapping jobs; after a crashed process, inspect
the lock before removing it. Private transient Wrangler logs and local restore files are removed. A D1 export can temporarily pause queries.
The SQL contains private card and comment data, so keep it private. **Where the file bytes are decides what the backup holds**
(`FILE_STORAGE`, see the README): with `d1` the screenshots and attachments are rows of `file_blobs`, so they are **inside the export**, which
gets bigger by their size (BLOBs are written as hex, about twice their size) and takes longer to export and restore, and the files count
against the database's size limit (500 MB on the free plan); with `r2` the bytes are in the bucket, **not** in the export (the backup
includes their database metadata only), and the bucket needs its own copy; with `none` there are no files.

There is no scheduled backup: run it by hand, or schedule it yourself on a machine that has a signed-in Wrangler. A successful run
verifies only the resulting SQL copy, not a backup schedule.

For recovery, first run `verifyRestore()` from `scripts/backup.mjs` on the chosen SQL file; it always imports into a temporary local
database. Remote recovery is a separate operator action and is not performed by this script.
