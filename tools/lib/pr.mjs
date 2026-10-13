// Facts about pull requests that several scripts read the same way. Pure functions, no I/O.

// The labels the team puts on pull requests. The Lead sets the first three, the QA sets the last two.
export const LABELS = {
	changesNeeded: { name: 'Lead: changes needed', color: 'fbca04', description: 'The Lead sent it back: the card is the Developer\'s again' },
	merged: { name: 'Lead: merged', color: '6f42c1', description: 'The Lead merged it into the default branch' },
	needsOwner: { name: 'Needs the owner', color: 'd93f0b', description: 'The pull request holds a question only the Owner can answer' },
	qaPass: { name: 'QA: pass', color: '0e8a16', description: 'The QA ran the project\'s check command on it and it passed' },
	qaFail: { name: 'QA: fail', color: 'd73a4a', description: 'The QA ran the project\'s check command on it and it failed' },
};

// The card a pull request belongs to: the "Card: #N" line of its body, else the first "#N" in its title.
export function cardOfPr(title, body) {
	const fromBody = /^\s*(?:[-*]\s*)?Card:\s*#(\d+)\b/im.exec(String(body || ''));
	if (fromBody) return Number(fromBody[1]);
	const fromTitle = /#(\d+)\b/.exec(String(title || ''));
	return fromTitle ? Number(fromTitle[1]) : null;
}

// The pull request numbers a text links (https://github.com/<repo>/pull/N), in order, without repeats.
// With no repo given any repository's links count.
export function prNumbersIn(text, repoSlug = '') {
	const repo = repoSlug ? repoSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[^/\\s]+/[^/\\s]+';
	const re = new RegExp(`github\\.com/${repo}/pull/(\\d+)`, 'g');
	return [...new Set([...String(text || '').matchAll(re)].map((m) => m[1]))];
}

// The last lines of a long output, cut to a byte budget (a board comment has a size limit).
export function tailText(text, { lines = 30, bytes = 2000 } = {}) {
	let t = String(text || '').replace(/\r/g, '').trimEnd().split('\n').slice(-lines).join('\n');
	if (Buffer.byteLength(t) > bytes) {
		t = t.slice(-bytes);
		t = `...${t.slice(t.indexOf('\n') + 1)}`;
	}
	return t;
}

// The "## Heading" sections of a pull request body: { heading: text }.
export function sectionsOf(body) {
	const out = {};
	let cur = null;
	for (const line of String(body || '').replace(/\r/g, '').split('\n')) {
		const h = /^##\s+(.+?)\s*$/.exec(line);
		if (h) { cur = h[1]; out[cur] = ''; } else if (cur) out[cur] += `${line}\n`;
	}
	for (const k of Object.keys(out)) out[k] = out[k].trim();
	return out;
}

// What kind of file a path is, for the facts a review starts with: docs, tests or code.
export function kindOfPath(p) {
	if (/(^|\/)(tests?|__tests__|spec|specs)\//i.test(p) || /\.(test|spec)\.[a-z0-9]+$/i.test(p) || /(^|\/)test_[^/]+$/i.test(p) || /_test\.[a-z0-9]+$/i.test(p)) return 'tests';
	if (/^(docs\/|\.github\/|\.claude\/)/.test(p) || /\.(md|txt|rst)$/i.test(p)) return 'docs';
	return 'code';
}

// The sections a pull request template asks for (its "## Heading" lines), each with a verdict on the body:
// [{ heading, filled }]. A section is filled when it holds something besides HTML comments and white space.
export function templateReport(template, body) {
	const want = Object.keys(sectionsOf(template));
	const have = sectionsOf(body);
	return want.map((heading) => ({ heading, filled: heading in have && have[heading].replace(/<!--[\s\S]*?-->/g, '').trim().length > 0 }));
}
