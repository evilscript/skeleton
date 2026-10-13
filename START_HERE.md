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

## 3. The interview

Ask in this order. Write nothing to disk yet; keep the answers in your head or in a scratch note outside the repository.

**A. The project**
1. What is the project's name, in one line what is it, and what kind of thing is being built (web app, mobile app, game add-on, documentation, research, ...)? Default for the slug: the name in lowercase with hyphens (letters, digits and hyphens, up to 30 characters).
2. Does the project already have code somewhere (an existing repository, a folder)? If yes, where, and should it move into this repository or stay separate?

**B. GitHub**
3. Which GitHub account or organization owns the project repository (default: the account `gh` is logged in as)? What is the repository called (default: the slug)? Should it be created now or does it already exist? Public or private (recommend private; the kit itself is public, a project repository does not have to be)?
4. Default branch name (default `main`).

**C. The Owner**
5. What should the agents call you? Which language should they reply to you in, and which time zone should times be given in (default: the one the machine reports)? Your name on the board is `owner` unless you want another (lowercase letters, digits, hyphens).

**D. The team.** Explain the roles in one line each: the **Lead** (plans, hands out cards, reviews and merges every pull request, releases on the Owner's word), **Developers** (take assigned cards, one branch and one pull request per card, never merge) and **QA** (tests pull requests on a test machine with the project's checks, never changes code).
6. The Lead: its name (what people call it), its board identity (default `agent-<name in lowercase>`; it never changes once cards exist), and where it runs (this machine, a cloud session, another tool). By default the agent talking to you is the Lead; confirm.
7. Developers: how many for now (zero is fine, they can be added later), and for each the same three things plus a branch prefix (default `<board identity>/`).
8. QA: do you want a QA member now? If yes the same three things. Which machine will it use?
9. Does any member run on a machine that several members share, or in a cloud session? (It changes how its board key reaches it; see step 7.4.)

**E. Folders.** The project folder is the clone of the project's GitHub repository. Each member gets a folder inside it named `<Role> - <Name>` (for example `PM - Atlas`, `Dev - Bolt`, `QA - Check`), ignored by git, holding that member's checkouts and scratch files.
10. Which absolute folder on this machine should be the project folder (default: where this repository is now, or `~/Projects/<repo name>`)? If this repository sits somewhere else, move or clone it there before step 4.

**F. The board** (the source of truth for questions, tickets and to-dos; read `docs/BOARD_HOSTING.md` first so you can answer follow-up questions)
11. Set it up now on the Owner's own Cloudflare account (free; an email address is enough to create one), or later? If later, set `board.enabled` to `false`: everything else works, the cards just have no home yet.
12. Does the Owner have a domain whose DNS is on Cloudflare? Default: no. Then the board lives on the free address `https://<worker name>.<subdomain>.workers.dev`: no domain is needed. The Owner picks the `<subdomain>` once in the Cloudflare dashboard (Workers & Pages, "Your subdomain") and tells you the name, so the address is known before the first deploy.
13. Optional extras, all off by default: card attachments and screenshots (needs a Cloudflare R2 bucket, and Cloudflare asks for a payment card before R2 can be switched on); a public feedback form protected by Cloudflare Turnstile (needs a widget; you only need its public site key); deploying the board from GitHub on every push (needs an API token the Owner puts into the repository secrets). Ask for each in one line and accept "no".

**G. How work is checked**
14. How do you run the project's tests (a command), or "none yet"? Is there a quicker subset for a single change (the minimum scope) and a full suite for a release? Anything that must never be merged without a green run?
15. Any rule about the model or the number of sub-agents the team may use (default: the model the Owner chose in their tool, at most three sub-agents at a time)?

**H. Knowledge and anything else**
16. Where do new requirements live, besides the repository (a prototype tool, a document, a design file)? The repository shows what has been built; a second source showing what is coming makes the agents much better. Names and links go into `docs/PROJECT_KNOWLEDGE.md`.
17. Is there anything else I should know or set up (working hours, things agents must never touch, existing conventions, other tools)? Ask what you need that this list missed.

When you have the answers, show **one summary table** and ask the Owner to confirm or correct it.

## 4. Write the config and apply it

1. Copy the shape of `skeleton.config.example.json` into `skeleton.config.json` and fill it with the confirmed answers. Fields you do not know yet stay empty strings (`d1Id`, `cloudflareAccountId`, `turnstileSiteKey`). `board.url` is the workers.dev address from question 12 (or the custom domain). `board.r2Bucket` stays an empty string unless the Owner wants attachments (then `<slug>-board-files`). `board.defaultProject` stays `main`. For the board names use `workerName`, `d1Name` and `keychainService` derived from the slug (`<slug>-board`).
2. `node tools/setup/apply.mjs --check` (validates the config), then `node tools/setup/apply.mjs --dry-run`, then `node tools/setup/apply.mjs`.
   It replaces the `{{TOKENS}}` in the documents, writes `docs/TEAM.md`, `board/src/agents.ts` and `board/wrangler.jsonc`, creates the member folders (each with `.claude/settings.local.json` holding that member's `BOARD_AS`), updates `.gitignore`, removes the first-run gate from `AGENTS.md`, and replaces `README.md` with the project's own (the kit's README moves to `docs/SKELETON_README.md`). It refuses to run twice; later changes to the team go into the config and then `node tools/setup/apply.mjs --refresh`.

## 5. Link the GitHub repository

1. Look at the remotes: `git remote -v`. If `origin` is the kit's repository, rename it so you can never push to it by accident: `git remote rename origin kit` (it stays available to pull future kit updates).
2. The project repository:
   - If it does not exist and the Owner said yes: `gh repo create <owner>/<repo> --private --source . --remote origin` (use `--public` when chosen). This creates a GitHub repository: you already asked in step 1.3.
   - If it exists: `git remote add origin https://github.com/<owner>/<repo>.git`.
3. Create the labels the review process uses: `sh tools/setup/labels.sh <owner>/<repo>` (it only creates GitHub labels; safe to repeat).
4. Fill the project documents (step 6), then commit with a clear message and push the default branch. The first push publishes the content to that repository: do it only after the Owner confirmed the summary.

## 6. Fill in the project documents

`grep -rn "TODO(first-run)" docs AGENTS.md` lists every place that needs a project fact. Fill `docs/DEVELOPING.md` (how to set up, run and test; the checks), `docs/PROJECT_KNOWLEDGE.md` (the project map, the knowledge sources from question 16) and anything else the grep finds, from the answers and from what the project's code shows. Do not invent facts: where nothing is known write "unknown yet" and add it to the questions for the Owner.

## 7. The board (skip if `board.enabled` is false)

Who does what: **you** run the read-only and project-local commands and ask before each cloud action; **the Owner** runs every command that logs in or creates secrets, in their own terminal.

1. The Owner creates the free Cloudflare account if there is none, picks the workers.dev subdomain in the dashboard (question 12), and runs `npx wrangler login` (a browser opens; this is the Owner's own login). You check with `cd board && npm install && npx wrangler whoami`, and put the account id into `board.cloudflareAccountId` and the final address into `board.url`.
2. With the Owner's yes: `npx wrangler d1 create <d1Name>` (and `npx wrangler r2 bucket create <slug>-board-files` only if the Owner chose attachments); put the database id into `board.d1Id`; run `node tools/setup/apply.mjs --board-only`.
3. Only if the Owner wants the public feedback form: they create a Turnstile widget (hostname = the board host) in the Cloudflare dashboard and tell you its **public** site key; put it in `board.turnstileSiteKey` and run `--board-only` again. The widget's secret key is never given to you.
4. The Owner runs `npm run setup:secrets` once in `board/` (it creates the owner key, one key per team member and the session secret, stores the keys in the macOS Keychain or in key files under `~/.boardkit/<slug>/keys/`, and sets the Worker secrets without printing them). A member on another machine or in a cloud session needs its own key placed there **by the Owner**; you never copy or move a key. Say exactly this to the Owner when it applies.
5. With the Owner's yes: `npm run check && npm test`, `npm run db:remote`, `npm run deploy` (in `board/`).
6. Sign-in: the Owner runs `node board/cli/board.mjs owner-key --copy` in their own terminal and pastes the key into the page at `<board.url>/board/`. You never run that command. Then check as an agent: `BOARD_AS=<lead identity> node tools/board.mjs agents`, name the default project (`node tools/board.mjs projects rename main "<Project Name>"`) and create the first card ("Set up the team", assigned to the Lead).
7. Optional, only if the Owner chose it: deploying from GitHub on every push. The Owner adds the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (repository settings, or `gh secret set` in their own terminal); `docs/BOARD_HOSTING.md` says which token permissions are needed. You never see the values.
8. If the Owner chose to skip the board for now, tell them how to add it later (the same steps, `board.enabled` to `true`).

## 8. Verify and hand over

- [ ] `node tools/setup/apply.mjs --check` passes and `docs/TEAM.md` lists the Owner and every member.
- [ ] Each member folder exists with its `.claude/settings.local.json`.
- [ ] `grep -rn "TODO(first-run)" docs AGENTS.md` shows only things the Owner still has to answer (list them for them).
- [ ] The repository is linked, committed and pushed (with the Owner's yes); `git status` is clean.
- [ ] With a board: `node tools/auto-run/watch.mjs --as <lead identity> --role lead --once` runs and the first card is visible on the board.

Then tell the Owner, in their language and briefly: what was created and where, the board address, what is still open (secrets they must create, members still to start), and how to start each other member: open that member's folder in its tool and tell it "Read `AGENTS.md`, then `docs/onboarding/onboarding-new-member-dev.md` (or `-qa.md`), and listen to the board". Finally explain the two modes (`docs/CONSTITUTION.md`, section 6) and that the Owner starts either one with their own words.

From now on follow `AGENTS.md`.
