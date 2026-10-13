// The language of the board page.
//
// The Worker says which language (GET /api/info "language", the BOARD_LANGUAGE variable). Every string the pages show is in a
// pack, public/i18n/<code>.json: a flat dictionary of stable ids to texts, with {name} placeholders. English (en.json) fills any
// missing pack or key, so a half-translated pack still works.
//
// In the HTML, the English text stays as the initial content and a data attribute names its id:
//   <p data-i18n="id">English text</p>                         the element's text
//   <p data-i18n="id" data-i18n-files="id2">English text</p>   id2 instead when the board has file storage
//   <input data-i18n-attr="placeholder:id; aria-label:id2">    attributes (name:id pairs, separated by ;)
//   <p data-i18n="id">Read it with <code data-slot="command">x</code>.</p>
//                                    the text may hold {command}; the element with that data-slot goes there, untranslated
// In scripts: t("id", { name: value }). The page stays hidden (html.i18n-loading, in each page's style sheet, which also shows it
// again after a few seconds whatever happens) until init() has applied the pack.
const FALLBACK = "en";
let english = {};
let strings = {};
let current = FALLBACK;

const has = (key) => key in strings || key in english;
const format = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text);
// The text for an id, in the page language, else English, else the id itself.
export const t = (key, params) => format(strings[key] ?? english[key] ?? key, params);
export { has };
export const language = () => current;
// A locale for Intl and toLocaleString: the page language, or undefined (the browser's own) if it is not a valid tag.
export function locale() {
  try { return new Intl.Locale(current).toString(); } catch { return undefined; }
}
// A file size the way the pages say it: KB under a megabyte, else MB with at most one decimal.
export function formatSize(bytes) {
  if (bytes < 1048576) return Math.max(1, Math.round(bytes / 1024)) + " KB";
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(bytes / 1048576) + " MB";
}

async function pack(code) {
  try {
    const response = await fetch(`/i18n/${encodeURIComponent(code)}.json`);
    if (!response.ok) return null;
    const data = await response.json();
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function setText(node, text) {
  const slots = [...node.querySelectorAll("[data-slot]")];
  if (!slots.length) { node.textContent = text; return; }
  const byName = new Map(slots.map((slot) => [slot.dataset.slot, slot]));
  node.replaceChildren(...text.split(/(\{\w+\})/).filter(Boolean).map((part) => (/^\{\w+\}$/.test(part) && byName.get(part.slice(1, -1))) || part));
}
// Put the pack's texts into the markup under `root`. `files`: the board has file storage (see data-i18n-files).
export function apply(root = document, files = false) {
  for (const node of root.querySelectorAll("[data-i18n]")) {
    const key = (files && node.dataset.i18nFiles) || node.dataset.i18n;
    if (has(key)) setText(node, t(key));
  }
  for (const node of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of node.dataset.i18nAttr.split(";")) {
      const [name, key] = pair.split(":").map((part) => part.trim());
      if (name && key && has(key)) node.setAttribute(name, t(key));
    }
  }
}

// Ask the Worker for the language, load the pack (and English under it), apply it to the page and show the page.
// Returns what /api/info said ({} when it could not be read), which the pages use for the name and the file storage.
export async function init() {
  let info = {};
  try {
    const response = await fetch("/api/info");
    if (response.ok) info = await response.json();
  } catch {}
  const code = typeof info.language === "string" && /^[A-Za-z0-9-]{2,20}$/.test(info.language) ? info.language : FALLBACK;
  const [own, base] = await Promise.all([code === FALLBACK ? null : pack(code), pack(FALLBACK)]);
  english = base || {};
  strings = own || english;
  current = own ? code : FALLBACK;
  document.documentElement.lang = current;
  apply(document, info.files === true);
  document.documentElement.classList.remove("i18n-loading");
  return info;
}
