# Role: Owner

This file is for {{OWNER_NAME}}, the person who owns {{PROJECT_NAME}}. You are the only human role. The agents work for you; this file
says what you decide, what you do not have to do, and how to talk to them. Role definitions for the agents are in
`docs/roles/lead.md`, `docs/roles/developer.md` and `docs/roles/qa.md`; the rules everyone follows are in `docs/CONSTITUTION.md`.

## What you decide

- What is built and in what order: you write the cards, put the ones you want worked on in To do, and set their priority. The top of
  To do is the first to be done. Priority is Blocker > Critical > Major > Minor and your value always wins.
- Which cards you move and when (backlog to To do is your go; done, QA later and sending a failed card back are yours alone): `docs/BOARD_WORKFLOW.md`.
- Every product question. Agents ask with a recommendation, as a comment on the card (not in the chat); answer on the card, "yes, as recommended" is a complete answer. The board page and `node tools/board.mjs inbox` show what is waiting for you.
- When to release or deploy. Nobody ships on their own. You say it in your own words, and the Lead does it.
- Which agent holds which role. You tell each agent its role when you start its session, and you can change it any time.
- Standing words: permissions you give once for a recurring case (for example, "deploy board changes yourself once they are tested and
  merged"). Only the ones the Lead has written in `docs/CONSTITUTION.md` section 3 exist.
- The words that start the two modes: "duty mode" while you are around, "auto-run mode" while you are away (or other words you choose;
  tell the Lead and it writes them into the constitution).

## What you do

- Write cards and move them: your own cards are yours alone. You move cards to To do (go), to Backlog (parked) and to Done (tested), and
  you move a card to QA later when you cannot test it yet. If a test fails, comment what to change and move the card to In progress:
  the Lead hands it round again.
- Test what the agents deliver, in the real environment, using the steps on the card.
- Read the Lead's reports and answer the questions in them.
- Put keys and other credentials on machines yourself. Agents never ask you for one and never handle one. If an agent asks, say no and
  tell the Lead.

## What you do not have to do

You do not have to merge, review code, assign work, move cards through review statuses, write test steps or keep documents current. A
card you closed stays closed: nobody asks about it again, and you reopen it yourself if something is still wrong.

## How to talk to the agents

- Start every agent session with one sentence: "You are <Name>, role <Lead|Developer|QA>, board name <identity>. Read `AGENTS.md` and
  `docs/roles/<role>.md`." The Lead adds the folder path and the key placement for a new member (`docs/onboarding/README.md`).
- Write requirements as you would to a colleague: the outcome, not the steps. Your words on the card are the requirement. The Lead does
  not rewrite them, and a Developer builds the simplest reading and tells you which reading it took. You refine by adding words on the
  card.
- Expect short answers in {{REPLY_LANGUAGE}}, with times in {{TIMEZONE}}, result first. Numbers always come with titles:
  `PR #12 - #34 - Fix login redirect`, `#34 - Fix login redirect`. If an answer is long or has a bare number, tell the agent.
- Expect few questions. Agents decide small things and report them; they ask only about irreversible choices or when your words give
  opposite results. If they ask too much, say "decide yourself and tell me".
- To start a batch of work and leave, say "auto-run mode". You get a report when it ends. To stop a mode, say stop.
- A card that is not clear is not held for you: the Lead hands it out on the simplest reading and says which reading it took; you correct it when testing. The Lead asks you on the card only when the readings give opposite results and a wrong pick would waste a large piece of work.
- The agents listen to the board all the time and never ask whether to keep listening: say "stop listening" when you want them to stop.

## What you can ask for at any time

- A status report: what is merged, in review, stuck, waiting for you.
- The list of pending tests (what is released or deployed and waits for your test).
- A change to a rule: say it and the Lead writes it into `docs/CONSTITUTION.md` (sections 1 to 3 change only with your word).
- A new member: give the Lead its name and its role. The Lead sets it up (`docs/onboarding/README.md`) and tells you where to put its key.

## Checklist

1. Cards in To do are in the order you want, with priorities where you care.
2. You have said which agent has which role (see `docs/TEAM.md`).
3. For every release: say the word, then test the cards in On Prod for QA and move them to Done.
4. Never paste a key into a chat or a file; ask the Lead for the safe way.
