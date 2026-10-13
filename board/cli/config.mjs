// What the board CLI and the scripts need from the project's skeleton.config.json,
// read with plain fs so the board directory stays self-contained (nothing here
// imports from outside board/).
//
// The config file is found by walking up from this file's directory, then from
// the current directory. Without one, only the environment (BOARD_URL, ...) and
// the defaults below apply.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_FILE = "skeleton.config.json";

function findUp(start) {
  let dir = resolve(start);
  for (;;) {
    const file = join(dir, CONFIG_FILE);
    if (existsSync(file)) return file;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// { file, config } for the first skeleton.config.json found, or null.
export function findConfig(starts = [fileURLToPath(new URL(".", import.meta.url)), process.cwd()]) {
  for (const start of starts) {
    const file = findUp(start);
    if (!file) continue;
    try {
      return { file, config: JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      throw new Error(`${file} is not valid JSON`);
    }
  }
  return null;
}

// The settings the CLI uses, from the config (when there is one) and the environment.
export function boardSettings(env = process.env, found = findConfig()) {
  const config = found?.config ?? {};
  const slug = String(config.project?.slug || "default");
  const stateDir = join(homedir(), ".boardkit", slug);
  return {
    configFile: found?.file ?? null,
    url: String(env.BOARD_URL || config.board?.url || "").replace(/\/$/, ""),
    slug,
    // The key-store service name: board.keychainService, else <slug>-board, else "board".
    keychainService: String(config.board?.keychainService || (config.project?.slug ? `${config.project.slug}-board` : "board")),
    defaultProject: config.board?.defaultProject || "",
    // The Owner's name on the board (owner.boardName): the account their key is stored under.
    ownerBoardName: String(config.owner?.boardName || "owner"),
    timezone: config.owner?.timezone || undefined,
    stateDir,
    keyDir: join(stateDir, "keys"),
  };
}
