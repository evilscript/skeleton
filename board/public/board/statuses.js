// Card statuses and the columns that show them (docs/STATUSES.md).
// Shared by the Worker, the page, the CLI and the tests. A card has a status;
// the stored `col` is the column key of that status and the Worker keeps the
// two in step in one place (columnOf). Order matters: a column lists its
// statuses in this order, and the first one is what a bare column name means.
export const STATUSES = [
  { slug: "backlog", label: "Backlog", col: "backlog" },
  { slug: "todo", label: "To do", col: "backlog" },
  { slug: "progress", label: "In progress", col: "progress" },
  { slug: "pr_review", label: "PR reviewing", col: "progress" },
  { slug: "on_main", label: "On Main", col: "progress" },
  { slug: "spike_ready", label: "Spike report ready", col: "progress" },
  { slug: "probe_needed", label: "Owner check needed", col: "testing" },
  { slug: "on_prod_qa", label: "On Prod for QA", col: "testing" },
  { slug: "qa_later", label: "QA later", col: "testing" },
  { slug: "done", label: "Done", col: "done" },
];
export const STATUS_SLUGS = STATUSES.map((s) => s.slug);
// Stored column keys. `todo` and `later` were columns in the first versions and
// are still accepted as input (they mean the statuses of the same name or
// qa_later); they are never stored in `col` any more.
export const COLUMN_KEYS = ["backlog", "progress", "testing", "done"];
export const COLUMN_LABELS = { backlog: "Backlog", progress: "In progress", testing: "Ready for QA", done: "Done" };
// `testing` stays the word for On Prod for QA although Owner check needed is listed first in that column.
const LEGACY = { todo: "todo", later: "qa_later", testing: "on_prod_qa" };

// What the board page shows: five columns, not the four stored ones. `col` above is
// the stored column (the CLI's --col, the filters, the database); the page splits In progress into In progress
// and PR submitted and lists the layers of each column in a fixed order. Every status is in exactly one.
export const VIEW_COLUMNS = [
  { key: "backlog", label: "Backlog", statuses: ["backlog", "todo"] },
  { key: "progress", label: "In progress", statuses: ["progress"] },
  { key: "pr", label: "PR submitted", statuses: ["pr_review", "spike_ready", "on_main"] },
  { key: "testing", label: "Ready for QA", statuses: ["probe_needed", "on_prod_qa", "qa_later"] },
  { key: "done", label: "Done", statuses: ["done"] },
];
export const viewColumnOf = (status) => VIEW_COLUMNS.find((c) => c.statuses.includes(status))?.key;
export const viewStatusesOf = (key) => VIEW_COLUMNS.find((c) => c.key === key)?.statuses ?? [];
export const columnOf = (status) => STATUSES.find((s) => s.slug === status)?.col;
export const statusLabel = (status) => STATUSES.find((s) => s.slug === status)?.label ?? status;
export const statusesOf = (col) => STATUSES.filter((s) => s.col === col);
// A project can show fewer statuses than the ten here and name some of them differently. The layout of a project that is not
// listed in PROJECT_LAYOUTS is the whole of VIEW_COLUMNS. A status a project hides is not offered on its page, and the Worker
// refuses it for that project's cards (a card in a layer nobody draws would be lost); `labels` only renames, the slug stays;
// `order` puts the layers of a column in another order (a view column key -> its statuses). Keyed by project key. Example:
//   "my-app": { hide: ["probe_needed", "qa_later"], labels: { spike_ready: "Spike done" }, order: { pr: ["pr_review", "on_main", "spike_ready"] } },
/** @type {Record<string, { hide?: string[], labels?: Record<string, string>, order?: Record<string, string[]> }>} */
export const PROJECT_LAYOUTS = {};
export const projectStatuses = (project) => STATUS_SLUGS.filter((s) => !PROJECT_LAYOUTS[project]?.hide?.includes(s));
export const viewStatusesFor = (project, key) => {
  const kept = projectStatuses(project), own = PROJECT_LAYOUTS[project]?.order?.[key];
  return (own ?? viewStatusesOf(key)).filter((s) => kept.includes(s) && viewStatusesOf(key).includes(s));
};
export const statusLabelFor = (project, status) => PROJECT_LAYOUTS[project]?.labels?.[status] ?? statusLabel(status);
// What a word means as a status: a status slug, a legacy column (todo, later)
// or a column name (its first status). Anything else is undefined.
export function statusFromWord(word) {
  if (typeof word !== "string") return undefined;
  if (STATUS_SLUGS.includes(word)) return word;
  if (LEGACY[word]) return LEGACY[word];
  return statusesOf(word)[0]?.slug;
}
