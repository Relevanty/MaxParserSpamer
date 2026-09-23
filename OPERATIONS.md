# Operations

What was built during the 4–6 Aug 2026 work, how to run it, and the rules that
keep the account alive. Read the safety rules before running anything that sends.

---

## Safety rules

These are not style preferences. Each one exists because breaking it caused a
real failure.

1. **Never message anyone on `lists/0-do-not-contact.txt`.** Twelve people have
   explicitly declined. Re-pitching a decline is what got the account
   moderation-limited on 4 Aug. `follow-up.js` and `auto-reply.js` both check
   this file at send time — it cannot be overridden by a drafts file.
2. **Never send a second message into silence.** If someone did not reply, wait.
   Volume into non-responders is what accumulates PEER_FLOOD.
3. **One number only: 40 active members.** Thirty, forty and fifty were all in
   flight simultaneously to real prospects and earned a «Я тебе не верю».
4. **One sender at a time.** The run lock enforces this; do not delete
   `storage/sender.lock` while a run is live.
5. **On PEER_FLOOD, stop.** The flood guard now backs off for 10 minutes even
   when @SpamBot says the account is fine — SpamBot cannot see the
   non-contact messaging cap, and charging back in makes the limit worse.

---

## What sends, and when

| Component | What it does | Runs |
|---|---|---|
| `src/index.js` (`runSender`) | Cold outreach — forwards Saved Messages to a list | Scheduled task `Relevanty Send` |
| `src/follow-up.js` | Replies to people who wrote to us, from a drafts file | Manual, or task `Relevanty FollowUp` |
| `src/auto-reply.js` | The three-question funnel — fixed script, no model | Manual, one pass or `--live` |
| `src/watch-replies.js` | Alerts Saved Messages when a lead goes warm | Long-running process |

**Current state: all four are stopped.** Both scheduled tasks are `Disabled`,
no processes are running. Nothing resumes on its own.

### Resuming

```powershell
Enable-ScheduledTask -TaskName 'Relevanty FollowUp'   # nightly replies, cap 10
Enable-ScheduledTask -TaskName 'Relevanty Send'       # cold outreach
```

```bash
node src/follow-up.js --send --cap=25    # one batch of replies now
node src/follow-up.js --cap=25           # dry run — always do this first
node src/auto-reply.js --cap=10          # dry run the funnel over unread
node src/auto-reply.js --send --cap=10   # one pass, then exit
node src/auto-reply.js --send --live     # stay up, answer as replies land
node src/auto-reply.js --cap=10 --track  # dry run + live dashboard, no sends
node src/watch-replies.js                # start the alert watcher
```

### Running the funnel from the menu

The funnel is two halves, and both are in the UI now:

| Half | Where | What it does |
|---|---|---|
| **Opener** | `run.bat` → Sender — Telegram → source → **Воронка (3 вопроса)** | Cold sends question 1 and nothing else. No intro, no pitch, no forwarded Saved Messages. |
| **Answers** | Toolkit → **Воронка (ответы)** | Walks whoever replied through questions 2 and 3, sends the farewell or the invite. Dry run / one pass / live. |

The opener rides the existing text-sequence path, so scheduling, the flood
guard, the daily cap, archiving and the report row all behave exactly as they do
for any other source — only the text differs. It does **not** consume Saved
Messages, so nothing has to be pasted there for the funnel to work.

Answers are not tracked in a state file: the runner reads the chat history and
recognises which of the three questions it already sent. So the two halves need
no coordination, a restart cannot re-ask, and you can run the answer side by
hand whenever — `node src/auto-reply.js --send --live`.

### The funnel

`auto-reply.js` runs one fixed script. There is no model in the loop and no
`ANTHROPIC_API_KEY` — the wording is fixed, so it cannot invent a community
size, and the old fact whitelist went away with it.

```
Q1  Ты понимаешь почему до 30 надо накопить большое количество полезных связей?
     нет → farewell            да → Q2  У нас налажен уже процесс, хочешь с нами?
                                          нет → farewell   да → Q3  ...отвечаешь за свои слова?
                                                                      нет → farewell
                                                                      да  → invite
```

**The only accepted answers are `ДА`, `ДА КОНЕЧНО`, `ЕЩЕ БЫ`** (case, ё and
trailing punctuation or emoji are ignored; a `?` anywhere is never a yes).
Everything else — a нет, "надо подумать", a question back, "не смогу каждый
день" — gets the farewell line and the conversation is closed. Nothing is
explained and nothing is re-pitched. A closed chat is never written to again,
and closures are logged to `reports/funnel-review.jsonl` so you can decide who
goes on the denylist.

The stage lives in the chat history, not a state file: the runner reads back
which questions it already sent, so a restart cannot re-ask or double-send.

**Invites are not generated.** The last step takes the first unused link from
`reports/invite-links.txt` and comments that line out. With the pool empty,
someone who said да three times is written to `reports/funnel-review.jsonl` and
sent nothing — refill the file, or set `RELEVANTY_INVITE_LINK` in `.env`.

### Denylist guard

`lists/0-do-not-contact.txt` is the only thing standing between a run and
re-pitching someone who declined, and it used to be a plain text file nothing
watched. It is now checked on every run: the entry count is remembered in
`storage/denylist-state.json`, and **if the list has lost entries, a sending run
refuses to start** (exit 1) rather than messaging people who may have declined.

- A dry run always proceeds — the guard stops messages, not inspection.
- A deliberate removal: re-run with `--allow-denylist-shrink`.
- It also warns about sync-conflict copies (`0-do-not-contact (conflicted copy).txt`),
  whose entries are **not** honoured by anything.

This applies to `follow-up.js` too, which the scheduled task **Relevanty
FollowUp** runs with `--send`: if the list ever shrinks, that task now exits 1
and sends nothing until you look at it.

### Live tracker

`--live` and `--track` serve a WebSocket dashboard on
**http://localhost:8787** (`RELEVANTY_FUNNEL_PORT` to move it): how many got Q1,
who is waiting, who was closed and why, invites issued. It pushes each step as
it happens and replays a snapshot to a tab opened late. The page is read-only —
nothing a browser sends can make the sender write to Telegram. Every event is
also appended to `reports/funnel-events.jsonl`, so a headless run keeps the
same trace.

The board holds other people's handles and messages, so the port is locked down
four ways. **Use the URL the runner prints** — it carries a fresh token and a
bare `localhost:8787` returns 403.

| Guard | Stops |
|---|---|
| Binds `127.0.0.1` only | Anyone on the same wifi reading the board. `listen(port)` alone binds `0.0.0.0` **and** `::`. |
| Per-run token in the URL | Another process or user account on this machine. |
| `Origin` check on the WS handshake | A random site you have open dialling `ws://localhost:8787` — WebSockets are exempt from same-origin policy, so this is not theoretical. |
| `Host` check (421) | DNS rebinding: a hostile domain repointed at 127.0.0.1. |

`RELEVANTY_FUNNEL_HOST` widens the binding if you ever need the board on another
machine; it logs a warning when you do, and the token becomes the only thing
protecting it — prefer an SSH tunnel.

`--live` reacts to messages as they arrive instead of polling unread dialogs,
which is the right shape when the answer you are waiting for is one word.

### Schedule

`Relevanty Send` fires 04:00 and 19:00 AEST = **21:00 and 12:00 MSK**. Those are
the two windows the data supports: 12/13/21 MSK reach agreement at 18.0% against
9.5% everywhere else (z=3.71). The old 23:00/10:00 slots were not.

`Spam scheduler` is a dead task pointing at a path that no longer exists. Delete
it from an **elevated** prompt: `schtasks /Delete /TN "Spam scheduler" /F`

---

## Data files

| File | What it is |
|---|---|
| `report.csv` | Every send attempt. Status is the **last** column — arity varies (5 or 6 fields) because `Template` was added mid-life. |
| `storage/conversations.json` | Collected conversations. ~5,500 entries, `collectorVersion` 5. |
| `lists/0-do-not-contact.txt` | Declined. Never contact. |
| `reports/followup-drafts.json` | Hand-written replies, keyed by handle. `_`-prefixed keys are notes, not recipients. |
| `reports/scenarios.json` | 19 measured conversation branches. **No longer read by anything** — kept as analysis of how replies used to go. |
| `reports/invite-links.txt` | Invite pool for the funnel's last step. One per line; used lines are commented out with a timestamp. |
| `reports/funnel-review.jsonl` | Closed conversations (farewell sent) and anyone stuck waiting on an invite link. |
| `reports/funnel-events.jsonl` | Every funnel step, the same rows the live dashboard shows. |
| `messages/FINAL-TEMPLATES.md` | The three cold openers. **Not yet pasted into Saved Messages.** |

---

## Analytics

```bash
npm run collect     # sweep conversations from Telegram (~45 min for 3,300 dialogs)
npm run report      # dashboard at localhost:3001
```

Published report: https://claude.ai/code/artifact/e1070e1a-1681-4ad8-8477-79b4bac7e9d0

`RELEVANTY_COLLECT_SCOPE=campaign` narrows collection to delivered recipients;
the default `all` sweeps every dialog including the archive folder.

---

## Tests

```bash
node --test test/follow-up.test.mjs
```

Covers the two decisions that determine whether a real person gets a message:
the denylist, and the "did they write last" guard.

---

## Known-good facts

Everything below is verified. Anything not on this list should not be stated to
a prospect.

- Max, 20, Melbourne. Electrical engineering at Melbourne University;
  works as a frontend developer.
- 40 active members. Free — некоммерческий товарищеский коллектив.
- Discord, daily calls at 21:30 MSK. Discord access **only after** a call.
- Intro call is 20–30 minutes, camera optional.
- ~1,200 intro calls conducted to date.
- People are found in the Кейс-чемпионаты (Changellenge) group.

---

## Open items

- **Teammate collection.** Twelve teammate handles were detected; their accounts
  are never swept. The analyser sees 74 completed calls against a reported
  ~1,200, so most conversion is invisible. Needs their session strings.
- **Paste the openers** from `messages/FINAL-TEMPLATES.md` into Saved Messages,
  then set `maximIntervals: "1-2-2"`. Check the printed groups before the first
  run — the pool is sliced from the newest end, so one stray note shifts every
  boundary.
- **July is unrecoverable.** 97% of July's 970 sends produced no conversation.
  The same peer cap that blocked every send on 5 Aug was almost certainly
  throttling it. No amount of collecting brings that back.
