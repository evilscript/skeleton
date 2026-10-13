# Onboarding new members

One onboarding document per role, kept in this folder and reused for every new member. The documents are **general**: they contain no
member's name. A new member learns its name, role, board name and folder from the first message of the Lead (or the Owner) and from the
`BOARD_AS` setting in its folder (see "The first message" below). The rules a role follows are in `docs/roles/`; the one-line version of
each role is in `docs/CONSTITUTION.md` section 1.

| Role | Onboarding document | Role definition |
|---|---|---|
| Developer | [onboarding-new-member-dev.md](onboarding-new-member-dev.md) | [../roles/developer.md](../roles/developer.md) |
| QA (test machine) | [onboarding-new-member-qa.md](onboarding-new-member-qa.md) | [../roles/qa.md](../roles/qa.md) |
| Lead | none: the Lead's work is `docs/roles/lead.md` and the playbooks in `.claude/skills/` | [../roles/lead.md](../roles/lead.md) |
| Owner | none: [../roles/owner.md](../roles/owner.md) is the Owner's own guide | |

Who holds which role today is the generated roster `docs/TEAM.md`.

## Folders

The layout is the same on every machine (`AGENTS.md`, "Folders and roles"). The project folder is the clone of the project repository.
Each member has one folder inside it named `<Role> - <Name>` (its exact name is `roles[].folder` in `skeleton.config.json`; git ignores
it). The member's checkouts, scratch files and `.claude/settings.local.json` (with `BOARD_AS`) live there, and nowhere else. Nobody makes
folders beside the project folder or invents other paths: the Lead tells a new member its path in the first message. On a machine shared
with the Lead the member's checkouts are git work trees (`<Role> - <Name>/main`, then one per card); on any other machine one clone
named `main` inside the member folder is enough (`docs/GIT_WORKFLOW.md`).

## The Lead's checklist: adding a member

Run it whenever the Owner says to start a new member (a new Developer, a QA, or a second agent for a role).

1. **Ask the Owner, every time, for three things; never invent them.** (a) The member's **name**, the label people see; only the name,
   without a role prefix. (b) Its **role**: `developer`, `qa` or `lead`. If the Owner did not say, ask: a new member could be a
   Developer or a tester. (c) Its **runtime**: which tool and where it runs (this machine, another machine, a cloud session). Propose a
   board name (default `agent-<name in lowercase>`; lowercase letters, digits and hyphens) and, for a Developer, a branch prefix
   (default `<board name>/`), and let the Owner veto. The board name is the identity and never changes once cards exist.
2. **Add it to `skeleton.config.json`**, in `roles`: `role`, `name`, `boardName`, `runtime`, `folder` (`"<Role> - <Name>"`, for
   example `"Dev - Bolt"`), `branchPrefix` for a Developer, and `"limited": true` for a QA member. The file holds public identifiers
   only, never a key.
3. **Regenerate.** `node tools/setup/apply.mjs --check` validates the configuration, then `node tools/setup/apply.mjs --refresh`
   rewrites the generated files (`docs/TEAM.md`, the board's list of agent names `board/src/agents.ts`, `board/wrangler.jsonc`, the
   member folders and the member block of `.gitignore`). Review the diff and commit it like any change. Nothing else lists members.
4. **Deploy the board's updated list of names, if the board is running.** The board refuses comments and assignments from a name it
   does not know. Follow `board/README.md`, "Adding a developer" (run the board's checks, then deploy). A board deploy is yours only
   under a standing word of the Owner (`docs/CONSTITUTION.md` section 3, rule 20); otherwise ask.
5. **The key is the Owner's job, never an agent's.** Give the Owner the exact command and let them run it in their own terminal:
   `bash board/scripts/add-agent.sh <board name>`. It makes the member's key in the Owner's key store (the macOS Keychain, or a key file
   under `~/.boardkit/{{PROJECT_SLUG}}/keys/`) and sets the board's list of keys from every member's stored key; it prints nothing
   secret. Where the member runs decides what happens next:
   - On the machine that holds the key store: nothing more to do.
   - On another machine: the Owner puts the key into that machine's environment, in person, as `BOARD_KEY`, or as `BOARD_KEY_<NAME>`
     (the board name in capitals, `-` as `_`) when several members share the machine and its operating-system user. The Owner copies the
     key from the key store without showing it to any agent (service `{{KEYCHAIN_SERVICE}}`, account = the board name).
   - A cloud session has no environment of its own to keep a secret in: the Owner adds the key as the environment's API credential
     for the board's host (header `Authorization`, prefix `Bearer`). The session's proxy adds it on the way out, and the session sets
     `BOARD_AUTH=proxy`. A credential added later reaches new sessions only.
   - You never copy, move, print or paste a key, and never ask the Owner to paste one into a chat or a file.
6. **Verify.** `BOARD_AS=<board name> node tools/board.mjs agents` lists the name, and `whoami` answers with it. For a QA member
   `whoami` must say `limited`; a QA key that can do more is a mistake to fix before it starts. A 401 means the key was not placed
   correctly: tell the Owner.
7. **Send the first message** (the Owner may send the one-sentence version, `docs/roles/owner.md`; you add the rest):

   > You are `<Name>`, role `<Developer|QA>`, board name `<board name>`. Your folder is `<absolute path>/<Role> - <Name>`; make your
   > checkout there and nowhere else. Read `AGENTS.md`, `docs/CONSTITUTION.md`, `docs/roles/<role>.md` and
   > `docs/onboarding/<onboarding document>`. Set `BOARD_AS` as that document says, check `node tools/board.mjs whoami`, then start the
   > listener: `node tools/auto-run/watch.mjs --as <board name> --role <developer|qa>`. Setup alone is not a request to start work.
   > <Where the key is: nothing to do / the Owner sets it in your environment / it is the environment's credential.>

8. **Tell the Owner**: the member is ready, which role and board name, and (if the key needs placing) exactly where the Owner puts it.
9. **A role the kit does not have** is a change to the constitution (section 1 table, only with the Owner's word), a new
   `docs/roles/<role>.md`, a new onboarding document copied from the closest one in this folder, and a change to the role check in
   `tools/setup/apply.mjs`. Do not hand a member a role that exists nowhere.

## Labels the process uses

| Label | Set by | Meaning |
|---|---|---|
| `Lead: changes needed` | the Lead | the Lead reviewed the pull request and sent it back; the card is the Developer's again |
| `Lead: merged` | the Lead | the Lead merged it |
| `Needs the owner` | the Lead | the pull request holds a product question only the Owner can answer |
| `QA: pass` | QA | the QA ran the check command on the head merged onto `{{DEFAULT_BRANCH}}`: passed |
| `QA: fail` | QA | the same run failed |

`sh tools/setup/labels.sh [owner/repo]` creates all five in the project's repository. It is safe to repeat (existing labels are left
alone), needs the signed-in `gh` command, and changes only labels. The first-run setup runs it once; run it again for a new repository.
