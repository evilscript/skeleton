// The few GitHub calls the scripts make, through the gh CLI (signed in by the person who runs them). Node built-ins only.
import { firstLine, sh } from './proc.mjs';

const FIELDS = 'number,title,body,headRefName,headRefOid,baseRefName,state,isDraft,labels,author';

// A pull request as gh sees it. Throws an Error with a sentence that says what to do.
export async function prView(repo, number, fields = FIELDS) {
	const r = await sh('gh', ['pr', 'view', String(number), '--repo', repo, '--json', fields], { timeout: 60000 });
	if (r.code) throw new Error(`gh could not read pull request #${number}: ${firstLine(r.err)}. Is gh installed and signed in (gh auth status), and is "${repo}" right?`);
	try {
		return JSON.parse(r.out);
	} catch {
		throw new Error(`gh returned something that is not JSON for pull request #${number}: ${r.out.trim().slice(0, 80)}`);
	}
}

// Creates the label when it is missing (and refreshes its colour and text when it is there).
export async function ensureLabel(repo, label) {
	return sh('gh', ['label', 'create', label.name, '--repo', repo, '--color', label.color, '--description', label.description, '--force'], { timeout: 60000 });
}

// Adds and removes labels on a pull request; only labels that need it are touched.
export async function relabel(repo, number, { add = [], remove = [], current = [] }) {
	const have = new Set(current);
	const args = ['pr', 'edit', String(number), '--repo', repo];
	const toAdd = add.filter((l) => !have.has(l.name));
	const toRemove = remove.filter((l) => have.has(l.name));
	if (!toAdd.length && !toRemove.length) return { code: 0, out: '', err: '' };
	for (const l of toAdd) await ensureLabel(repo, l);
	for (const l of toAdd) args.push('--add-label', l.name);
	for (const l of toRemove) args.push('--remove-label', l.name);
	return sh('gh', args, { timeout: 60000 });
}
