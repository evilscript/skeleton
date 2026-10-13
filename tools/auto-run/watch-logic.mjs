// The decisions behind watch.mjs, as pure functions (no board, no GitHub, no clock) so tests can run them.
import { cardOfPr } from '../lib/pr.mjs';

// Statuses in which the Lead hears about assignee and priority changes.
export const WORKING = new Set(['todo', 'progress', 'pr_review', 'on_main']);

// A card's status; a board that only has the column is read by the column's name.
export const statusOf = (c) => c.status || c.col;

export const short = (s, n = 220) => {
	const t = String(s || '').replace(/\s+/g, ' ').trim();
	return t.length > n ? `${t.slice(0, n)}...` : t;
};

export const cardLine = (c) => `#${c.no} "${short(c.title, 70)}" status=${statusOf(c)} assignee=${c.assignee || '-'}${c.priority ? ` priority=${c.priority}` : ''}`;

// ctx: { me, role: 'lead'|'developer'|'qa', agents: Set of board names, leads: Set of the Lead's board names }

// Is this comment something the agent in this role has to look at? `cards` is the state kept for each card.
export function relevant(ctx, m, cards) {
	if (m.author === ctx.me) return false;
	if (ctx.role === 'lead') return true;
	if (ctx.role === 'qa') return m.to === ctx.me || m.type === 'review';
	const mine = cards[m.cardNo]?.assignee === ctx.me;
	return m.to === ctx.me || (!ctx.agents.has(m.author) && mine);
}

// The event notes for one card, given its previous state (undefined for a card not seen before).
export function cardEvents(ctx, c, prev) {
	if (ctx.role === 'qa') return [];
	const notes = [];
	const mine = c.assignee === ctx.me;
	if (ctx.role === 'lead') {
		// Work starts from todo (the Owner's go); backlog is where new cards land and stays quiet.
		const st = statusOf(c);
		const active = WORKING.has(st);
		if (!prev) return st === 'todo' ? [`new ${cardLine(c)}`] : [];
		const was = statusOf(prev);
		if (was !== st && st === 'todo') notes.push(`moved ${was} -> ${st}`);
		if (active && (prev.assignee || null) !== (c.assignee || null)) notes.push(`assignee ${prev.assignee || '-'} -> ${c.assignee || '-'}`);
		if (active && (prev.priority || null) !== (c.priority || null)) notes.push(`priority ${prev.priority || '-'} -> ${c.priority || '-'}`);
	} else {
		if (!prev) return mine ? [`assigned to you: new ${cardLine(c)}`] : [];
		if (mine && (prev.assignee || null) !== ctx.me) notes.push('assigned to you');
		if (!mine && prev.assignee === ctx.me) notes.push(`no longer yours (assignee ${c.assignee || '-'})`);
		if (mine && statusOf(prev) !== statusOf(c) && c.updatedBy !== ctx.me) notes.push(`moved ${statusOf(prev)} -> ${statusOf(c)} by ${c.updatedBy || '?'}`);
		if (mine && (prev.priority || null) !== (c.priority || null)) notes.push(`priority ${prev.priority || '-'} -> ${c.priority || '-'}`);
	}
	return notes.length ? [`${cardLine(c)}: ${notes.join(', ')}`] : [];
}

// Which batch slot a moment falls in, in the Owner's time zone. `minutes` must divide 60.
// Returns { key, label, into }: key is unique per day and slot, label is "HH:MM", into is the minutes since the slot began.
export function slotOf(date, timeZone, minutes = 30) {
	const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
	const get = (t) => parts.find((p) => p.type === t).value;
	const total = Number(get('hour')) * 60 + Number(get('minute'));
	const start = total - (total % minutes);
	const pad = (n) => String(n).padStart(2, '0');
	const label = `${pad(Math.floor(start / 60))}:${pad(start % 60)}`;
	return { key: `${get('year')}-${get('month')}-${get('day')} ${label}`, label, into: total - start };
}

// The Lead's status audit: the board's statuses against the facts on GitHub. Returns [[key, text], ...].
//   cards       { no: { status, updatedAt, updatedBy, title } }  (the state kept from the board)
//   openPrs     { key: { card, label, changes } }               (changes: the Lead sent it back)
//   mergedPrs   [{ number, title, body, mergedAt, mergeCommit: { oid } }]
//   released    (oid) => boolean: is the merge commit in a git tag?
//   ownerName   the Owner's board name: a card the Owner moved last is left alone (their move wins)
export function mismatches({ cards, openPrs, mergedPrs, released, ownerName = 'owner', now = Date.now(), windowHours = 72 }) {
	const found = [];
	const card = (no) => cards[no];
	const mine = (no) => card(no) && ![ownerName, 'owner'].includes(card(no).updatedBy || '');
	for (const [key, p] of Object.entries(openPrs)) {
		const no = p.card;
		if (!no || !mine(no) || p.changes) continue;
		const st = statusOf(card(no));
		if (['backlog', 'todo', 'progress'].includes(st)) found.push([`open:${key}:${st}`, `#${no} is ${st} but ${p.label || key} is open for it: set pr_review`]);
	}
	for (const p of mergedPrs) {
		const no = cardOfPr(p.title, p.body);
		if (!no || !mine(no) || now - Date.parse(p.mergedAt) > windowHours * 3600e3 || Date.parse(p.mergedAt) < Date.parse(card(no).updatedAt)) continue;
		const st = statusOf(card(no));
		if (['backlog', 'todo', 'progress', 'pr_review'].includes(st)) {
			found.push([`merged:${p.number}:${st}`, `#${no} is ${st} but PR #${p.number} was merged: set on_main`]);
		} else if (st === 'on_main' && released(p.mergeCommit?.oid)) {
			found.push([`released:${p.number}`, `#${no} is on_main but PR #${p.number} is in a release (a git tag): set on_prod_qa`]);
		}
	}
	return found;
}
