// Funnel runner (was: the Claude-drafted replier).
//
// The script is now fixed, so there is nothing to draft and no model in the
// loop. Three questions, one farewell line, an invite at the end — see
// funnel.js for the decision table. That removes the whole class of risk the
// old version needed guardrails for: a fixed string cannot invent a community
// size, so the fact whitelist, needs_human escalation and scenarios.json
// playbook are all gone with it.
//
// What is kept, because it protects the account rather than the wording:
//   1. Denylist — never contact anyone who declined. Checked before anything else.
//   2. Never reply twice — if the last message in the chat is ours, wait.
//   3. Never re-open a closed conversation — the farewell is final, and a chat
//      that already has an invite in it is done.
//   4. Dry run unless --send. Hard cap per run. Stops on the first FLOOD.
//
// Two modes:
//   node src/auto-reply.js --cap=25             dry run over unread dialogs
//   node src/auto-reply.js --send --cap=25      one pass, then exit
//   node src/auto-reply.js --send --live        stay up, react as answers land
//   ... --track                                 serve the live dashboard (ws)
import "dotenv/config";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NewMessage } from "telegram/events/index.js";
import { PATHS, RATE_LIMITS } from "./config.js";
import { validateEnv, startClient, getErrorMessage } from "./auth.js";
import { appendReportRow } from "./report.js";
import { acquireRunLock } from "./run-lock.js";
import { sleep, normalizeUsername } from "./utils.js";
import { nextStep, sliceChars, STEP, FAREWELL } from "./funnel.js";
import { loadDenylist, reportDenylist } from "./denylist.js";
import { loadScenarios } from "./scenarios.js";
import { mark, summarize } from "./funnel-marks.js";
import { trackEvent, startTracker, stopTracker } from "./funnel-ws.js";

const REVIEW_QUEUE = path.resolve("reports", "funnel-review.jsonl");
const INVITE_POOL = path.resolve("reports", "invite-links.txt");
const INVITE_USED = path.resolve("reports", "invite-used.jsonl");
const DEFAULT_CAP = 10;
const HISTORY_LIMIT = 40;

// Invite links are single-use in practice — every one in the corpus is
// different. The pool is a plain text file, one link per line; a used line is
// commented out rather than deleted so the file stays an audit trail. Returns
// null when the pool is empty: we queue for a human instead of inventing a link
// or sending the same one twice.
async function takeInviteLink() {
  const fromEnv = String(process.env.RELEVANTY_INVITE_LINK ?? "").trim();
  let lines;
  try {
    lines = (await readFile(INVITE_POOL, "utf8")).split(/\r?\n/);
  } catch {
    return fromEnv || null;
  }
  const i = lines.findIndex(l => l.trim() && !l.trim().startsWith("#"));
  if (i === -1) return fromEnv || null;
  const link = lines[i].trim();
  lines[i] = `# used ${new Date().toISOString()} ${link}`;
  await writeFile(INVITE_POOL, lines.join("\n"), "utf8");
  return link;
}

async function queue(file, row) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n", "utf8");
}

// Conversation history, oldest first, split into what we said and what they
// said. sliceChars (not slice) so an emoji at the cut does not become a lone
// surrogate in the log or the dashboard payload.
async function historyOf(client, entity) {
  const raw = await client.getMessages(entity, { limit: HISTORY_LIMIT }).catch(() => []);
  const sorted = [...raw].sort((a, b) => Number(a.date) - Number(b.date))
    .filter(m => m.message?.trim())
    .map(m => ({ out: !!m.out, text: sliceChars(m.message.replace(/\s+/g, " ").trim(), 400) }));
  const outbound = sorted.filter(m => m.out).map(m => m.text);
  const last = sorted[sorted.length - 1] ?? null;
  return { outbound, lastInbound: last && !last.out ? last.text : null, empty: !sorted.length };
}

/**
 * Decide and (optionally) send one step for one person. Pure-ish: every write
 * goes through the client, the report and the tracker, and it never loops.
 */
async function stepOne(client, { handle, entity }, { send, deny, scenarios }) {
  if (deny.has(handle.replace(/^@/, ""))) {
    await trackEvent({ handle, step: "skip", reason: "denylist", sent: false });
    return "skipped";
  }

  const { outbound, lastInbound, empty } = await historyOf(client, entity);
  if (empty) {
    await trackEvent({ handle, step: "skip", reason: "no messages", sent: false });
    return "skipped";
  }

  const decision = nextStep({ outbound, lastInbound, scenarios });
  // Marked before anything is sent, so a person is scored even when the send
  // fails or this is a dry run.
  const marked = await mark(handle, decision);
  const base = {
    handle, stage: decision.stage, answer: decision.answer,
    reason: decision.reason, inbound: lastInbound ? sliceChars(lastInbound, 160) : null,
    score: decision.score ?? null, conviction: marked.conviction ?? null,
    branch: decision.branch ?? null, tags: marked.tags,
  };

  if (decision.step === STEP.DONE || decision.step === STEP.WAIT) {
    await trackEvent({ ...base, step: decision.step, sent: false });
    return "skipped";
  }

  // Nothing in the playbook matched. Queue it — improvising here is exactly the
  // risk the fixed script removed.
  if (decision.step === STEP.HUMAN) {
    await queue(REVIEW_QUEUE, { handle, reason: decision.reason, lastInbound, conviction: marked.conviction });
    await trackEvent({ ...base, step: STEP.HUMAN, sent: false });
    console.log(`  HUMAN ${handle} — ${decision.reason}  (${summarize(marked)})`);
    return "queued";
  }

  // Resolve the outgoing text. The invite is the only step that can fail to
  // produce one.
  let text = decision.text;
  if (decision.step === STEP.INVITE) {
    text = send ? await takeInviteLink() : "<invite link>";
    if (!text) {
      await queue(REVIEW_QUEUE, { handle, reason: "invite pool empty — three yes, needs a link", lastInbound });
      await trackEvent({ ...base, step: "error", reason: "no invite link", sent: false });
      console.log(`  NEEDS LINK ${handle} — said да three times, invite pool is empty`);
      return "queued";
    }
  }

  if (!send) {
    await trackEvent({ ...base, step: decision.step, outbound: text, sent: false });
    console.log(`  DRY  ${handle} [${decision.step} ${decision.stage}/3 ${summarize(marked)}]`
      + (lastInbound ? `\n       in : ${sliceChars(lastInbound, 70)}` : "")
      + `\n       out: ${sliceChars(text, 90)}`);
    return "acted";
  }

  try {
    await client.sendMessage(entity, { message: text });
  } catch (err) {
    const msg = getErrorMessage(err);
    await trackEvent({ ...base, step: "error", reason: msg, sent: false });
    console.log(`  FAIL ${handle} — ${msg}`);
    return /FLOOD/i.test(msg) ? "flood" : "failed";
  }

  await appendReportRow(PATHS.REPORT_CSV, {
    timestamp: new Date().toISOString().replace("T", " ").slice(0, 19),
    user: normalizeUsername(handle), mode: "Funnel",
    messageCount: 1,
    template: `funnel:${decision.step}${decision.step === STEP.ASK ? decision.stage : ""}` + (decision.score != null ? `:q${decision.stage}=${decision.score}` : "") + (decision.branch ? `:${decision.branch}` : ""),
    status: "Success",
  });
  await trackEvent({ ...base, step: decision.step, outbound: text, sent: true });

  if (decision.step === STEP.INVITE) await queue(INVITE_USED, { handle, link: text });
  if (decision.step === STEP.HANDOFF) {
    await queue(REVIEW_QUEUE, {
      handle, reason: `HANDOFF ${decision.branch}: ${decision.action ?? "a human takes this today"}`,
      lastInbound, conviction: marked.conviction,
    });
    console.log(`  → HANDOFF ${handle} — ${decision.action ?? decision.branch}`);
  }
  // A farewell closes the conversation for good. Surfacing it for the denylist
  // is the one manual follow-up left: the operator decides who gets added.
  if (decision.step === STEP.FAREWELL) {
    await queue(REVIEW_QUEUE, { handle, reason: `closed: ${decision.reason}`, lastInbound, consider: "denylist" });
  }

  console.log(`  SENT ${handle} [${decision.step} ${decision.stage}/3 ${summarize(marked)}] ${sliceChars(text, 60)}`);
  return "acted";
}

// ── One pass over unread dialogs ──────────────────────────────────────────────

export async function runAutoReply({ send = false, cap = DEFAULT_CAP, track = false, allowShrink = false, only = null } = {}) {
  const list = await loadDenylist({ send, allowShrink });
  if (!reportDenylist(list)) process.exit(1);
  const deny = list.deny;
  const scenarios = await loadScenarios();
  console.log(`Playbook: ${Object.keys(scenarios.branches).length} known scenarios loaded.`);
  if (track) await startTracker({ open: true });

  const lock = await acquireRunLock(PATHS.RUN_LOCK, { label: "funnel" });
  if (!lock.ok) { console.error(`Locked: ${lock.reason}`); process.exit(1); }

  const { apiId, apiHash, forceSms, authMethod } = validateEnv();
  const tg = await startClient(apiId, apiHash, forceSms, authMethod);
  let acted = 0, queued = 0, skipped = 0;

  try {
    // Unread dialogs where they spoke last — the exact set nobody has answered.
    const targets = [];
    for (const archived of [false, true]) {
      for (const d of await tg.getDialogs({ limit: undefined, archived })) {
        // Normally only unread dialogs are candidates — an unread badge is what
        // marks "nobody has answered this". But opening the chat yourself clears
        // it, and then the funnel would never reply. When you name someone with
        // --only, read state is ignored and nextStep decides from the history.
        if (!d?.isUser) continue;
        if (!only && !(d.unreadCount > 0)) continue;
        const e = d.entity;
        if (!e || e.bot) continue;
        if (!only && d.message?.out) continue;
        const handle = e.username ? `@${e.username.toLowerCase()}` : `id:${e.id}`;
        // --only answers one person instead of the whole unread backlog. Matches
        // the @handle or the display name, case-insensitively, so you can target
        // someone whose username you do not know.
        if (only) {
          const needle = only.replace(/^@/, "").toLowerCase();
          const hay = [handle, e.username, e.firstName, e.lastName]
            .filter(Boolean).join(" ").toLowerCase();
          if (!hay.includes(needle)) continue;
        }
        targets.push({ handle, entity: e });
      }
    }
    console.log(`Unread needing a step: ${targets.length}${only ? ` (filtered by "${only}")` : ""}`);
    console.log(send ? `MODE: SENDING (cap ${cap})` : "MODE: dry run — pass --send to deliver");

    for (const target of targets) {
      if (acted >= cap) { console.log(`\nCap ${cap} reached.`); break; }
      const result = await stepOne(tg, target, { send, deny, scenarios });
      if (result === "acted") acted++;
      else if (result === "queued") queued++;
      else if (result === "flood") { console.log("  FLOOD — stopping."); break; }
      else skipped++;

      // Pace real sends only. A dry run delivers nothing, so the jittered delay
      // bought no flood protection there — it just made inspecting 10 people
      // take ten minutes, which is long enough that nobody dry-runs.
      if (send && result === "acted" && acted < cap) {
        await sleep(RATE_LIMITS.INTER_USER_DELAY_MS_MIN
          + Math.random() * (RATE_LIMITS.INTER_USER_DELAY_MS_MAX - RATE_LIMITS.INTER_USER_DELAY_MS_MIN));
      }
    }
  } finally {
    await tg.disconnect().catch(() => {});
    await lock.release();
    if (track) await stopTracker();
  }

  console.log(`\nDone. ${send ? "sent" : "would send"}=${acted}  queued=${queued}  skipped=${skipped}`);
  if (queued) console.log(`Review: ${REVIEW_QUEUE}`);
  return { sent: acted, queued, skipped };
}

// ── Live mode ─────────────────────────────────────────────────────────────────

// A funnel answer is one word, so polling unread dialogs on a schedule is the
// wrong shape: someone types "да" and waits. This reacts to the message as it
// arrives and pushes the same event to the dashboard.
export async function runLive({ send = false, track = true, cap = Infinity, allowShrink = false } = {}) {
  const list = await loadDenylist({ send, allowShrink });
  if (!reportDenylist(list)) process.exit(1);
  const deny = list.deny;
  const scenarios = await loadScenarios();
  console.log(`Playbook: ${Object.keys(scenarios.branches).length} known scenarios loaded.`);
  if (track) await startTracker({ open: true });

  const lock = await acquireRunLock(PATHS.RUN_LOCK, { label: "funnel-live" });
  if (!lock.ok) { console.error(`Locked: ${lock.reason}`); process.exit(1); }

  const { apiId, apiHash, forceSms, authMethod } = validateEnv();
  const tg = await startClient(apiId, apiHash, forceSms, authMethod);
  let acted = 0;
  // One person at a time: two answers landing together must not interleave into
  // a double send.
  let chain = Promise.resolve();

  console.log(send ? "LIVE: sending" : "LIVE: dry run — pass --send to deliver");
  console.log(`Cap: ${cap === Infinity ? "none" : cap}. Ctrl+C to stop.`);

  tg.addEventHandler((event) => {
    chain = chain.then(async () => {
      try {
        const msg = event.message;
        if (!msg || msg.out) return;
        const sender = await msg.getSender().catch(() => null);
        if (!sender || sender.bot || sender.className !== "User") return;
        if (acted >= cap) return;

        const handle = sender.username ? `@${sender.username.toLowerCase()}` : `id:${sender.id}`;
        const result = await stepOne(tg, { handle, entity: sender }, { send, deny, scenarios });
        if (result === "acted") acted++;
        if (result === "flood") {
          console.log(`  FLOOD — pausing ${Math.round(RATE_LIMITS.INTER_USER_DELAY_MS_MAX / 1000)}s.`);
          await sleep(RATE_LIMITS.INTER_USER_DELAY_MS_MAX);
        }
      } catch (err) {
        console.error("handler error:", getErrorMessage(err));
      }
    });
    return chain;
  }, new NewMessage({ incoming: true }));

  const stop = async () => {
    console.log("\nStopping.");
    await tg.disconnect().catch(() => {});
    await lock.release();
    if (track) await stopTracker();
    // Let the closing sockets finish their teardown. Exiting hard in the same
    // tick as a socket close trips a libuv assertion on Windows and reports
    // exit 127, which reads as a crashed run to the scheduler.
    await new Promise(r => setImmediate(r));
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await new Promise(() => {});   // run until killed
}

if (process.argv[1] && process.argv[1].endsWith("auto-reply.js")) {
  const argv = process.argv.slice(2);
  const send = argv.includes("--send");
  const track = argv.includes("--track") || argv.includes("--live");
  const capArg = argv.find(a => a.startsWith("--cap="));
  const cap = capArg ? Number(capArg.split("=")[1]) : undefined;
  const onlyArg = argv.find(a => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice("--only=".length) : null;

  const allowShrink = argv.includes("--allow-denylist-shrink");
  const boot = argv.includes("--live")
    ? runLive({ send, track, cap: cap ?? Infinity, allowShrink })
    : runAutoReply({ send, track, cap: cap ?? DEFAULT_CAP, allowShrink, only });
  boot.catch(err => { console.error(err); process.exit(1); });
}

export { FAREWELL };
