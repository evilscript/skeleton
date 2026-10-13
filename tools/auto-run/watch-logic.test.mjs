// Tests for the pure parts of the listener: node tools/lib/run-tests.mjs tools/auto-run
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardEvents, cardLine, mismatches, relevant, short, slotOf, statusOf } from './watch-logic.mjs';

const agents = new Set(['agent-atlas', 'agent-bolt', 'agent-check']);
const leads = new Set(['agent-atlas']);
const dev = { me: 'agent-bolt', role: 'developer', agents, leads };
const lead = { me: 'agent-atlas', role: 'lead', agents, leads };
const qa = { me: 'agent-check', role: 'qa', agents, leads };
const card = (o = {}) => ({ no: 7, title: 'Fix login redirect', status: 'todo', assignee: null, priority: null, ...o });

test('statusOf reads the status, or the column of an older board', () => {
	assert.equal(statusOf({ status: 'progress', col: 'progress' }), 'progress');
	assert.equal(statusOf({ col: 'backlog' }), 'backlog');
});

test('short collapses white space and cuts long text', () => {
	assert.equal(short('a  b\n c'), 'a b c');
	assert.equal(short('x'.repeat(30), 10), 'xxxxxxxxxx...');
});

test('cardLine names number, title, status, assignee and priority', () => {
	assert.equal(cardLine(card({ assignee: 'agent-bolt', priority: 'major' })), '#7 "Fix login redirect" status=todo assignee=agent-bolt priority=major');
});

test('developer: hears comments to it and the Owner on its cards, not other agents', () => {
	const cards = { 7: { assignee: 'agent-bolt' }, 8: { assignee: 'agent-other' } };
	assert.equal(relevant(dev, { author: 'agent-atlas', to: 'agent-bolt', cardNo: 8 }, cards), true);
	assert.equal(relevant(dev, { author: 'owner', to: null, cardNo: 7 }, cards), true);
	assert.equal(relevant(dev, { author: 'owner', to: null, cardNo: 8 }, cards), false);
	assert.equal(relevant(dev, { author: 'agent-atlas', to: null, cardNo: 7 }, cards), false);
	assert.equal(relevant(dev, { author: 'agent-bolt', to: 'agent-bolt', cardNo: 7 }, cards), false);
});

test('lead hears everybody but itself; qa hears reviews and its own mail', () => {
	assert.equal(relevant(lead, { author: 'agent-bolt', to: null, cardNo: 1 }, {}), true);
	assert.equal(relevant(lead, { author: 'agent-atlas', to: null, cardNo: 1 }, {}), false);
	assert.equal(relevant(qa, { author: 'agent-bolt', type: 'review', cardNo: 1 }, {}), true);
	assert.equal(relevant(qa, { author: 'agent-bolt', type: 'note', to: null, cardNo: 1 }, {}), false);
	assert.equal(relevant(qa, { author: 'agent-atlas', type: 'note', to: 'agent-check', cardNo: 1 }, {}), true);
});

test('lead: new todo cards are events, backlog is quiet, moves into todo are events', () => {
	assert.equal(cardEvents(lead, card({ status: 'todo' }), undefined).length, 1);
	assert.deepEqual(cardEvents(lead, card({ status: 'backlog' }), undefined), []);
	const moved = cardEvents(lead, card({ status: 'todo' }), { status: 'backlog', assignee: null, priority: null });
	assert.match(moved[0], /moved backlog -> todo/);
	const reassigned = cardEvents(lead, card({ status: 'progress', assignee: 'agent-bolt' }), { status: 'progress', assignee: null, priority: null });
	assert.match(reassigned[0], /assignee - -> agent-bolt/);
	assert.deepEqual(cardEvents(lead, card({ status: 'done' }), { status: 'done', assignee: null, priority: null }), []);
});

test('developer: assigned, no longer yours, moved by somebody else', () => {
	assert.match(cardEvents(dev, card({ assignee: 'agent-bolt' }), undefined)[0], /^assigned to you: new #7/);
	assert.deepEqual(cardEvents(dev, card({ assignee: 'agent-other' }), undefined), []);
	assert.match(cardEvents(dev, card({ assignee: 'agent-bolt' }), { assignee: null, status: 'todo' })[0], /assigned to you/);
	assert.match(cardEvents(dev, card({ assignee: 'agent-other' }), { assignee: 'agent-bolt', status: 'todo' })[0], /no longer yours/);
	assert.match(cardEvents(dev, card({ assignee: 'agent-bolt', status: 'pr_review', updatedBy: 'agent-atlas' }), { assignee: 'agent-bolt', status: 'progress' })[0], /moved progress -> pr_review by agent-atlas/);
	assert.deepEqual(cardEvents(dev, card({ assignee: 'agent-bolt', status: 'progress', updatedBy: 'agent-bolt' }), { assignee: 'agent-bolt', status: 'todo' }), []);
});

test('qa has no card events', () => {
	assert.deepEqual(cardEvents(qa, card({ assignee: 'agent-check' }), undefined), []);
});

test('slotOf: the half hour in the Owner\'s zone, minutes into the slot, a key per day', () => {
	const a = slotOf(new Date('2026-10-13T15:31:00Z'), 'America/New_York', 30);
	assert.deepEqual([a.label, a.into], ['11:30', 1]);
	assert.match(a.key, /^\d{4}-\d{2}-\d{2} 11:30$/);
	const b = slotOf(new Date('2026-10-13T15:29:00Z'), 'America/New_York', 30);
	assert.deepEqual([b.label, b.into], ['11:00', 29]);
	const c = slotOf(new Date('2026-10-13T00:00:00Z'), 'UTC', 60);
	assert.deepEqual([c.label, c.into], ['00:00', 0]);
	const d = slotOf(new Date('2026-10-13T04:05:00Z'), 'Asia/Tokyo', 15);
	assert.deepEqual([d.label, d.into], ['13:00', 5]);
});

const now = Date.parse('2026-10-13T12:00:00Z');
const cards = (o) => ({ 7: { status: 'progress', updatedAt: '2026-10-13T08:00:00Z', updatedBy: 'agent-atlas', title: 't', ...o } });
const none = () => false;

test('mismatches: an open pull request whose card is still progress', () => {
	const found = mismatches({ cards: cards(), openPrs: { 12: { card: 7, label: 'PR #12', changes: false } }, mergedPrs: [], released: none, now });
	assert.equal(found.length, 1);
	assert.match(found[0][1], /#7 is progress but PR #12 is open for it: set pr_review/);
});

test('mismatches: a pull request sent back (changes needed) or a card the Owner moved is left alone', () => {
	assert.deepEqual(mismatches({ cards: cards(), openPrs: { 12: { card: 7, changes: true } }, mergedPrs: [], released: none, now }), []);
	assert.deepEqual(mismatches({ cards: cards({ updatedBy: 'owner' }), openPrs: { 12: { card: 7 } }, mergedPrs: [], released: none, now }), []);
	assert.deepEqual(mismatches({ cards: cards({ status: 'pr_review' }), openPrs: { 12: { card: 7 } }, mergedPrs: [], released: none, now }), []);
});

const merged = (o = {}) => ({ number: 12, title: 'Fix login redirect', body: 'Card: #7', mergedAt: '2026-10-13T10:00:00Z', mergeCommit: { oid: 'abc' }, ...o });

test('mismatches: merged while the card is not On Main; released while it is', () => {
	const m1 = mismatches({ cards: cards({ status: 'pr_review' }), openPrs: {}, mergedPrs: [merged()], released: none, now });
	assert.match(m1[0][1], /#7 is pr_review but PR #12 was merged: set on_main/);
	const m2 = mismatches({ cards: cards({ status: 'on_main' }), openPrs: {}, mergedPrs: [merged()], released: (oid) => oid === 'abc', now });
	assert.match(m2[0][1], /#7 is on_main but PR #12 is in a release \(a git tag\): set on_prod_qa/);
	assert.deepEqual(mismatches({ cards: cards({ status: 'on_main' }), openPrs: {}, mergedPrs: [merged()], released: none, now }), []);
});

test('mismatches: old merges and cards updated after the merge are skipped', () => {
	assert.deepEqual(mismatches({ cards: cards({ status: 'pr_review' }), openPrs: {}, mergedPrs: [merged({ mergedAt: '2026-10-09T10:00:00Z' })], released: none, now }), []);
	assert.deepEqual(mismatches({ cards: cards({ status: 'pr_review', updatedAt: '2026-10-13T11:00:00Z' }), openPrs: {}, mergedPrs: [merged()], released: none, now }), []);
});
