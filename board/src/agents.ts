// The agents that work on the board: the name is the identity (the author of its
// comments, an assignee, a comment target, the key-store account and the
// BOARD_AS value) and the label is what the page shows. This is the one place
// that lists them: the Worker, the page (GET /api/agents) and the command line
// read it from here, so a new developer is one line here plus its key
// (scripts/add-agent.sh). The owner signs in with a one-time link (scripts/owner-link.sh) and is not in this list.
// The two data lines between the markers are generated from skeleton.config.json
// by tools/setup/apply.mjs; the rest of the file is hand-written.
// <agents:begin>
export const AGENT_LIST = [{ name: "lead", label: "Lead" }, { name: "developer", label: "Developer" }, { name: "qa", label: "QA", limited: true }] as const;
export const OWNER_ASSIGNEE = { name: "owner", label: "Owner" } as const;
// <agents:end>
// A limited agent (the QA role) reads everything and may only add comments of type
// note, question or blocked to cards. The Worker enforces that (src/index.ts).
export const AGENT_NAMES: readonly string[] = AGENT_LIST.map((a) => a.name);
export const LIMITED_AGENTS: readonly string[] = AGENT_LIST.filter((a) => "limited" in a && a.limited).map((a) => a.name);
