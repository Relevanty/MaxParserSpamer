// Standalone funnel dashboard.
//
//   node tools/tracker.js
//
// The board used to live inside auto-reply.js, which meant it only existed while
// that script ran — and since auto-reply.js takes the same run lock as the
// sender, you could never watch the board while a send was in flight. This runs
// on its own: no run lock, no Telegram connection, no writes. It reads the files
// the other processes already produce and serves the same page.
//
// Two sources, because the funnel has two halves:
//   reports/funnel-events.jsonl  the answer side (auto-reply.js) — full detail
//   report.csv                   the cold opener (the sender) — one row per send
//
// Cold sends carry no stage of their own: question 1 going out *is* stage 1, so
// that is how they are entered on the board.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { startTracker, trackEvent } from "../src/funnel-ws.js";
import { parseCsvLine } from "../src/utils.js";

const REPORT_CSV = path.resolve("report.csv");
const POLL_MS = Number(process.env.RELEVANTY_TRACKER_POLL_MS ?? 4000);

// Only today's sends are interesting on a live board, and report.csv is 600KB.
const TODAY = new Date().toISOString().slice(0, 10);

const seen = new Set();
let lastSize = 0;

// Which report rows belong to the funnel. The sender delivers the opener through
// the text-sequence path, so that is what lands in the Template column; rows
// written by auto-reply.js are labelled "funnel:<step>".
function classify(cols) {
  const [timestamp, user, mode, , template, status] = cols;
  if (!timestamp?.startsWith(TODAY)) return null;
  const tpl = String(template ?? "");
  const isFunnelReply = tpl.startsWith("funnel:");
  const isColdOpener = tpl === "text-seq" || tpl === "funnel";
  if (!isFunnelReply && !isColdOpener) return null;

  const ok = /^Success/i.test(String(status ?? ""));
  const flood = /FLOOD/i.test(String(status ?? ""));
  return {
    handle: user,
    step: ok ? (isFunnelReply ? tpl.slice(7) : "ask") : flood ? "error" : "error",
    stage: isFunnelReply ? undefined : 1,
    reason: ok ? (isColdOpener ? "cold opener sent" : undefined) : String(status ?? "").slice(0, 80),
    sent: ok,
    at: timestamp.replace(" ", "T") + "Z",
    source: "sender",
    // A row key, so a re-read never double-counts and a duplicate send does show
    // up as two distinct events.
    _key: `${timestamp}|${user}|${status}`,
  };
}

async function ingestReport({ initial = false } = {}) {
  let size;
  try {
    ({ size } = await stat(REPORT_CSV));
  } catch {
    return;
  }
  if (!initial && size === lastSize) return;
  lastSize = size;

  let raw;
  try {
    raw = await readFile(REPORT_CSV, "utf8");
  } catch {
    return;
  }

  let added = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || /^timestamp,/i.test(line)) continue;
    // Keep the cheap check before the parse — most of a 600KB file is old.
    if (!line.startsWith(TODAY)) continue;
    const row = classify(parseCsvLine(line));
    if (!row || seen.has(row._key)) continue;
    seen.add(row._key);
    const { _key, ...event } = row;
    await trackEvent(event);
    added += 1;
  }
  if (added) console.log(`  +${added} row(s) from report.csv`);
}

let url;
try {
  ({ url } = await startTracker({ open: true }));
} catch (err) {
  if (err?.code === "EADDRINUSE") {
    console.error(`
Port ${process.env.RELEVANTY_FUNNEL_PORT ?? 8787} is already in use —`
      + ` a tracker (or an auto-reply --track run) is probably already up.`);
    console.error(`Open the URL it printed, or set RELEVANTY_FUNNEL_PORT to run a second one.`);
    process.exit(1);
  }
  throw err;
}
console.log(`  standalone — no run lock taken, nothing is sent from here`);
console.log(`  watching report.csv every ${POLL_MS}ms  (Ctrl+C to stop)`);

// The answer side's history is loaded by startTracker itself; this adds the
// sender's rows on top, then keeps both in step.
await ingestReport({ initial: true });
const timer = setInterval(() => { void ingestReport(); }, POLL_MS);

const stop = () => { clearInterval(timer); console.log("\n  tracker stopped."); process.exit(0); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

// Hold the process open.
await new Promise(() => {});
