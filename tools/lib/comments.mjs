import { duration } from './proc.mjs';

// The texts the scripts post on cards. Pure functions, English, short. A board comment has a size limit
// (about 4 KB), so every builder stays well under it.

const PRIORITY = { blocker: 'Blocker', critical: 'Critical', major: 'Major', minor: 'Minor' };

// The marker the assign script looks for in the card's thread to know the comment arrived.
export const assignMarker = (leadName) => `Start (${leadName}, Lead)`;

// The `assign` comment: the standard start of a card. The requirement is the Owner's own words on the card;
// the Lead adds none, only signposts.
export function assignComment({ card, priority, leadName, repo, branch, defaultBranch, docs, hint, checks = {}, maxSubagents, extra }) {
	const lines = [];
	const prio = PRIORITY[priority];
	lines.push(`${assignMarker(leadName)}: #${card} is yours${prio ? `, priority ${prio}` : ''}. The requirement is the Owner's own words on the card (read the original and its attachments with \`board brief ${card}\`; the path is at the end of the event line). The Lead adds none.`);
	lines.push(`Repository ${repo || '(see docs/GIT_WORKFLOW.md)'}, branch ${branch}, from the latest ${defaultBranch}, one pull request${docs ? ', documentation only' : ''}.`);
	if (hint) lines.push(`Where to look (signposts, not requirements): ${hint}`);
	if (docs) lines.push('Documentation only: no code checks are needed.');
	else if (checks.command) lines.push(`Checks: before you open the pull request run the minimum scope (${checks.minimumScope || 'the checks that cover your change'}) with \`${checks.command}\`. Do not run the full suite${checks.fullSuite ? ` (${checks.fullSuite})` : ''}: the Lead runs it when deploying.`);
	else lines.push('Checks: see docs/DEVELOPING.md.');
	lines.push('When something is unclear, take the simplest reading, note it in the pull request under "Needs the owner" and keep going; do not stop to wait.');
	lines.push('One card, one pull request. If the card is too big for one, post a `question` comment on it; the Lead splits it into smaller cards. Never split it into several pull requests yourself.');
	if (maxSubagents) lines.push(`Sub-agents: at most ${maxSubagents} at a time.`);
	if (extra) lines.push(extra);
	return lines.join('\n');
}

// The `merged` comment the merge script posts for the Owner.
export function mergedComment({ leadName, time, card, pr, who, branch, merge, tested, label = 'On Main' }) {
	return `${leadName} (${time}): #${card} is merged into ${branch} (PR #${pr}, by ${who}, merge commit ${merge}). ${tested} The card is set to ${label}. Nothing is released yet. Questions under "Needs the owner" in the pull request are for the Owner.`;
}

// The `note` comment the QA posts for the Lead after running a pull request.
export function qaNote({ pass, pr, sha, base, baseSha, command, seconds, tail, log, conflicts, timedOut }) {
	const head = `QA: ${pass ? 'pass' : 'fail'} for PR #${pr} at ${sha.slice(0, 7)}`;
	const where = baseSha ? `, merged onto ${base} at ${baseSha.slice(0, 7)}` : '';
	const lines = [`${head}${where}.`];
	if (conflicts?.length) lines.push(`It does not merge cleanly into ${base}. Conflicts in: ${conflicts.join(', ')}.`);
	else {
		lines.push(`Command: \`${command}\`. ${timedOut ? 'Stopped: it ran too long.' : pass ? 'Exit 0.' : 'It failed.'} Took ${duration(seconds)}.`);
		if (!pass && tail) lines.push(`Last lines:\n${tail}`);
	}
	if (log) lines.push(`Full log on the QA machine: ${log}`);
	return lines.join('\n');
}
