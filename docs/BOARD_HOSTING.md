# Where the board lives

The board is a small program (a Cloudflare Worker with a database) in `board/`. It runs on **your own Cloudflare account**, so the cards, comments and keys stay yours and nobody else hosts anything for you. A free Cloudflare account is **required**: it is the one account you create yourself; the agent does the rest.

## The address

| You have | The board address | Cost |
|---|---|---|
| nothing but an email address (the default) | `https://<worker name>.<your workers.dev name>.workers.dev` | free |
| a domain whose DNS is on Cloudflare | `https://board.<your domain>` (set `board.url` to it) | free (the domain is yours) |

No domain is needed. The `<worker name>` is `board.workerName` in `skeleton.config.json`. The `<your workers.dev name>` is the free name of your Cloudflare account. The first deploy registers it for you (named after the project, `board.workersDevName`); the agent reads the real address from the deploy output and stores it with `node tools/setup/apply.mjs --set-board-url <address>`. Only if the automatic registration does not work, the agent sends you once to `https://dash.cloudflare.com/<account id>/workers/onboarding` to type a name.

## Who does what, once

| Step | Who |
|---|---|
| Create the free Cloudflare account (https://dash.cloudflare.com/sign-up: email, password, confirm the email; no card, no domain) | **you** |
| `npx wrangler login` in your own terminal (a browser opens, you approve) | **you** |
| `npm run setup:secrets` in your own terminal: you choose the board password at a hidden prompt (at least 12 characters, typed twice) | **you** |
| Sign in to the board page with that password | **you** |
| Everything else: install, create the database, write the configuration, tests, database migrations, deploy, check the agents' access, create the first card | the agent (one yes from you for the whole block) |
| Optional: one repository secret so pushes deploy by themselves | **you**, see below |

## Where card files are kept

Screenshots and attachments need a place to live. Choose one in the first-run questionnaire (`board.fileStorage` in `skeleton.config.json`):

| Mode | What it is | Cost and setup | Limits |
|---|---|---|---|
| `d1` (recommended) | in the board's own database | free, nothing extra to create, no card | small files: about 1.5 MB each; images are shrunk in the browser before upload |
| `r2` | a Cloudflare R2 bucket | needs a payment card on the account even for free-tier use (reported by users; check Cloudflare's billing page), and one extra bucket | large files |
| `none` | nowhere | nothing | the board works; the screenshot and attachment parts are hidden |

Switching modes later does not move files that already exist (files kept in `d1` stay in the database until you delete them). On the free plan a database holds 500 MB and `d1` files count against it, and a database backup includes them; if you expect many large attachments, choose `r2`.

## Language of the pages

The board's web pages come in English (`en`) and Simplified Chinese (`zh-CN`). Another language is one translated file: copy `board/public/i18n/en.json` to `board/public/i18n/<code>.json`, translate the values (an agent can do it), and set `languages.boardPages` to the code in `skeleton.config.json`. The command line stays English: it is the agents' protocol.

## Deploying from GitHub

`.github/workflows/board-deploy.yml` deploys the board whenever `board/` changes on the default branch, and on demand. It needs **one** repository secret, which you add in your own terminal so no agent sees it:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/<repo>
```

The token is made in the Cloudflare dashboard (My Profile, API Tokens, Create Token, template "Edit Cloudflare Workers", limited to your account). Check that it has Account > D1 > Edit (add it if the template lacks it) and, if the files are in R2, Workers R2 Storage > Edit. The account id is not a secret: it is read from `board/wrangler.jsonc`.

Without the secret the workflow does nothing. The first deploy and the Worker's own secrets (`npm run setup:secrets`) are always done once by you: GitHub never sees the board's keys or your password. A push that changes a database migration stops the workflow on purpose: back the database up first (`board/docs/MAINTENANCE.md`), then run the workflow by hand with "migrate" ticked.

## Signing in

There is no third-party login. You sign in to the board page with the **password** you chose during setup. It is stored nowhere on your machine, only you know it. After 5 wrong tries from one place the page pauses sign-in from there for 15 minutes (if you lock yourself out, `npx wrangler d1 execute DB --remote --command "DELETE FROM sign_in_attempts"` in `board/` clears it). A forgotten password is replaced with `npm run setup:secrets -- --password-only` in `board/` (it also ends every open session). Agents never sign in to the page; each has its own key and uses the command line. Cards come only from you and the agents: the board has no public intake form.

## Why not GitHub Pages

GitHub Pages serves static files only. The board needs a database and an API (cards, comments, keys), so it cannot run there. A read-only copy of the board on GitHub Pages is possible to build, but it is not part of the kit.

## If a team cannot use Cloudflare

The kit does not support another host yet, so it cannot be set up without a Cloudflare account. The board is the only part that needs a server: the roles, the constitution and the scripts work with any board that offers the same commands. A board built on GitHub Issues would need no account besides GitHub; it is not built.
