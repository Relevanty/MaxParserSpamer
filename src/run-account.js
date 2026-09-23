// Headless single-account runner. Launched (once per account) by tools/multi.js
// with a per-account env: SESSION_STRING, API_ID/API_HASH, optional SOCKS_PROXY,
// RELEVANTY_PROFILE (isolates storage) and RELEVANTY_SETTINGS (JSON: message
// source, mode, and the list subset this account should handle).
import "dotenv/config";
import { runSender } from "./index.js";
import { setLang } from "./i18n.js";

function readSettings() {
  const raw = process.env.RELEVANTY_SETTINGS;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.error("Invalid RELEVANTY_SETTINGS JSON; using defaults.");
    return {};
  }
}

const settings = readSettings();
if (settings.lang) setLang(settings.lang);

const profile = process.env.RELEVANTY_PROFILE || "default";

// Emit machine-readable progress so the parent (tools/multi.js) can aggregate a
// live dashboard. One JSON object per line, tagged with a marker the parent greps.
function emit(ev) {
  process.stdout.write(`RLV_EVT ${JSON.stringify(ev)}\n`);
}

function onProgress(ev) {
  if (!ev || !ev.type) return;
  if (ev.type === "sent") emit({ type: "sent", user: ev.user, source: ev.source, ms: ev.ms });
  else if (ev.type === "skip") emit({ type: "skip", user: ev.user, reason: ev.reason });
  else if (ev.type === "error") emit({ type: "error", user: ev.user, message: ev.message });
  else if (ev.type === "flood") emit({ type: "flood" });
  else if (ev.type === "tick") emit({ type: "tick", user: ev.user });
}

try {
  await runSender(settings, onProgress);
  console.log(`profile "${profile}" finished.`);
  process.exit(0);
} catch (err) {
  console.error(`profile "${profile}" fatal:`, err?.message || err);
  process.exit(1);
}
