# Developing {{PROJECT_NAME}}

Notes for anyone (people or AI agents) changing this project. Read this before touching the code; it saves reading every file.

**This file is a template until the first run is finished.** Every to-do marker below (a line that starts with the word `TODO` directly
followed by `(first-run):`) is a place the Lead fills in with the Owner during the first-run protocol (`START_HERE.md`); the protocol
finds them with a text search for that marker. Write only facts that were checked in this repository, and delete the marker when you
replace it. The sections that carry no marker are rules that hold for every project.

## 1. Set up

TODO(first-run): the operating systems and tools needed (language runtime and its version, package manager, other tools), and how a new
checkout is made ready (the exact commands, in order).

TODO(first-run): environment variables or configuration files the project needs, and where their values come from. Never write a secret
value here: say who provides it and how.

## 2. Run

TODO(first-run): how to start the project locally and how to see it working (the commands, the address, the first thing to look at).

## 3. Where the code lives

TODO(first-run): a short map of the top-level folders and the main entry points, one line each. Name the folders that are generated or
that nobody edits by hand. Keep it to what a newcomer needs to find the right file; the finer map belongs in
`docs/PROJECT_KNOWLEDGE.md`.

`board/` is the board (a small web service with a database, a web page and a command line). It is not part of the product; its own
rules are in `board/README.md` and `board/docs/MAINTENANCE.md`. `tools/` holds the team's scripts (the listener, the Lead's and QA's
tools, setup).

## 4. Conventions

TODO(first-run): the code style and naming rules, how files and modules are organised, how new files are registered, how user-visible
text is handled (languages), how settings or configuration are added, and anything else a reviewer looks for.

General rules that hold everywhere:

- Comments explain why, not what, in {{CODE_LANGUAGE}}, matching the density around them.
- A new feature comes with checks. A fix comes with a check that failed before it.
- Do not reformat code you are not changing; a diff shows the card's change and nothing else.
- Everything outward-facing (text a user reads) is reviewed as carefully as the code.

## 5. Hard rules of this project

These are the rules whose breaking is costly or irreversible. They are law for every role (`docs/CONSTITUTION.md` section 2).

TODO(first-run): list them, each with its reason in one sentence (data that must never be touched or logged, an API or service that must
never be called from where, limits that must never be crossed, files that must never be edited by hand). If there are none, write "none
yet" and say so.

## 6. Checks

The project's check commands are set in `skeleton.config.json` (`checks`) and repeated here:

| What | Command |
|---|---|
| The check command | `{{CHECK_COMMAND}}` |
| Minimum scope (what runs from a branch up to the merge) | {{MIN_SCOPE}} |
| The full suite (what runs on the release tree when deploying) | `{{FULL_SUITE}}` |

Two levels, on purpose (`docs/CONSTITUTION.md` section 3): a Developer runs the minimum scope for its change and every check a shared
mechanism it touched can reach; the Lead merges on the minimum scope; the full suite runs when the Owner says to release or deploy.

TODO(first-run): how to run one check alone, how to pick the checks a change needs (by hand, or with a script if the project has one),
how long the full suite takes and on how much memory, and which kinds of change need no checks beyond documentation ones (for example
language-only changes or tooling).

### Writing checks that do not break other checks

Checks usually run one after another in the same process, so a check that leaves shared state changed fails some later check, often in
one environment only. The principles:

- **Change, then put back, also on failure.** Save what you replace, run the body so that a failure cannot skip the cleanup, restore in
  all cases. A runner that compares shared globals before and after each check turns a leak into an error naming the culprit; if the
  project has one, keep it.
- **Start from a state you set yourself.** Do not assume the defaults: an earlier check, or a scenario that wore the settings out, may
  have changed them. If a check's numbers depend on a setting, set it in the check and put it back.
- **Do not broadcast fake states.** While you stub a global fact (a clock, a mode, a connection state), never trigger project-wide events
  or updates: every module would apply its deferred work against the fake state. Drive only the part you test.
- **Do not restore what you did not change.** Restoring another part's state from a snapshot taken mid-run undoes that part's own later
  work.
- **Assert a specific object, not a naming pattern.** A check that recognises "a running timer" by the name of a field is fooled by any
  other object with the same field name; name your own fields something else, and make a check test the thing itself.
- **Shared mocks chain.** A test double that overrides something another double already wrapped must load after it and call the previous
  version, never a saved `nil`.
- **Run a new check alone, and in every environment the project uses, once.** Only the full suite shows cross-check effects, so a
  Developer's focused runs are not proof; the Lead's full run is.

## 7. Fixing a bug report

A bug reported from the field arrives as an error text, a log, a screenshot or a plain description. The routine:

1. Card first (on the feature's own card when the feature has shipped). Read the report as the Owner or the user wrote it.
2. Find the cause in the code. Before naming it, test the cheapest fact that would disprove it.
3. Reproduce it with a check that fails, where that is feasible. If it is not feasible, say so on the card.
4. Fix it. The check passes. Run the minimum scope, and every check a shared mechanism you touched can reach.
5. Put the Owner's verification steps on the card: what to do, what should be seen now. If the report was really a setting or already
   works, say where to change it and leave the decision to the Owner.

## 8. The board's own code

Changes under `board/` are reviewed and merged like any other, with the board's own checks (`board/README.md`). A database migration is
tested on a copy of production data first, backed up, applied and deployed straight after (`board/docs/MAINTENANCE.md`,
`docs/CONSTITUTION.md` L12). Never put a key, a token or a database id that belongs to the project's own account into a commit.

## 9. Documentation and versions

TODO(first-run): which documents the project keeps besides these (changelog, a list of pending tests, user documentation), their format,
and who updates them when (the pull request template, the Lead at merge, the Lead at release). State the version numbering rule the
Owner chose, if any (which part of a version number moves for a fix, for a new feature, and who decides a major change).

## 10. Release procedure

A release or deploy happens only on the Owner's word (`docs/CONSTITUTION.md` sections 2 and 7). Before it exists in writing here, the
Lead does not improvise one: it asks the Owner.

TODO(first-run): the Lead and the Owner write the procedure together. Cover, in order: what must be true before (the full suite
`{{FULL_SUITE}}` green on the exact tree; the pending-test list shown to the Owner; anything else the Owner requires), the exact
commands or scripts that cut the version (version edits, tag, publish, deploy), where the product is published or deployed and who has
the access, what to check afterwards and how, how a bad release is rolled back, and what the report to the Owner contains. After the
release: every `on_main` card in it goes to `on_prod_qa` (read `board list --status on_main` first).

TODO(first-run): a Lead-run dry run of the procedure (everything except publishing) so the first real release has already been rehearsed.
