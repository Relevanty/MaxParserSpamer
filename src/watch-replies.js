// Live reply watcher.
//
// The problem this solves: archiveAfterSend moves every messaged chat into the
// Archive folder, so when a lead replies the unread badge lands somewhere nobody
// looks. On 2026-08-05 that had buried 86 unread dialogs — 71 of them genuine
// leads, several of whom had already said yes and were waiting on an answer.
//
// This listens for incoming messages, classifies each conversation with the call
// analyser, and pushes an alert into Saved Messages the moment someone gets warm
// enough that a human should take them on a call. Saved Messages is the default
// target because it is our own chat — no third party is messaged without intent.
// Set RELEVANTY_ALERT_TO=@handle to route alerts to a teammate instead.
import "dotenv/config";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NewMessage } from "telegram/events/index.js";
import { PATHS } from "./config.js";
import { validateEnv, startClient, getErrorMessage } from "./auth.js";
import { analyseCall, deriveTeam, CALL_STAGE } from "./call-analyser.js";

const ALERT_TO = (process.env.RELEVANTY_ALERT_TO || "me").trim();
const STATE = path.resolve("storage", "watch-state.json");
const LOG = path.resolve("reports", "reply-alerts.csv");
// Don't re-alert on the same person while they're still in an active exchange.
const REALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;

// Things that mean "a human should pick this up now", beyond what stage alone
// tells us — an explicit time offer is worth surfacing even before the analyser
// registers agreement.
// JS \b is ASCII-only and never matches at a Cyrillic boundary, so word edges
// are spelled out against an explicit letter class instead.
const W = "[a-zа-яё0-9_]";
const b = (src) => new RegExp(`(?<!${W})(?:${src})(?!${W})`, "i");
const URGENT = [
  b("давай(?:те)?"), b("договорились"),
  /готов(?:а|ы)? (?:созвониться|пообщаться|поговорить)/i,
  /когда (?:тебе |вам )?удобно/i, /мож(?:ем|но) созвониться/i,
  /как (?:мне |я )?(?:могу |можно )?присоединит/i,
  /(?<![\d:])\d{1,2}[:.]\d{2}(?![\d])/,
  /завтра|сегодня|в воскресенье|в субботу|на выходных/i,
];

async function loadState() {
  try { return JSON.parse(await readFile(STATE, "utf8")); } catch { return { alerted: {} }; }
}
async function saveState(s) {
  await mkdir(path.dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify(s, null, 2), "utf8");
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function runWatcher() {
  const { apiId, apiHash, forceSms, authMethod } = validateEnv();
  const client = await startClient(apiId, apiHash, forceSms, authMethod);
  const me = await client.getMe();
  console.log(`Watching as ${me.username ? "@" + me.username : me.id}. Alerts -> ${ALERT_TO}`);

  // Roster is only used to tell a teammate handoff apart from a real referral.
  let team = new Set();
  try {
    const conv = JSON.parse(await readFile(PATHS.CONVERSATIONS_JSON, "utf8"));
    team = deriveTeam(Object.values(conv).filter(c => !c.error));
  } catch { /* first run, no corpus yet */ }

  const state = await loadState();

  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg || msg.out) return;                       // ours, ignore
      const sender = await msg.getSender().catch(() => null);
      if (!sender || sender.bot || sender.className !== "User") return;

      const handle = sender.username ? `@${sender.username.toLowerCase()}` : `id:${sender.id}`;
      const text = String(msg.message || "").replace(/\s+/g, " ").trim();
      if (!text) return;

      // Pull recent history so the analyser sees the conversation, not one line.
      const hist = await client.getMessages(sender, { limit: 40 }).catch(() => []);
      const sorted = [...hist].sort((a, b) => Number(a.date) - Number(b.date));
      const shape = {
        sentMessages: sorted.filter(m => m.out && m.message).map(m => m.message.trim()),
        replies: sorted.filter(m => !m.out && m.message).map(m => m.message.trim()),
        hasConnectedCall: sorted.some(m => m.className === "MessageService"
          && m.action?.className === "MessageActionPhoneCall" && Number(m.action?.duration) > 0),
      };
      const call = analyseCall(shape, { team });

      const urgent = URGENT.some(re => re.test(text));
      const hot = call.stage >= CALL_STAGE.AGREED || urgent;
      if (!hot || call.declined) return;

      const last = state.alerted[handle] ?? 0;
      if (Date.now() - last < REALERT_COOLDOWN_MS) return;

      const lines = [
        `🔔 ЛИД ЖДЁТ СОЗВОНА — ${handle}`,
        ``,
        `Стадия: ${call.stageName}${call.reneged ? " (передумал ранее)" : ""}`,
        `Написал: «${text.slice(0, 300)}»`,
        call.proposedTimes?.length
          ? `Предложил время: ${call.proposedTimes.map(p => [p.day, p.date, p.time].filter(Boolean).join(" ")).filter(Boolean).join(", ")}`
          : null,
        ``,
        `Нужно: назначить созвон и передать ответственного.`,
        `Открыть: https://t.me/${handle.replace(/^@/, "")}`,
      ].filter(Boolean).join("\n");

      await client.sendMessage(ALERT_TO, { message: lines });
      state.alerted[handle] = Date.now();
      await saveState(state);

      await mkdir(path.dirname(LOG), { recursive: true });
      await appendFile(LOG, [
        new Date().toISOString(), handle, call.stageName,
        call.proposedTimes?.length ? "has_time" : "", csvEscape(text.slice(0, 200)),
      ].map(csvEscape).join(",") + "\n", "utf8");

      console.log(`ALERT ${handle}  ${call.stageName}  "${text.slice(0, 60)}"`);
    } catch (err) {
      console.error("handler error:", getErrorMessage(err));
    }
  }, new NewMessage({ incoming: true }));

  console.log("Listening. Ctrl+C to stop.");
  await new Promise(() => {});   // run until killed
}

if (process.argv[1] && process.argv[1].endsWith("watch-replies.js")) {
  runWatcher().catch(err => { console.error(err); process.exit(1); });
}
