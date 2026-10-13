# START HERE: the first-run protocol

This file is for the AI agent that opens this repository for the first time. It applies **only while `skeleton.config.json` does not exist** in the repository root.
Once that file exists the repository has been set up and this file is history: follow `AGENTS.md` instead.

Your job: interview the Owner (the human), write their answers into `skeleton.config.json`, apply them, link the repository to their GitHub account, set up the board, and leave a team that can start working.
Do the work yourself wherever you can; ask only what you cannot find out.

## 1. Ground rules for the whole setup

1. **Ask before you act, in the Owner's language.** Mirror the language the Owner writes in. Keep questions short. Ask a few related questions at a time, never a wall of forty. For every question give a default or your recommendation; "you decide" is a valid answer, and then you decide and say what you chose.
2. **Never ask for, read, type, store or print a credential**: tokens, passwords, API keys, client secrets, recovery codes. The Owner runs every login and every secret-creating command in their own terminal; you give them the exact command and then verify with a read-only command (`gh auth status`, `npx wrangler whoami`). The config file holds public identifiers only.
3. **Nothing outward-facing without an explicit yes in chat**: creating a GitHub repository, pushing, creating cloud resources, deploying the board. Say what will happen and what it may cost (the board runs on the free tier of Cloudflare), ask once, then do it.
4. **Do not invent people.** Names for the Owner and the team members come from the Owner. If they say "you pick", propose names and let them veto before you write anything.
5. **Do not start any project work** (features, refactors, cards) until the setup is finished and the Owner has confirmed the summary.
6. **Do not push to the kit's own repository.** The `origin` remote of a fresh clone points at the kit. Step 5 replaces it before the first push.

## 2. Look at the machine first (no questions)

```bash
node tools/setup/check.mjs --json
```

It reports git, Node, the GitHub CLI and which account it is logged in as, the operating system, the time zone, the remote, and whether the config exists. Fix the `blockers` first:

- GitHub CLI missing or not logged in: tell the Owner to install it (https://cli.github.com) and run `gh auth login` in their own terminal, then run the check again.
- Node older than 20: the tools need 20 or newer; the board needs 22.14 or newer.

Use what you learned as defaults below (the logged-in GitHub account, the time zone, the folder you are in).

**The one account the Owner must create: Cloudflare.** The board (the team's source of truth) runs on the Owner's own free Cloudflare account, and the kit does not work without it. This is required, not optional, and it is the only account the Owner has to create: after it exists, **you do the rest** (database, configuration, tests, deployment, first card); the Owner only has to do four short things in their own browser or terminal, listed in step 7. Right after the machine check, say this to the Owner and ask them to create the account **now, while you interview them**:

1. Open https://dash.cloudflare.com/sign-up, enter an email address and a password, and confirm the email. It is free: no card and no domain are needed (skip any offer to add a site or a payment method).
2. Tell you when it is done. Continue with the interview meanwhile; do not go on to step 7 until they have said so.

If the Owner already has a Cloudflare account, they skip this. If they cannot or will not use Cloudflare, say plainly that this kit needs it and that the setup stops here (a board on another host is not built); do not continue.

## 3. The interview

Ask in this order. Write nothing to disk yet; keep the answers in your head or in a scratch note outside the repository. Every answer can be changed later: say so, so the Owner does not agonise.

**A. The project**
1. What is the project's name, in one line what is it, and what kind of thing is being built (web app, mobile app, game add-on, documentation, research, ...)? Default for the slug: the name in lowercase with hyphens (letters, digits and hyphens, up to 30 characters).
2. Does the project already have code somewhere (an existing repository, a folder)? If yes, where, and should it move into this repository or stay separate?

**B. GitHub**
3. Which GitHub account or organization owns the project repository (default: the account `gh` is logged in as)? What is the repository called (default: the slug)? Should it be created now or does it already exist? Public or private (recommend private; the kit itself is public, a project repository does not have to be)?
4. Default branch name (default `main`).

**C. The Owner**
5. What should the agents call you? Which time zone should times be given in (default: the one the machine reports)? Your name on the board is `owner` unless you want another (lowercase letters, digits, hyphens).

**D. Languages.** Nothing in the kit forces a language: these answers decide it. Ask all five in one go, with the defaults.
6. Which language should the agents talk to you in (default: the language you are writing in now)?
7. Which language for the project documents and for the comments members write to each other on cards (default: English, so any agent or newcomer can read them)?
8. Which language for code comments, and which for commit messages (default English for both; titles and bodies may differ, for example titles in your language and bodies in English)?
9. Which languages does the text the product shows to its users need (for example English and Chinese), or "not applicable"? Write "not decided yet" if unsure.
10. Which language for the board's web pages? English and Simplified Chinese come ready; for any other language you translate one file (`board/public/i18n/en.json`) and set the code. Default: your language if a pack exists, else English.

**E. The team.** Explain the roles in one line each: the **Lead** (plans, hands out cards, reviews and merges every pull request, releases on the Owner's word), **Developers** (take assigned cards, one branch and one pull request per card, never merge) and **QA** (tests pull requests on a test machine with the project's checks, never changes code).
11. The Lead: its name (what people call it), its board identity (default `agent-<name in lowercase>`; it never changes once cards exist), and where it runs (this machine, a cloud session, another tool). By default the agent talking to you is the Lead; confirm.
12. Developers: how many for now (zero is fine, they can be added later), and for each the same three things plus a branch prefix (default `<board identity>/`).
13. QA: do you want a QA member now? If yes the same three things. Which machine will it use?
14. Does any member run on a machine that several members share, or in a cloud session? (It changes how its board key reaches it; see step 7.5.)

**F. Folders.** The project folder is the clone of the project's GitHub repository. Each member gets a folder inside it named `<Role> - <Name>` (for example `PM - Atlas`, `Dev - Bolt`, `QA - Check`), ignored by git, holding that member's checkouts and scratch files.
15. Which absolute folder on this machine should be the project folder (default: where this repository is now, or `~/Projects/<repo name>`)? If this repository sits somewhere else, move or clone it there before step 4.

**G. The board** (the source of truth for questions, tickets and to-dos; read `docs/BOARD_HOSTING.md` first so you can answer follow-up questions). It runs on the Owner's own free Cloudflare account, which is required (see step 2).
16. Confirm the Cloudflare account exists (email confirmed). If not yet, wait for it while you carry on with the other questions.
17. Address: the free `https://<worker name>.<subdomain>.workers.dev` (default, no domain needed; the Owner picks the `<subdomain>` once, step 7.3), or a custom domain whose DNS is on Cloudflare?
18. Where should card attachments and screenshots be kept? Recommend **in the board's own database** (`d1`: nothing extra to create, no card, images are shrunk to fit about 1.5 MB). Alternatives: **R2** (`r2`: large files, but Cloudflare asks for a payment card before R2 can be switched on), or **nowhere** (`none`: the board works, the attachment and screenshot parts are hidden). Switching later does not move existing files.
19. Deploy the board automatically from GitHub whenever `board/` changes? Default no (you run `npm run deploy`). If yes the Owner creates one API token during setup (step 7.7).
20. **The board password.** The Owner signs in to the board page with a password they choose now: at least 12 characters, something they will remember or keep in a password manager. **Do not let them type it to you**, in chat or anywhere you can read it: they enter it themselves at a hidden prompt in their own terminal in step 7.5. No outside account is involved in signing in. Say who else will need keys (every team member gets its own board key, placed by the Owner).

**H. How work is checked**
21. How do you run the project's tests (a command), or "none yet"? Is there a quicker subset for a single change (the minimum scope) and a full suite for a release? Anything that must never be merged without a green run?
22. Any rule about the model or the number of sub-agents the team may use (default: the model the Owner chose in their tool, at most three sub-agents at a time)?

**I. Knowledge and anything else**
23. Where do new requirements live, besides the repository (a prototype tool, a document, a design file)? The repository shows what has been built; a second source showing what is coming makes the agents much better. Names and links go into `docs/PROJECT_KNOWLEDGE.md`.
24. Is there anything else I should know or set up (working hours, things agents must never touch, existing conventions, other tools)? Ask what you need that this list missed.

When you have the answers, show **one summary table** and ask the Owner to confirm or correct it.

## 4. Write the config and apply it

1. Copy the shape of `skeleton.config.example.json` into `skeleton.config.json` and fill it with the confirmed answers. The languages (group D) go into the `languages` block and `owner.replyLanguage`. Fields you do not know yet stay empty strings (`d1Id`, `cloudflareAccountId`). `board.url` is the workers.dev address from question 17 (or the custom domain). `board.fileStorage` is the answer to question 18 (`d1`, `r2` or `none`); `board.r2Bucket` stays an empty string unless it is `r2` (then `<slug>-board-files`). `board.defaultProject` stays `main`. For the board names use `workerName`, `d1Name` and `keychainService` derived from the slug (`<slug>-board`).
2. `node tools/setup/apply.mjs --check` (validates the config), then `node tools/setup/apply.mjs --dry-run`, then `node tools/setup/apply.mjs`.
   It replaces the `{{TOKENS}}` in the documents, writes `docs/TEAM.md`, `board/src/agents.ts` and `board/wrangler.jsonc`, creates the member folders (each with `.claude/settings.local.json` holding that member's `BOARD_AS`), updates `.gitignore`, removes the first-run gate from `AGENTS.md`, and replaces `README.md` with the project's own (the kit's README moves to `docs/SKELETON_README.md`). It refuses to run twice; later changes to the team go into the config and then `node tools/setup/apply.mjs --refresh`.

## 5. Link the GitHub repository

1. Look at the remotes: `git remote -v`. If `origin` is the kit's repository, rename it so you can never push to it by accident: `git remote rename origin kit` (it stays available to pull future kit updates), and switch its push address off: `git remote set-url --push kit DISABLED-do-not-push-to-the-kit`. Only `git fetch kit` works from then on; nothing of this project is ever pushed to the kit.
2. The project repository:
   - If it does not exist and the Owner said yes: `gh repo create <owner>/<repo> --private --source . --remote origin` (use `--public` when chosen). This creates a GitHub repository: you already asked in step 1.3.
   - If it exists: `git remote add origin https://github.com/<owner>/<repo>.git`.
3. Create the labels the review process uses: `sh tools/setup/labels.sh <owner>/<repo>` (it only creates GitHub labels; safe to repeat).
4. Fill the project documents (step 6), then commit with a clear message and push the default branch. The first push publishes the content to that repository: do it only after the Owner confirmed the summary.

## 6. Fill in the project documents

`grep -rn "TODO(first-run)" docs AGENTS.md` lists every place that needs a project fact. Fill `docs/DEVELOPING.md` (how to set up, run and test; the checks), `docs/PROJECT_KNOWLEDGE.md` (the project map, the knowledge sources from question 16) and anything else the grep finds, from the answers and from what the project's code shows. Do not invent facts: where nothing is known write "unknown yet" and add it to the questions for the Owner.

If the document language (question 7) is not English, offer to translate the documents in `docs/`, `AGENTS.md` and the role and onboarding files now (sub-agents may do it, one file each). Rules: keep file names, commands, board status names, branch names, code and token-like words exactly as they are; translate the prose. Do it after the facts above are filled in, and say in the summary which files were translated. If the Owner says "later", note it as open.

## 7. The board

The board is part of every setup. The Cloudflare account exists (step 2). **You do almost everything; the Owner does exactly four short things**, each in their own browser or terminal because they are logins or secrets: (a) `npx wrangler login`, (b) choose the workers.dev name on one web page, (c) run `npm run setup:secrets` and choose the board password at its hidden prompt, (d) sign in to the board page with that password. Say this list to the Owner before you start, then take them through it in order, one thing at a time.

1. **You:** check Node 22.14 or newer, then `cd board && npm install`.
2. **The Owner, in their own terminal in the `board/` folder:** `npx wrangler login` (a browser opens; they approve). **You:** `npx wrangler whoami`; read the account id from its output and put it into `board.cloudflareAccountId`.
3. **The Owner, in the browser:** open `https://dash.cloudflare.com/<account id>/workers/onboarding` (give them the link with the real id), choose a workers.dev name for the account (if the page already shows one, use it), and tell you the name. **You:** set `board.url` to `https://<workerName>.<name>.workers.dev` (or the custom domain from question 17).
4. **You, after one yes from the Owner for the whole block** ("I will create the database `<d1Name>` in your Cloudflare account, build and test the board, and deploy it to your free workers.dev address; none of this costs money"): `npx wrangler d1 create <d1Name>` (and `npx wrangler r2 bucket create <slug>-board-files` only if `board.fileStorage` is `r2`); put the database id into `board.d1Id`; run `node tools/setup/apply.mjs --board-only`; if the board language (question 10) has no pack in `board/public/i18n/`, copy `en.json` to `<code>.json`, translate the values, and run `--board-only` again; then `npm run check && npm test`, `npm run db:remote` and `npm run deploy` in `board/`.
5. **The Owner, in their own terminal in `board/`:** `npm run setup:secrets`. It asks for the board password (hidden, typed twice, at least 12 characters), makes one key per team member and the session secret, stores the members' keys in the macOS Keychain or in key files under `~/.boardkit/<slug>/keys/`, and sets the Worker secrets without printing anything. The password is stored nowhere on the machine: only the Owner knows it (a forgotten one is replaced with `npm run setup:secrets -- --password-only`). A member on another machine or in a cloud session needs its own key placed there **by the Owner**; you never copy or move a key. Say exactly this to the Owner when it applies.
6. **The Owner:** open `<board.url>/board/` and sign in with the password. **You:** check as an agent: `BOARD_AS=<lead identity> node tools/board.mjs agents`, name the default project (`node tools/board.mjs projects rename main "<Project Name>"`) and create the first card ("Set up the team", assigned to the Lead).
7. Only if the Owner chose automatic deploys (question 19): **one** repository secret is needed, the account id is already in `board/wrangler.jsonc`. The Owner opens the Cloudflare dashboard, My Profile, API Tokens, "Create Token", picks the template "Edit Cloudflare Workers", limits it to their own account, checks that the list contains Account > D1 > Edit (add it if it does not; add Workers R2 Storage > Edit when the files are in R2), and creates it. In their own terminal they run `gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/<repo>` and paste the token at the hidden prompt. You never see it. Afterwards a push that changes `board/` deploys by itself (`docs/BOARD_HOSTING.md`).

## 8. Verify and hand over

- [ ] `node tools/setup/apply.mjs --check` passes and `docs/TEAM.md` lists the Owner and every member.
- [ ] Each member folder exists with its `.claude/settings.local.json`.
- [ ] `grep -rn "TODO(first-run)" docs AGENTS.md` shows only things the Owner still has to answer (list them for them).
- [ ] The repository is linked, committed and pushed (with the Owner's yes); `git status` is clean.
- [ ] `node tools/auto-run/watch.mjs --as <lead identity> --role lead --once` runs and the first card is visible on the board.

Then tell the Owner, in their language and briefly: what was created and where, the board address, what is still open (secrets they must create, members still to start), and how to start each other member: open that member's folder in its tool and tell it "Read `AGENTS.md`, then `docs/onboarding/onboarding-new-member-dev.md` (or `-qa.md`), and listen to the board". Finally explain the two modes (`docs/CONSTITUTION.md`, section 6) and that the Owner starts either one with their own words.

From now on follow `AGENTS.md`.
