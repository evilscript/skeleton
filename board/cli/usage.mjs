import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// Wrangler finds the database by its binding name in wrangler.jsonc, so no database name is written down here.
const DATABASE = "DB";
export const FREE_ROWS_READ = 5_000_000;
export const FREE_ROWS_WRITTEN = 100_000;
export const INSIGHTS_LIMIT = 10_000;
export function insightPeriod(at) {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  // Insights filters datetimeHour. Round outward by less than one minute to
  // include today's 00:00 bucket without including yesterday's 23:00 bucket.
  return Math.max(1, Math.ceil((at.getTime() - midnight) / 60_000)) + "m";
}
export function summarizeInsights(rows, at, limit = INSIGHTS_LIMIT) {
  if (!Array.isArray(rows)) throw new Error("Wrangler insights returned an unexpected result; upgrade support before trusting usage.");
  let rowsRead = 0, rowsWritten = 0;
  for (const row of rows) {
    for (const name of ["totalRowsRead", "totalRowsWritten"])
      if (typeof row?.[name] !== "number" || !Number.isFinite(row[name]) || row[name] < 0)
        throw new Error("Wrangler insights omitted row totals; usage is unavailable.");
    rowsRead += row.totalRowsRead;
    rowsWritten += row.totalRowsWritten;
  }
  return {
    database: DATABASE, day: at.toISOString().slice(0, 10), timezone: "UTC",
    source: "wrangler d1 insights", asOf: at.toISOString(), queries: rows.length,
    partial: rows.length >= limit,
    rowsRead, rowsWritten,
    readQuota: FREE_ROWS_READ, writeQuota: FREE_ROWS_WRITTEN,
    readPercent: rowsRead / FREE_ROWS_READ * 100, writePercent: rowsWritten / FREE_ROWS_WRITTEN * 100,
    note: "Analytics can lag and are sampled. This database's usage only; the free allowance is shared by the account.",
  };
}
export function boardUsage(at = new Date(), run = (file, args, options) => execFileSync(file, args, options)) {
  let result;
  try {
    result = run(process.execPath, [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
      "d1", "insights", DATABASE, "--json", "--time-period", insightPeriod(at),
      "--sort-type", "sum", "--sort-by", "reads", "--limit", String(INSIGHTS_LIMIT)],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } catch {
    // Do not print captured Wrangler logs: authentication diagnostics may be sensitive.
    throw new Error("D1 usage unavailable. Check the existing Wrangler sign-in and network, then retry; no zero usage is assumed.");
  }
  try { return summarizeInsights(JSON.parse(result), at); }
  catch (error) { throw new Error("D1 usage unavailable: " + error.message); }
}
export function usageText(out) {
  return `${out.day} UTC · ${out.database} · ${out.source}\n`
    + `Rows read: ${out.rowsRead.toLocaleString("en-US")} / ${out.readQuota.toLocaleString("en-US")} (${out.readPercent.toFixed(3)}%)\n`
    + `Rows written: ${out.rowsWritten.toLocaleString("en-US")} / ${out.writeQuota.toLocaleString("en-US")} (${out.writePercent.toFixed(3)}%)\n`
    + (out.partial ? "Query limit reached; totals are lower bounds.\n" : "")
    + "Analytics may lag and be sampled; the account's free allowance is shared by all its databases.";
}
