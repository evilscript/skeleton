// A temporary folder for a test that is removed when the test process exits. Node built-ins only.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];
process.on('exit', () => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

// The real path (on macOS the temporary folder is a link), so paths printed by git compare equal.
export function tempDir(prefix = 'skel-') {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	made.push(dir);
	return dir;
}
