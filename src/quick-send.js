import { loadSettings } from "./settings.js";
import { runSender, requestAbort } from "./index.js";
import { createRunLog } from "./run-log.js";
import { t, setLang } from "./i18n.js";
import {
  R, COLORS,
  showCursor,
  liveStats, clearLiveStats,
  skipLog, errorLog, peerFloodBox,
  printSummary,
} from "./animate.js";

// First Ctrl+C asks the run to stop at the next clean boundary, so the lock is
// released and nobody ends up messaged-but-unrecorded. A second Ctrl+C is the
// escape hatch if something is wedged.
let stopping = false;
process.on("SIGINT", () => {
  if (stopping) {
    showCursor();
    console.log("\n  Forced exit — the run lock may be left behind (it self-heals).");
    process.exit(130);
  }
  stopping = true;
  requestAbort();
  void runLog.note("interrupted by operator (Ctrl+C) — stopping at the next boundary");
  console.log("\n  Stopping after the current person… (Ctrl+C again to force)");
});

const settings = await loadSettings();
setLang(settings.language);

const src = settings.specificFile ?? settings.messageSource;
const list = settings.specificList ?? "all lists";
console.log(`\n  ${COLORS.cyan}Quick Send${R}  ${COLORS.gray}›${R}  source: ${COLORS.yellow}${src}${R}   list: ${COLORS.yellow}${list}${R}   mode: ${COLORS.yellow}${settings.sendMode}${R}\n`);

const runLog = createRunLog({ label: "send" });
await runLog.start({
  source: src, list, mode: settings.sendMode,
  cap: settings.runCap ?? process.env.RELEVANTY_RUN_CAP ?? "",
});
console.log(`  log: ${runLog.file}`);

let startMs = Date.now();
let sent = 0, skipped = 0, errors = 0;

const onProgress = (event) => {
  runLog.event(event);
  if (event.type === "start") {
    startMs = Date.now();
    sent = skipped = errors = 0;
  } else if (event.type === "tick") {
    liveStats({ current: event.index + 1, total: event.total, user: event.user, sent, skipped, errors, startMs, mode: settings.sendMode });
  } else if (event.type === "skip") {
    skipped++;
    skipLog(event.user, event.reason);
  } else if (event.type === "sent") {
    sent++;
  } else if (event.type === "flood") {
    clearLiveStats();
    peerFloodBox(event.unblocking ? t("floodDetected") : t("floodFailed"));
  } else if (event.type === "error") {
    errors++;
    errorLog(event.user, event.message);
  } else if (event.type === "done") {
    clearLiveStats();
    printSummary({ sent, skipped, errors, startMs });
  }
};

try {
  await runSender(settings, onProgress);
  await runLog.end();
} catch (err) {
  clearLiveStats();
  errorLog("Quick Send", err.message ?? String(err));
  await runLog.note(`run failed: ${err.message ?? String(err)}`);
  await runLog.end({ outcome: "failed" });
  process.exit(1);
}
