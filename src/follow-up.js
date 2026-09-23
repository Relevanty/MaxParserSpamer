// Follow-up sender.
//
// runSender only knows how to fire the opening sequence at a list, which is
// exactly wrong for someone who already answered us — they get the cold intro
// a second time, which reads worse than silence. This sends one contextual
// reply per person instead, from a drafts file, and refuses to touch anyone
// who has not written to us first.
//
// Safety rules, in order of importance:
//   1. Never message a peer with no inbound message. Replying inside an
//      existing conversation is also what keeps PEER_FLOOD risk low — the
//      account has been moderation-limited once already.
//   2. Never double-answer. If the last message in the chat is ours, someone
//      (or an earlier run) already replied; skip.
//   3. Dry run unless --send is passed explicitly.
//   4. Hard cap per run, jittered delays, and the same run lock the sender uses.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PATHS, RATE_LIMITS } from "./config.js";
import { validateEnv, startClient, getErrorMessage } from "./auth.js";
import { appendReportRow } from "./report.js";
import { acquireRunLock } from "./run-lock.js";
import { sleep, normalizeUsername } from "./utils.js";
import { loadDenylist as guardedDenylist, reportDenylist } from "./denylist.js";

const DRAFTS = path.resolve("reports", "followup-drafts.json");
const DEFAULT_CAP = 10;

// People who explicitly declined. Keeping them out of the drafts file is not
// enough — a regenerated drafts file would quietly let them back in, and
// re-pitching a "не интересует" is what got the account moderation-limited.
// This is checked at send time and cannot be overridden by the drafts.
//
// The list itself now comes from denylist.js, which also refuses to send when
// the file has lost entries since the last run — see the note there.
// Re-exported because the tests pin this module's contract.
export async function loadDenylist(opts = {}) {
  const { deny } = await guardedDenylist(opts);
  return deny;
}

function nowStamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
const randomInt = (a, b) => Math.floor(a + Math.random() * (b - a));

// True when the newest message in the chat came from them.
export async function theyWroteLast(client, entity) {
  const msgs = await client.getMessages(entity, { limit: 1 });
  const last = msgs?.[0];
  if (!last) return { ok: false, why: "no messages in chat" };
  if (last.out) return { ok: false, why: "we already replied last" };
  return { ok: true, last: (last.message || "").replace(/\s+/g, " ").slice(0, 80) };
}

export async function runFollowUp({ send = false, cap = DEFAULT_CAP, allowShrink = false } = {}) {
  let drafts;
  try {
    drafts = JSON.parse(await readFile(DRAFTS, "utf8"));
  } catch (err) {
    console.error(`Cannot read ${DRAFTS}: ${err.message}`);
    process.exit(1);
  }
  // Keys starting with "_" are notes to the operator, not recipients.
  const list = await guardedDenylist({ send, allowShrink });
  if (!reportDenylist(list)) process.exit(1);
  const deny = list.deny;
  const all = Object.entries(drafts)
    .filter(([k, v]) => !k.startsWith("_") && typeof v === "string" && v.trim());
  const entries = all.filter(([k]) => !deny.has(k.replace(/^@/, "").toLowerCase()));
  const blocked = all.length - entries.length;
  if (blocked > 0) {
    console.log(`Denylist: ${blocked} recipient(s) removed — they declined and must not be contacted.`);
  }
  console.log(`Drafts loaded: ${entries.length}`);
  console.log(send ? `MODE: SENDING (cap ${cap})` : "MODE: dry run — pass --send to actually deliver");

  const lock = await acquireRunLock(PATHS.RUN_LOCK, { label: "follow-up" });
  if (!lock.ok) {
    console.error(`Another run holds the lock: ${lock.reason}`);
    process.exit(1);
  }

  const { apiId, apiHash, forceSms, authMethod } = validateEnv();
  const client = await startClient(apiId, apiHash, forceSms, authMethod);
  let sent = 0, skipped = 0, failed = 0;

  try {
    for (const [rawUser, text] of entries) {
      if (sent >= cap) {
        console.log(`\nCap of ${cap} reached — ${entries.length - sent - skipped - failed} left for the next run.`);
        break;
      }
      const user = normalizeUsername(rawUser);
      let entity;
      try {
        entity = await client.getEntity(user);
      } catch (err) {
        console.log(`  SKIP ${user} — cannot resolve (${getErrorMessage(err)})`);
        skipped++;
        continue;
      }

      const guard = await theyWroteLast(client, entity);
      if (!guard.ok) {
        console.log(`  SKIP ${user} — ${guard.why}`);
        skipped++;
        continue;
      }

      if (!send) {
        console.log(`  DRY  ${user}\n       last in: ${guard.last}\n       reply  : ${text.replace(/\s+/g, " ").slice(0, 110)}`);
        sent++;
        continue;
      }

      try {
        await client.sendMessage(entity, { message: text });
        await appendReportRow(PATHS.REPORT_CSV, {
          timestamp: nowStamp(),
          user,
          mode: "FollowUp",
          messageCount: 1,
          template: "followup",
          status: "Success",
        });
        sent++;
        console.log(`  SENT ${user}  (${sent}/${cap})`);
      } catch (err) {
        const msg = getErrorMessage(err);
        failed++;
        console.log(`  FAIL ${user} — ${msg}`);
        await appendReportRow(PATHS.REPORT_CSV, {
          timestamp: nowStamp(), user, mode: "FollowUp",
          messageCount: "", template: "followup", status: `Error: ${msg}`,
        });
        // A flood error means stop immediately, not push through the list.
        if (/FLOOD/i.test(msg)) {
          console.log("  FLOOD detected — stopping this run.");
          break;
        }
      }

      if (sent < cap) {
        await sleep(randomInt(RATE_LIMITS.INTER_USER_DELAY_MS_MIN, RATE_LIMITS.INTER_USER_DELAY_MS_MAX));
      }
    }
  } finally {
    await client.disconnect().catch(() => {});
    await lock.release();
  }

  console.log(`\nDone. ${send ? "sent" : "would send"}=${sent}  skipped=${skipped}  failed=${failed}`);
  return { sent, skipped, failed };
}

if (process.argv[1] && process.argv[1].endsWith("follow-up.js")) {
  const send = process.argv.includes("--send");
  const capArg = process.argv.find(a => a.startsWith("--cap="));
  const cap = capArg ? Number(capArg.split("=")[1]) : DEFAULT_CAP;
  runFollowUp({ send, cap, allowShrink: process.argv.includes("--allow-denylist-shrink") }).catch(err => { console.error(err); process.exit(1); });
}
