import { loadSettings } from "./settings.js";
import { runSpammer } from "./index.js";
import { t, setLang } from "./i18n.js";
import {
  R, COLORS,
  showCursor,
  liveStats, clearLiveStats,
  skipLog, errorLog, peerFloodBox,
  printSummary,
} from "./animate.js";

process.on("SIGINT", () => { showCursor(); process.exit(0); });

const settings = await loadSettings();
setLang(settings.language);

const src = settings.specificFile ?? settings.messageSource;
const list = settings.specificList ?? "all lists";
console.log(`\n  ${COLORS.cyan}Quick Spam${R}  ${COLORS.gray}›${R}  source: ${COLORS.yellow}${src}${R}   list: ${COLORS.yellow}${list}${R}   mode: ${COLORS.yellow}${settings.sendMode}${R}\n`);

let startMs = Date.now();
let sent = 0, skipped = 0, errors = 0;

const onProgress = (event) => {
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
  await runSpammer(settings, onProgress);
} catch (err) {
  clearLiveStats();
  errorLog("Quick Spam", err.message ?? String(err));
  process.exit(1);
}
