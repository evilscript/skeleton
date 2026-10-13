# START HERE: the first-run protocol

This file is for the AI agent that opens this repository for the first time. It applies **only while `skeleton.config.json` does not exist** in the repository root.
Once that file exists the repository has been set up and this file is history: follow `AGENTS.md` instead.

Your job: ask the Owner (the human) a handful of questions, write the answers and your defaults into `skeleton.config.json`, apply them, link the repository to their GitHub account, set up the board, and leave a team that can start working.
The Owner's time is the scarce thing: do everything you can yourself, ask only what you cannot derive, and interrupt them only for what only they can do.

## 1. Ground rules for the whole setup

1. **Few questions, in the Owner's language.** Mirror the language the Owner writes in. Ask only the five questions of section 3, in one message (they are chat questions because the board does not exist yet; from step 7.6 on every question to the Owner is a `question` comment on the board, `docs/CONSTITUTION.md` section 3 rule 21); every other value is a default you propose once, in the summary table. "You decide" is always a valid answer.
2. **Never ask for, read, type, store or print a credential**: tokens, passwords, API keys, client secrets, recovery codes. The Owner runs every login and every secret-creating command in their own terminal; you give them the exact command and then verify with a read-only command (`gh auth status`, `npx wrangler whoami`). The config file holds public identifiers only.
3. **One yes covers the whole setup.** The Owner's yes to the summary table is the approval for every outward action listed in it (create the GitHub repository, push, create the cloud database, deploy the board, all free). After that yes, do not ask again before each of those actions. Ask again only for something that is not in the table, costs money, or cannot be undone (deleting anything, making something public that was not said to be public).
4. **Names follow the project name.** Never ask for the name of a repository, worker, database, folder, branch, key service or team member: derive them from the project name by the rules in section 3. The Owner can change any of them in the summary table; do not ask twice.
5. **Go as far as you can alone, and bring the Owner in only for what only they can do**: a login, a secret, a browser consent screen. Tell them once, up front, which few things that will be, then take them through those one at a time. Never send them to a web page for something a command can do.
6. **Do not start any project work** (features, refactors, cards) until the setup is finished and the Owner has seen the closing report.
7. **Do not push to the kit's own repository.** The `origin` remote of a fresh clone points at the kit. Step 5 replaces it before the first push.

## 2. Look at the machine first (no questions)

```bash
node tools/setup/check.mjs --json
```

It reports git, Node, the GitHub CLI and which account it is logged in as, the operating system, the time zone, the remote, and whether the config exists. Fix the `blockers` first:

- GitHub CLI missing or not logged in: tell the Owner to install it (https://cli.github.com) and run `gh auth login` in their own terminal, then run the check again.
- Node older than 20: the tools need 20 or newer; the board needs 22.14 or newer.

Use what you learned as defaults below (the logged-in GitHub account, the time zone, the folder you are in).

**The one account the Owner must create: Cloudflare.** The board (the team's source of truth) runs on the Owner's own free Cloudflare account, and the kit does not work without it. This is required, not optional, and it is the only account the Owner has to create: after it exists, **you do the rest** (database, configuration, tests, deployment, first card); the Owner only has to do three short things in their own terminal or browser, listed in step 7. Right after the machine check, say this to the Owner and ask them to create the account **now, while you interview them**:

1. Open https://dash.cloudflare.com/sign-up, enter an email address and a password, and confirm the email. It is free: no card and no domain are needed (skip any offer to add a site or a payment method).
2. Tell you when it is done. Continue with the interview meanwhile; do not go on to step 7 until they have said so.

If the Owner already has a Cloudflare account, they skip this. If they cannot or will not use Cloudflare, say plainly that this kit needs it and that the setup stops here (a board on another host is not built); do not continue.

## 3. The interview: five questions, then one summary

Ask these five in **one message**, each with its default, so the Owner can answer in a line or just say "ok":

1. **The project:** its name, in one line what it is, and what kind of thing it is (web app, mobile app, game add-on, documentation, research, ...). Is there code already somewhere (default: no, it starts empty; if yes, where, and does it move into this repository or stay)?
2. **The Owner:** what should the agents call you, and which language should they talk to you in (default: the language you are writing in)?
3. **The team:** how many Developers (default 1) and do you want a QA member now (default no)? You, the agent they are talking to, are the Lead.
4. **Checks and knowledge:** how do you run the project's tests (default: none yet), and where do new requirements live besides the repository, such as a prototype tool or a design file (default: nowhere yet)?
5. **Anything else** you should know, such as working hours, things that must never be touched, existing conventions (default: nothing)?

End the message with this heads-up, as a statement and not a question: "Right after you say yes to the summary I will ask you to choose your board password (at least 12 characters). You type it yourself into a hidden prompt, so it never appears in this chat and I never see it: please do not write it here."

Then **derive everything else** and put it in one summary table (do not ask about any of it):

| Item | Default |
|---|---|
| Slug | the project name in lowercase with hyphens (letters, digits, hyphens, up to 30 characters) |
| GitHub | owner = the account `gh` is logged in as; repository = the slug; new and **private**; default branch `main` |
| The Owner | board name `owner`; time zone from the machine |
| Languages | talk to the Owner: answer 2; project documents and card comments: English; code comments: English; commit messages: English; text the product shows to its users: not decided yet; board pages: the Owner's language if a pack exists (`en`, `zh-CN`), else English |
| Lead | name `<Project name> Lead`, board identity `<slug>-lead`, folder `PM - <name>`, runs on this machine |
| Developers | name `<Project name> Dev` (with 2 or more: `Dev 1`, `Dev 2`, ...), identity `<slug>-dev` (`<slug>-dev-1`, ...), folder `Dev - <name>`, branch prefix `<identity>/`, runtime "not started yet" |
| QA (if wanted) | name `<Project name> QA`, identity `<slug>-qa`, folder `QA - <name>`, limited key, runtime "not started yet" |
| Project folder | the folder this repository is in now |
| Board | Cloudflare account (required, step 2); worker, database and key service all `<slug>-board`; address `https://<slug>-board.<name>.workers.dev` with `<name>` = the slug, the free name of the Owner's Cloudflare account, registered by the first deploy (no domain); card files kept in the board's own database (`d1`); no automatic deploy from GitHub; the board password is chosen by the Owner in step 7.5 |
| Checks | the command from answer 4; minimum scope "the tests that cover the files the change touches"; full suite = the same command |
| Agent policy | the model the Owner chose in their tool; at most three sub-agents at a time |

In folder and identity names keep only letters, digits, spaces and hyphens (replace anything else by a space or a hyphen). A member's display name may be changed by the Owner at any time; the board identity never changes once cards exist.

**The summary and the one yes.** Show the table with the Owner's five answers filled in, followed by one plain sentence of what the yes will do: "create the private repository `<owner>/<repo>`, push this project to it, create the database `<slug>-board` in your Cloudflare account and deploy the board at the address above (all free)". Ask the Owner to confirm or edit any cell. Their yes is the approval for everything listed (ground rule 3). Mention, in one line each, the things that stay optional and off: automatic deploys from GitHub, keeping files in R2 instead of the board's database (needs a payment card), translating the documents into another language.

## 4. Write the config and apply it

1. Copy the shape of `skeleton.config.example.json` into `skeleton.config.json` and fill it with the confirmed answers. The languages go into the `languages` block and `owner.replyLanguage`. Fields you do not know yet stay empty strings (`d1Id`, `cloudflareAccountId`). `board.workersDevName` is the slug (the free name of the account's workers.dev address). `board.url` is the custom domain if the Owner named one; otherwise a placeholder until the first deploy shows the real address (step 7.3 and 7.4). `board.fileStorage` is `d1`, `r2` or `none` as in the summary; `board.r2Bucket` stays an empty string unless it is `r2` (then `<slug>-board-files`). `board.defaultProject` stays `main`. For the board names use `workerName`, `d1Name` and `keychainService` derived from the slug (`<slug>-board`).
2. `node tools/setup/apply.mjs --check` (validates the config), then `node tools/setup/apply.mjs --dry-run`, then `node tools/setup/apply.mjs`.
   It replaces the `{{TOKENS}}` in the documents, writes `docs/TEAM.md`, `board/src/agents.ts` and `board/wrangler.jsonc`, creates the member folders (each with `.claude/settings.local.json` holding that member's `BOARD_AS`), updates `.gitignore`, removes the first-run gate from `AGENTS.md`, and replaces `README.md` with the project's own (the kit's README moves to `docs/SKELETON_README.md`). It refuses to run twice; later changes to the team go into the config and then `node tools/setup/apply.mjs --refresh`.

## 5. Link the GitHub repository

1. Look at the remotes: `git remote -v`. If `origin` is the kit's repository, rename it so you can never push to it by accident: `git remote rename origin kit` (it stays available to pull future kit updates), and switch its push address off: `git remote set-url --push kit DISABLED-do-not-push-to-the-kit`. Only `git fetch kit` works from then on; nothing of this project is ever pushed to the kit.
2. The project repository:
   - If it does not exist: `gh repo create <owner>/<repo> --private --source . --remote origin` (use `--public` when chosen). This creates a GitHub repository: the Owner's yes to the summary covers it.
   - If it exists: `git remote add origin https://github.com/<owner>/<repo>.git`.
3. Create the labels the review process uses: `sh tools/setup/labels.sh <owner>/<repo>` (it only creates GitHub labels; safe to repeat).
4. Fill the project documents (step 6), then commit with a clear message and push the default branch. The first push publishes the content to that repository; the Owner's yes to the summary covers it.

## 6. Fill in the project documents

`grep -rn "TODO(first-run)" docs AGENTS.md` lists every place that needs a project fact. Fill `docs/DEVELOPING.md` (how to set up, run and test; the checks), `docs/PROJECT_KNOWLEDGE.md` (the project map, the knowledge sources from answer 4) and anything else the grep finds, from the answers and from what the project's code shows. Do not invent facts: where nothing is known write "unknown yet" and add it to the questions for the Owner.

If the Owner changed the document language in the summary to something other than English, offer to translate the documents in `docs/`, `AGENTS.md` and the role and onboarding files now (sub-agents may do it, one file each). Rules: keep file names, commands, board status names, branch names, code and token-like words exactly as they are; translate the prose. Do it after the facts above are filled in, and say in the summary which files were translated. If the Owner says "later", note it as open.

## 7. The board

The board is part of every setup. The Cloudflare account exists (step 2). **You do almost everything; the Owner does exactly three short things**, each in their own terminal or browser because they are a login or a secret: (a) `npx wrangler login`, (b) choose the board password at the hidden prompt of `npm run setup:secrets`, (c) sign in to the board page with that password. Even the free workers.dev name of the account is registered by the first deploy, without the Owner. Say this list to the Owner before you start (they already know the first part from step 2), then take them through it in order, one thing at a time, without further explanations or questions between the steps.

1. **You:** check Node 22.14 or newer, then `cd board && npm install`.
2. **The Owner, in their own terminal in the `board/` folder:** `npx wrangler login` (a browser opens; they approve). **You:** `npx wrangler whoami`; read the account id from its output and put it into `board.cloudflareAccountId`.
3. **You, without asking again** (the Owner's yes to the summary covers creating the database in their Cloudflare account, building and testing the board, and deploying it to the free workers.dev address; none of it costs money): `npx wrangler d1 create <d1Name>` (and `npx wrangler r2 bucket create <slug>-board-files` only if `board.fileStorage` is `r2`); put the database id into `board.d1Id`; while the real address is still unknown set `board.url` to the placeholder `https://<workerName>.setup-pending.workers.dev` (skip this when the Owner gave a custom domain); run `node tools/setup/apply.mjs --board-only`; if the board language in the summary has no pack in `board/public/i18n/`, copy `en.json` to `<code>.json`, translate the values, and run `--board-only` again; then `npm run check && npm test` and `npm run db:remote` in `board/`.
4. **You: `npm run deploy` in `board/`.** A new Cloudflare account has no free workers.dev name yet, and the first deploy registers one by itself: Wrangler does that when it recognises an AI agent running it, and it names the account `board.workersDevName` (the slug by default; `apply` has put it into `board/package.json`). Read the address from the deploy output (`https://<workerName>.<name>.workers.dev`) and run `node tools/setup/apply.mjs --set-board-url <that address>`; it stores the address in the config, replaces the placeholder in the documents and regenerates the board files. If the first deploy does not simply work:
   - the name is taken (Wrangler says it could not register it): set `board.workersDevName` to `<slug>-` plus four random lowercase letters or digits, run `--board-only`, deploy again; up to three tries;
   - Wrangler asks a question or says a subdomain is needed (your tool was not recognised as an agent): only then send the Owner to `https://dash.cloudflare.com/<account id>/workers/onboarding` (give them the link with the real id) to type a name there, set `board.workersDevName` to the same name, and deploy again.
5. **The Owner, at a hidden prompt: ask them for the board password now.** Say "Now choose your board password and type it into the prompt (nothing is shown; 12 or more characters; you type it twice)". If your tool can open a terminal panel or tab the Owner can type in (the desktop app's terminal tab, for example), run `npm run setup:secrets` there for them and tell them to click into that tab; otherwise give them the command to run in their own terminal in `board/`. Either way they type the password at the script's hidden prompt, never in the chat, so you never see it. The script asks for the board password (hidden, typed twice, at least 12 characters), makes one key per team member and the session secret, stores the members' keys in the macOS Keychain or in key files under `~/.boardkit/<slug>/keys/`, and sets the Worker secrets without printing anything. The password is stored nowhere on the machine: only the Owner knows it (a forgotten one is replaced with `npm run setup:secrets -- --password-only`). A member on another machine or in a cloud session needs its own key placed there **by the Owner**; you never copy or move a key. Say exactly this to the Owner when it applies.
6. **The Owner:** open `<board.url>/board/` and sign in with the password. **You:** check as an agent: `BOARD_AS=<lead identity> node tools/board.mjs agents`, name the default project (`node tools/board.mjs projects rename main "<Project Name>"`) and create the first card in **To do**: `node tools/board.mjs new "Set up the team" --status todo --assignee <lead identity>`, with the open items of the closing report as its description. It is the first trigger the listener hears (step 8).
7. Only if the Owner asks for automatic deploys (off by default; mention it once in the closing report): **one** repository secret is needed, the account id is already in `board/wrangler.jsonc`. The Owner opens the Cloudflare dashboard, My Profile, API Tokens, "Create Token", picks the template "Edit Cloudflare Workers", limits it to their own account, checks that the list contains Account > D1 > Edit (add it if it does not; add Workers R2 Storage > Edit when the files are in R2), and creates it. In their own terminal they run `gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/<repo>` and paste the token at the hidden prompt. You never see it. Afterwards a push that changes `board/` deploys by itself (`docs/BOARD_HOSTING.md`).

## 8. Turn on the listener, verify, hand over

**The trigger.** A card in **To do** is the Owner's go. The Lead's listener (`tools/auto-run/watch.mjs`, role `lead`) prints `[card] new ...` when a card appears in To do and `[card] moved ... -> todo` when the Owner moves one there; the Lead then reads the card, asks the Owner if it is not clear, and hands it out (an `assign` comment to a Developer; the Developer's own listener hears it and starts). A card in **Backlog** is silent: nothing starts from there. So the Owner starts work by writing a card and putting it in To do, on the board page or with `node tools/board.mjs new "title" --status todo`.

**When to turn the listener on, and who does it.**
- **The Lead (you): now.** As the last step of the setup, before the closing report, start it with the identity and role of the Lead, in the wake style your tool supports (`docs/CONSTITUTION.md` section 6): `node tools/auto-run/watch.mjs --as <lead identity> --role lead` as a background monitor (stream, one line per event), or with `--wake --minutes 30`, or `--once` at the start of every turn if the tool supports neither. Check that its first two lines are the `[watch] baseline` lines; that proves it works. The first card from step 7.6 should show up as the first event.
- **Every later session of the Lead:** the first thing, again. The monitor expires (about every 30 minutes in Claude Code): re-arm it each time, and list the To do cards by hand once after a re-arm, because a card that arrived while it was off is not reported afterwards.
- **Developers and QA:** the first thing in their first session, as their start prompt says (`docs/onboarding/README.md`): `node tools/auto-run/watch.mjs --as <board name> --role developer` (or `qa`).
- Tell the Owner plainly: the listener lives inside the agent's session. While the Lead's session is closed, or its listener expired, a card in To do waits until the next session starts the listener.

- [ ] `node tools/setup/apply.mjs --check` passes and `docs/TEAM.md` lists the Owner and every member.
- [ ] Each member folder exists with its `.claude/settings.local.json`.
- [ ] `grep -rn "TODO(first-run)" docs AGENTS.md` shows only things the Owner still has to answer (list them for them).
- [ ] The repository is linked, committed and pushed (the summary's yes covers it); `git status` is clean.
- [ ] The Lead's listener is running, its baseline lines were seen, and the first card ("Set up the team", in To do) has been heard.

Then tell the Owner, in their language and briefly: what was created and where, the board address, what is still open (secrets they must create, members still to start), how work starts (a card in To do; the listener must be running), where the agents' questions will appear (as comments on the board cards, never in the chat; the Owner answers them there), and how to start each other member: open that member's folder in its tool and tell it "Read `AGENTS.md`, then `docs/onboarding/onboarding-new-member-dev.md` (or `-qa.md`), and listen to the board". Finally explain the two modes (`docs/CONSTITUTION.md`, section 6) and that the Owner starts either one with their own words.

From now on follow `AGENTS.md`.
