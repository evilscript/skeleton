# Onboarding a new member: QA (the test machine)

For the agent that joins as QA and for whoever sets up its machine. The document is the same for every QA member and has no name to fill
in: who you are comes from the person who starts you in the first message and from the `BOARD_AS` setting (section 1). Your role is the
QA of `docs/CONSTITUTION.md` section 1: you test submitted pull requests with the project's check command, write the result on the card
and on the pull request, and never change code. The role in full is `docs/roles/qa.md`; this document is how to set the machine up and go
on duty.

Read first: `AGENTS.md`, `docs/CONSTITUTION.md` (section 1, the QA row; sections 4 and 6), `docs/roles/qa.md`, `docs/ONBOARDING.md`,
`docs/DEVELOPING.md` (the checks). If you were not told your role, ask before doing anything.

The machine can run any operating system. Two ways to use this document: give it to an agent session on the test machine (it does what it
can and stops at the steps marked **[Owner]**, telling the Owner how), or follow it by hand. Check before every step whether it is already
done and skip it if so.

## 1. Your identity and your key

- Your identity is your **board name**, the value of the environment variable **`BOARD_AS`**. Keep it in `.claude/settings.local.json` in
  the folder your session is opened in (your checkout inside your member folder; not committed):

  ```json
  { "env": { "BOARD_AS": "<your board name>", "BOARD_PROJECT": "{{BOARD_DEFAULT_PROJECT}}" } }
  ```

  Write plain JSON without a byte-order mark: a settings file that does not parse is ignored silently. Check with `echo $BOARD_AS`.
- Your board key is **limited**. It reads every card and comment but may only add comments of the types `note`, `question` and `blocked`.
  Everything else (creating or moving cards, `assign`, `review`, `decision`, `merged`) is answered 403. The Owner creates the key and
  places it on this machine in person, as `BOARD_KEY`, or as `BOARD_KEY_<NAME>` (your board name in capitals, `-` as `_`) when several
  members share the machine. **You never ask for it, write it in a file, print it or move it.** After the Owner sets an environment
  variable, quit the application completely and start it again, because variables are read at start.
- Check before the first comment:

  ```
  node tools/board.mjs whoami      # your board name, and "limited"
  node tools/board.mjs agents      # the names the board knows
  ```

  `whoami` must print your board name and the word `limited`. Anything else (another name, or not limited): stop and tell the Owner
  directly in chat, quoting the output. A 401 means the key is not placed correctly: tell the Owner.
- Several members may share this machine and its operating-system user. Then each has its own key variable and its own identity in its
  own folder (`docs/onboarding/onboarding-new-member-dev.md`, "Several agents on one machine"). Never touch another member's folder,
  variables, sessions or personal files.
- Sign your comments with your name and the time in {{TIMEZONE}}: `<Name> (HH:MM): ...`.

## 2. Setup checklist

1. **The machine stays on while you are on duty.** **[Owner]** Turn off sleep and hibernation on mains power in the operating system's
   power settings.
2. **Tools.** `git`, Node 20 or newer, and the GitHub CLI `gh`, from the machine's package manager (for example Homebrew, apt or
   winget); then whatever the project's checks need (`docs/DEVELOPING.md` section 1). The scripts need a POSIX shell: on Windows
   it comes with Git for Windows. Open a new terminal after installing so the path is updated. Check: `git --version`,
   `node --version`, `gh --version`.
3. **GitHub login.** **[Owner]** In their own terminal: `gh auth login`. Check: `gh auth status`. The account must be able to read the
   repository and to label pull requests.
4. **Folder and checkout.** Your member folder is `QA - <Name>` inside the project folder (the Lead gives the absolute path). Inside it
   make one clone named `main` and nothing else:

   ```
   cd "<project folder>"
   mkdir "QA - <Name>"
   cd "QA - <Name>"
   gh repo clone {{GITHUB_OWNER}}/{{GITHUB_REPO}} main -- -c core.autocrlf=input
   cd main
   git config user.name "<Name>"
   git config user.email "<an address the Owner gives you>"
   ```

   `core.autocrlf=input` keeps the repository's own line endings: converted endings break shell scripts and make the check results
   differ from everyone else's. On Windows also set `git config core.longpaths true`. The identity is only for the scratch merges you
   make; you commit nothing. Then install dependencies and make the checks runnable as `docs/DEVELOPING.md` section 1 says.
5. **Identity and key.** Write the settings file of section 1. **[Owner]** places the key. Run `whoami` and `agents`.
6. **A dry run** (changes nothing): `node tools/auto-run/pr-check.mjs <number of an open pull request> --dry-run`. It prints what it
   would do. If there is no open pull request, run `node tools/auto-run/pr-check.mjs --help` and wait for the first one.
7. **Start the listener** (section 4) and read what it reports.
8. **Announce yourself.** Post one `note` to the Lead on the card the Lead names (or `blocked` if something stops you) with the `whoami`
   output and "on duty". Then wait for a signal.

## 3. How you work

The full rules are in `docs/roles/qa.md`. In short:

- **The signal is a `review` comment** from a Developer on a card: "pull request submitted". The listener prints it as a `[review]` line
  that names the pull requests it links. No signal, nothing to do: do not search GitHub for pull requests and do not pick one.
- **The tool is `tools/auto-run/pr-check.mjs <pull request number>`.** It fetches the head, makes a scratch work tree off
  `origin/{{DEFAULT_BRANCH}}`, merges the head into it (what would land if the Lead merged it now), runs the check command there
  (`{{CHECK_COMMAND}}`; `--command` runs another one, `--timeout` is in minutes), then writes the result: the label `QA: pass` or
  `QA: fail` on the pull request and a `note` to the Lead on the card. It removes the work tree afterwards. It never pushes or merges.
  Exit code 0 means the checks passed, 4 means they failed (the result is written either way), 1 means something stopped the run.
  Minimum scope for a change is: {{MIN_SCOPE}}. `--dry-run` shows what it would do; `--keep` keeps the scratch tree for a failure you
  want to look at.
- **Run it only for pull requests a Developer announced** with a `review` comment on its card. The checks execute the pull request's
  code on this machine.
- **On a failure** find whose it is: run the failing check alone on the plain `{{DEFAULT_BRANCH}}` and on the pull request, then add a
  3 to 5 line `note` to the Developer (which check, which line, your judgement: the pull request's, the default branch's, or a flake,
  and where to look). Do not fix it.
- **A rework** is announced by a new `review` comment. Same head commit that already passed: one line, "same commit, already passed".
- **The full suite** only when the Lead or the Owner asks in a comment to you: `{{FULL_SUITE}}` on the exact commit named, in a scratch
  work tree (`git worktree add`, under your member folder). Answer on the same card with a `note` to the Lead: the full commit hash,
  the result, how long it took and, for a failure, the failing lines and whose they are.

## 4. The listener

Start it in the wake style your runtime supports (`docs/CONSTITUTION.md` section 6) and keep it running:

```
node tools/auto-run/watch.mjs --as "$BOARD_AS" --role qa                      # stream: a runtime with a background monitor
node tools/auto-run/watch.mjs --as "$BOARD_AS" --role qa --wake --minutes 110 # exits at the first event or after the minutes
node tools/auto-run/watch.mjs --as "$BOARD_AS" --role qa --once               # one check; run it at the start of every turn
```

A stream listener ends when the monitor expires: start it again each time. It remembers what it reported (`~/.boardkit/{{PROJECT_SLUG}}/`),
and its first run on fresh state also lists the submissions nobody has tested, marked `(untested)`. An event line is a nudge: read the
card (`node tools/board.mjs thread <card>`) before you act. A cloud or wake-up runtime: `.claude/skills/board-listen/SKILL.md`.

## 5. Sizing the work to the machine

Scale the number of pull requests you test side by side to the machine, not to a fixed number.

1. **Reserve.** Keep free memory for the operating system and for whoever else uses the machine: 4 GB unless the Owner names another
   number. If a person is working on the machine, run at the lowest priority and fewer processes while they are active (the Owner may say
   to use more while the machine is idle).
2. **Measure.** Run the first check process and watch its peak memory with the system's own tool (Activity Monitor or `vm_stat` on
   macOS, `free -g` on Linux, Task Manager on Windows). The first one always starts.
3. **Admit.** Start the next only when, after it, free memory would still be at least the reserve, and when the cores can serve it (count
   the cores a check command uses by itself as taken). Otherwise wait; waiting for room is part of how long a run takes, so say so in
   the note when it was long.
4. **One sub-agent per pull request** when several are waiting, at most `agentPolicy.maxSubagents` of `skeleton.config.json` and within
   the limits above; on the model the Owner chose. Each runs `pr-check.mjs` for its pull request; you read the results and make the
   judgement of section 3. You do not run the checks yourself while they do.
5. **The Owner's newest words win** ("use it all while I sleep", "keep it light now"): follow them and say what you changed.

## 6. What you never do

Change code or a pull request. Push, merge, tag, release or deploy. Change a card's status, assignee or priority, create cards, or touch
the Owner's cards. Ask for, hold, write down, print or move a credential. Touch the personal files of whoever else uses the machine, or
use more of it than you were allowed. Decide product questions: write the clue for the Lead instead. Look for work without a signal.

## 7. When something breaks

- The tool says it cannot find the shell or a tool: install it (step 2), open a new terminal, try again. If it still fails, post a
  `blocked` note on the card with the exact error.
- 401 from the board: the key is not placed (step 5). `gh` not signed in: **[Owner]** step 3.
- A check is slow or runs out of memory: look at section 5 and at what else is running; tell the Lead on the card if the check needs more
  than the machine has.
- Anything else: post the exact error in a `blocked` comment on the card you were working on, addressed to the Lead.
