# {{PROJECT_NAME}} project knowledge

This is a navigation and hand-off document, not a replacement for the source. Last reviewed: YYYY-MM-DD. Refresh dated facts when they
change; inspect Git, the board and the open pull requests before beginning a task, because a snapshot is not live state.

**This file is a template until the first run is finished.** Every to-do marker below (a line that starts with the word `TODO` directly
followed by `(first-run):`) is a place the Lead fills in with the Owner during the first-run protocol (`START_HERE.md`). Write only facts
that were checked, and delete the marker when you replace it.

## Product and ownership

{{PROJECT_DESCRIPTION}}

TODO(first-run): what the product is for and who uses it, in a few sentences, in the Owner's words.

- Repository: `https://github.com/{{GITHUB_OWNER}}/{{GITHUB_REPO}}`; default branch `{{DEFAULT_BRANCH}}`.
- Board: {{BOARD_URL}} (default project `{{BOARD_DEFAULT_PROJECT}}`).
- The Owner: {{OWNER_NAME}}. The team and the roles are in `docs/TEAM.md` (generated); the rules are in `docs/CONSTITUTION.md`.

TODO(first-run): where the product is published or deployed (addresses, accounts that own them, who has access), and which of those the
agents may touch. Never write a secret here.

## Current state

TODO(first-run): the released version (if any) and the date, what is on `{{DEFAULT_BRANCH}}` and not yet released, and what is in
progress. Update this section at every release and at every hand-off.

## How the project is organised

TODO(first-run): the main parts of the code and how they fit together (a short map, one line per part), and which parts are risky to
change. Link to `docs/DEVELOPING.md` for set-up, conventions and checks instead of repeating them.

## External services and tools

TODO(first-run): services the project depends on (hosting, databases, package registries, payment, analytics), what each is used for,
and who owns the account. The board runs on the Owner's own Cloudflare account (`board/README.md`).

## Known traps

TODO(first-run): things that surprised people (flaky checks, slow steps, order-dependent set-up, platform differences) with the
workaround, one line each. Add to this list every time a mistake cost time (and then also add the lesson to `docs/CONSTITUTION.md`
section 8 when it is a rule).

## Open work

TODO(first-run): the big open items and the cards behind them, as `#34 - Title` pairs, in the Owner's order. The board is the source of
truth; this list is only the orientation.

## Hand-off

Fill in at the end of a session or when a member changes. Newest first.

TODO(first-run): the first entry, in this shape.

| Date | Who | State | Next step | Open questions for the Owner |
|---|---|---|---|---|
| YYYY-MM-DD | member name | what is merged, in review, blocked | the one next action | questions, each with a recommendation |
