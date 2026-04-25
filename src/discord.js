import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sleep } from "./utils.js";
import { loadProcessedUsers, saveProcessedUsers } from "./storage.js";
import { appendReportRow } from "./report.js";
import { PATHS, DISCORD_CONFIG } from "./config.js";

const BASE = "https://discord.com/api/v10";

function nowStamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function discordFetch(token, method, endpoint, body) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429) {
    const data = await res.json();
    const wait = (data.retry_after ?? 5) * 1000;
    console.log(`[Discord] Rate limited — waiting ${(wait / 1000).toFixed(1)}s`);
    await sleep(wait);
    return discordFetch(token, method, endpoint, body);
  }

  return res;
}

async function loadUserIds(filePath) {
  const content = await readFile(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

async function getUserTag(token, userId) {
  const res = await discordFetch(token, "GET", `/users/${userId}`);
  if (!res.ok) return userId;
  const data = await res.json();
  return data.username ?? userId;
}

async function getVoiceUserIds(token, guildId) {
  const res = await discordFetch(token, "GET", `/guilds/${guildId}/voice-states`);
  if (!res.ok) return new Set();
  const states = await res.json();
  return new Set(Array.isArray(states) ? states.map((s) => s.user_id) : []);
}

async function openDM(token, userId) {
  const res = await discordFetch(token, "POST", "/users/@me/channels", { recipient_id: userId });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Cannot open DM: ${res.status} ${err}`);
  }
  return (await res.json()).id;
}

async function sendDM(token, channelId, text) {
  const res = await discordFetch(token, "POST", `/channels/${channelId}/messages`, { content: text });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const code = data.code ?? res.status;
    throw Object.assign(new Error(data.message ?? "Send failed"), { code });
  }
}

async function loadMessage() {
  const filePath = path.join(PATHS.MESSAGES_DIR, DISCORD_CONFIG.MESSAGE_FILE);
  const content = await readFile(filePath, "utf8");
  return content.trim();
}

export async function runDiscordSpammer() {
  const token = process.env.DISCORD_USER_TOKEN;
  if (!token) {
    console.error("[Discord] DISCORD_USER_TOKEN is not set in .env");
    process.exit(1);
  }

  const guildId = process.env.DISCORD_GUILD_ID || DISCORD_CONFIG.GUILD_ID;
  if (!guildId) {
    console.error("[Discord] DISCORD_GUILD_ID is not set in .env or config.js");
    process.exit(1);
  }

  const messageText = await loadMessage();
  console.log(`\n[Discord] Message to send:\n${"─".repeat(40)}\n${messageText}\n${"─".repeat(40)}\n`);

  const processedUsers = await loadProcessedUsers(PATHS.DISCORD_PROCESSED_USERS_JSON);

  // Verify token works
  const meRes = await discordFetch(token, "GET", "/users/@me");
  if (!meRes.ok) {
    console.error("[Discord] Invalid token — could not authenticate");
    process.exit(1);
  }
  const me = await meRes.json();
  console.log(`[Discord] Logged in as ${me.username}`);

  const [allUserIds, voiceIds] = await Promise.all([
    loadUserIds(PATHS.DISCORD_USERS_LIST),
    getVoiceUserIds(token, guildId),
  ]);

  const inVoice = allUserIds.filter((id) => voiceIds.has(id));
  const alreadySent = allUserIds.filter((id) => processedUsers.has(id));
  const targets = allUserIds
    .filter((id) => id !== me.id && !voiceIds.has(id) && !processedUsers.has(id))
    .slice(0, DISCORD_CONFIG.MAX_RECIPIENTS);

  console.log(`[Discord] List: ${allUserIds.length} users`);
  console.log(`[Discord]   In voice (skipped):    ${inVoice.length}`);
  console.log(`[Discord]   Already sent (skipped): ${alreadySent.length}`);
  console.log(`[Discord]   Will text now:          ${targets.length} (limit: ${DISCORD_CONFIG.MAX_RECIPIENTS})\n`);

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const total = targets.length;

  for (const userId of targets) {
    const tag = await getUserTag(token, userId);

    try {
      const channelId = await openDM(token, userId);
      await sendDM(token, channelId, messageText);
      processedUsers.add(userId);
      await saveProcessedUsers(PATHS.DISCORD_PROCESSED_USERS_JSON, processedUsers);
      await appendReportRow(PATHS.REPORT_CSV, {
        timestamp: nowStamp(),
        user: tag,
        mode: "discord",
        status: "sent",
      });
      sent++;
      console.log(`[${nowStamp()}] SENT  ${tag}  (${sent + skipped + failed}/${total})`);
    } catch (err) {
      failed++;
      const reason = err.code === 50007 ? "DMs disabled" : err.message;
      console.log(`[${nowStamp()}] FAIL  ${tag}  — ${reason}`);
      await appendReportRow(PATHS.REPORT_CSV, {
        timestamp: nowStamp(),
        user: tag,
        mode: "discord",
        status: `failed: ${reason}`,
      });
    }

    await sleep(DISCORD_CONFIG.INTER_USER_DELAY_MS);
  }

  console.log(`\n[Discord] Done. Sent: ${sent}, Skipped: ${skipped}, Failed: ${failed}`);
}
