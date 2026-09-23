import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Api } from "telegram";

import { getErrorMessage, startClient, validateEnv } from "./auth.js";
import { getUserIdentifier } from "./utils.js";

process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "TimeoutNegativeWarning") return;
  console.warn(w.name, w.message);
});

// Public link/handle forms we can resolve without joining:
//   @durov · durov · t.me/durov · https://t.me/durov · https://t.me/durov/123
//   tg://resolve?domain=durov · https://t.me/s/durov (web preview)
// Private/invite forms (t.me/+hash, joinchat/…, t.me/c/<id>) require joining
// first, so they are skipped with a clear log instead of half-working.
function cleanTarget(raw) {
  let s = String(raw).trim();
  if (!s) return "";
  s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  const tg = s.match(/^tg:\/\/resolve\?domain=([A-Za-z0-9_]+)/i);
  if (tg) return tg[1];
  s = s.replace(/^(t\.me|telegram\.me|telegram\.dog)\//i, "");
  s = s.replace(/^@/, "");
  s = s.replace(/[?#].*$/, "");
  s = s.replace(/^s\//i, "");
  s = s.replace(/\/+$/, "");
  if (!isPrivateLink(s)) s = s.split("/")[0];
  return s;
}

function isPrivateLink(t) {
  return /^\+/.test(t) || /^joinchat\//i.test(t) || /^c\//i.test(t);
}

function safeName(entity, fallback) {
  const base = entity?.username ?? fallback ?? String(entity?.id ?? "out");
  return base.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Uses empty query + per-letter/digit searches to defeat Telegram's ~10k getParticipants offset cap.
function buildSearchQueries() {
  const q = [""];
  for (let c = 97; c <= 122; c++) q.push(String.fromCharCode(c));      // a-z
  for (let c = 0x430; c <= 0x44f; c++) q.push(String.fromCharCode(c)); // а-я
  q.push("ё");
  for (let c = 48; c <= 57; c++) q.push(String.fromCharCode(c));       // 0-9
  return q;
}

async function loadExisting(outPath) {
  const set = new Set();
  try {
    const data = await fs.readFile(outPath, "utf8");
    for (const line of data.split("\n")) {
      const t = line.trim();
      if (t) set.add(t);
    }
  } catch {}
  return set;
}

async function collectMembers(client, entity, add, label) {
  const seenIds = new Set();
  let added = 0;
  const queries = buildSearchQueries();
  process.stdout.write(`  [${label}/members] multi-query scan (${queries.length} queries) to beat 10k cap...\n`);
  for (const q of queries) {
    try {
      for await (const p of client.iterParticipants(entity, { search: q })) {
        const idStr = String(p.id);
        if (seenIds.has(idStr)) continue;
        seenIds.add(idStr);
        if (p.bot) continue;
        if (add(p)) added++;
      }
    } catch (err) {
      if (q === "") {
        process.stdout.write(`  [${label}/members] not available (${getErrorMessage(err)})\n`);
        return { added, distinct: seenIds.size, available: false };
      }
    }
    process.stdout.write(`\r  [${label}/members] q="${q || "∅"}" distinct=${seenIds.size} new=${added}        `);
  }
  process.stdout.write(`\r  [${label}/members] done: ${seenIds.size} distinct users, +${added} new usernames\n`);
  return { added, distinct: seenIds.size, available: true };
}

async function scanMessages(client, chat, add, label, replyTo) {
  let scanned = 0;
  let added = 0;
  const opts = replyTo ? { replyTo } : {};
  for await (const msg of client.iterMessages(chat, opts)) {
    scanned++;
    const sender = await msg.getSender().catch(() => null);
    if (sender && !sender.bot && sender.className === "User") {
      if (add(sender)) added++;
    }
    if (scanned % 500 === 0) {
      process.stdout.write(`\r  [${label}] scanned ${scanned}, new ${added}        `);
    }
  }
  process.stdout.write(`\r  [${label}] done: scanned ${scanned}, +${added} new\n`);
  return { scanned, added };
}

async function getForumTopics(client, entity) {
  const topics = [];
  const seen = new Set();
  let offsetDate = 0, offsetId = 0, offsetTopic = 0;
  while (true) {
    let res;
    try {
      res = await client.invoke(new Api.channels.GetForumTopics({
        channel: entity, offsetDate, offsetId, offsetTopic, limit: 100,
      }));
    } catch {
      break;
    }
    const batch = (res.topics || []).filter((t) => t.className === "ForumTopic");
    let progressed = false;
    for (const t of batch) {
      if (!seen.has(t.id)) { seen.add(t.id); topics.push(t); progressed = true; }
    }
    if (!progressed || (res.topics || []).length < 100) break;
    const lastTopic = batch[batch.length - 1];
    offsetTopic = lastTopic.id;
    offsetId = lastTopic.topMessage || offsetId;
    const lastMsg = (res.messages || []).find((m) => m.id === lastTopic.topMessage);
    offsetDate = lastMsg?.date || offsetDate;
  }
  return topics;
}

async function parseChat(client, chat, add, label) {
  const counts = { membersNew: 0, msgScanned: 0, msgNew: 0, topics: 0 };

  const m = await collectMembers(client, chat, add, label);
  counts.membersNew = m.added;

  if (chat.forum) {
    const topics = await getForumTopics(client, chat);
    counts.topics = topics.length;
    process.stdout.write(`  [${label}] forum with ${topics.length} topic(s) — scanning each\n`);
    for (const topic of topics) {
      const r = await scanMessages(client, chat, add, `${label}/topic:${topic.title || topic.id}`, topic.id);
      counts.msgScanned += r.scanned;
      counts.msgNew += r.added;
    }
    const g = await scanMessages(client, chat, add, `${label}/general`);
    counts.msgScanned += g.scanned;
    counts.msgNew += g.added;
  } else {
    const r = await scanMessages(client, chat, add, `${label}/messages`);
    counts.msgScanned += r.scanned;
    counts.msgNew += r.added;
  }
  return counts;
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readLinksFile(p) {
  const out = [];
  try {
    const data = await fs.readFile(p, "utf8");
    for (const line of data.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) out.push(t);
    }
  } catch {}
  return out;
}

async function resolveTargets() {
  const cliArgs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  let raw;
  if (cliArgs.length > 0) {
    raw = [...cliArgs];
  } else {
    let file = process.env.LINKS_FILE && path.resolve(process.env.LINKS_FILE);
    if (!file) {
      const fast = path.resolve("parse", "links.txt");
      file = (await fileExists(fast)) ? fast : path.resolve("targets.txt");
    }
    raw = await readLinksFile(file);
    console.log(raw.length
      ? `Reading ${raw.length} link(s) from ${file}`
      : `No links found in ${file} — add Telegram links (one per line) and rerun.`);
  }
  const cleaned = raw.map(cleanTarget).filter(Boolean);
  return [...new Set(cleaned.map((c) => c.toLowerCase()))]
    .map((lc) => cleaned.find((c) => c.toLowerCase() === lc));
}

async function main() {
  const targets = await resolveTargets();
  if (targets.length === 0) {
    console.log("\nNothing to parse. Add Telegram links to your list and run again.");
    process.exit(0);
  }

  const { apiId, apiHash, forceSms, authMethod } = validateEnv();
  const client = await startClient(apiId, apiHash, forceSms, authMethod);
  client.floodSleepThreshold = 24 * 60 * 60;

  const me = await client.getMe();
  console.log(`\nAuthorized as: ${me.username || me.firstName || me.id}\n`);
  console.log(`Targets (${targets.length}): ${targets.join(", ")}\n`);

  await fs.mkdir(path.resolve("lists"), { recursive: true });
  const summary = [];

  for (const target of targets) {
    console.log(`\n========== ${target} ==========`);
    if (isPrivateLink(target)) {
      console.log(`  ! Private/invite link — skipping. Join the group in Telegram first, then add its @username.`);
      summary.push({ target, error: "private/invite link skipped" });
      continue;
    }
    let entity;
    try {
      entity = await client.getEntity(target);
    } catch (err) {
      console.error(`  ! Could not resolve "${target}": ${getErrorMessage(err)}`);
      summary.push({ target, error: getErrorMessage(err) });
      continue;
    }

    const title = entity.title || entity.username || String(entity.id);
    const kind = entity.broadcast ? "channel" : entity.megagroup ? "supergroup" : "group";
    console.log(`  Resolved: ${title}${entity.username ? `  @${entity.username}` : ""}  [${kind}${entity.forum ? "/forum" : ""}]`);

    const outPath = path.resolve("lists", `${safeName(entity, target)}.txt`);
    const participants = await loadExisting(outPath);
    const startSize = participants.size;
    if (startSize > 0) console.log(`  Loaded ${startSize} existing usernames from ${path.basename(outPath)}`);

    const stream = createWriteStream(outPath, { flags: "a", encoding: "utf8" });
    const add = (user) => {
      const id = getUserIdentifier(user);
      if (id && !participants.has(id)) {
        participants.add(id);
        stream.write(id + "\n");
        return true;
      }
      return false;
    };

    const mainCounts = await parseChat(client, entity, add, "main");

    let linkedCounts = null;
    try {
      const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
      const linkedId = full.fullChat.linkedChatId;
      if (linkedId) {
        const linked = await client.getEntity(linkedId);
        console.log(`  Linked discussion subchannel: ${linked.username || linked.title || linked.id}`);
        linkedCounts = await parseChat(client, linked, add, "linked");
      } else {
        console.log(`  No linked discussion subchannel`);
      }
    } catch (err) {
      console.log(`  Linked subchannel lookup failed (${getErrorMessage(err)})`);
    }

    stream.end();
    await new Promise((r) => stream.on("finish", r));

    const total = participants.size;
    const added = total - startSize;
    console.log(`  -> ${total} usernames total (+${added} this run) saved to ${outPath}`);
    summary.push({ target, title, total, added, mainCounts, linkedCounts, outPath });
  }

  console.log(`\n========== SUMMARY ==========`);
  for (const s of summary) {
    if (s.error) { console.log(`  ${s.target}: ERROR ${s.error}`); continue; }
    const lk = s.linkedCounts ? ` | linked +${s.linkedCounts.membersNew + s.linkedCounts.msgNew} (topics:${s.linkedCounts.topics})` : "";
    console.log(`  ${s.target}: ${s.total} usernames (+${s.added}) | main m+${s.mainCounts.membersNew} msg+${s.mainCounts.msgNew} topics:${s.mainCounts.topics}${lk}`);
  }

  await client.disconnect();
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error("Fatal:", getErrorMessage(err));
    process.exit(1);
  });
}

export { cleanTarget, isPrivateLink, resolveTargets };
