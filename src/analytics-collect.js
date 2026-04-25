import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { PATHS } from "./config.js";
import { parseCsvLine, sleep } from "./utils.js";

const FETCH_DELAY_MS = 1500;
const MESSAGES_PER_CHAT = 100;
const RELEVANTY_DOMAIN = "relevanty.org";

// Keywords that signal the other person explicitly agreed to / scheduled a call
const AGREED_TO_CALL_PATTERNS = [
  /давай/i, /договорились/i, /я за/i, /ок\b/i, /окей/i, /хорошо/i,
  /созвон/i, /созвониться/i, /в \d{1,2}[:h]\d{0,2}/i, /\d{1,2}:\d{2}/,
  /сегодня/i, /завтра/i, /в четверг/i, /в пятницу/i, /в субботу/i,
];

class ConversationAnalyzer {
  analyze(messages) {
    const outgoing = messages.filter(m => m.out && m.className === "Message");
    const incoming = messages.filter(m => !m.out && m.className === "Message");
    const links = this.#extractLinks(messages);
    const mentions = this.#extractMentions(outgoing);
    const agreedToCall = this.#checkAgreedToCall(incoming);

    return {
      sentMessages: outgoing.map(m => m.message?.trim()).filter(Boolean),
      repliesCount: incoming.length,
      replies: incoming.map(m => m.message?.trim()).filter(Boolean),
      hasExternalLink: links.length > 0,
      externalLinks: links,
      hasUsernameMention: mentions.length > 0,
      mentionedUsernames: mentions,
      hasConnectedCall: this.#hasConnectedCall(messages),
      agreedToCall,
    };
  }

  #extractLinks(messages) {
    const links = new Set();
    for (const msg of messages) {
      if (!msg.entities?.length || !msg.message) continue;
      for (const ent of msg.entities) {
        if (ent.className === "MessageEntityTextUrl" && ent.url) {
          if (!ent.url.includes(RELEVANTY_DOMAIN)) links.add(ent.url);
        } else if (ent.className === "MessageEntityUrl") {
          const url = msg.message.slice(ent.offset, ent.offset + ent.length);
          if (!url.includes(RELEVANTY_DOMAIN)) links.add(url);
        }
      }
    }
    return [...links];
  }

  #extractMentions(outMessages) {
    const usernames = [];
    for (const msg of outMessages) {
      if (!msg.entities?.length || !msg.message) continue;
      for (const ent of msg.entities) {
        if (ent.className === "MessageEntityMention") {
          usernames.push(msg.message.slice(ent.offset, ent.offset + ent.length));
        }
      }
    }
    return usernames;
  }

  #hasConnectedCall(messages) {
    return messages.some(
      m => m.className === "MessageService" &&
        m.action?.className === "MessageActionPhoneCall" &&
        Number(m.action?.duration) > 0,
    );
  }

  #checkAgreedToCall(incomingMessages) {
    return incomingMessages.some(m =>
      m.message && AGREED_TO_CALL_PATTERNS.some(re => re.test(m.message)),
    );
  }
}

class ConversationCollector {
  #client;
  #analyzer = new ConversationAnalyzer();

  constructor(client) {
    this.#client = client;
  }

  async #loadTargetUsers() {
    const content = await readFile(PATHS.REPORT_CSV, "utf8");
    const lines = content.trim().split(/\r?\n/);
    const header = parseCsvLine(lines[0] ?? "").map(s => s.trim().toLowerCase());
    const statusIdx = header.includes("messagecount") ? 4 : 3;

    const users = new Set();
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      const user = cols[1]?.trim().toLowerCase();
      const status = cols[statusIdx]?.trim() ?? "";
      if (user && (status === "Success" || status.startsWith("Scheduled:"))) {
        users.add(user);
      }
    }
    return users;
  }

  async #buildDialogMap(targetUsers) {
    console.log("Fetching dialogs...");
    const map = new Map();
    let offsetDate = 0, offsetId = 0;
    let offsetPeer = new Api.InputPeerEmpty();

    for (let page = 0; page < 50; page++) {
      const result = await this.#client.invoke(new Api.messages.GetDialogs({
        offsetDate, offsetId, offsetPeer,
        limit: 100,
        hash: BigInt(0),
        excludePinned: false,
        folderId: null,
      }));

      if (!result?.dialogs?.length) break;

      for (const user of result.users ?? []) {
        const username = user.username ? `@${user.username.toLowerCase()}` : null;
        const idKey = `id:${user.id}`;
        if (username && targetUsers.has(username)) map.set(username, user);
        if (targetUsers.has(idKey)) map.set(idKey, user);
      }

      if (result.dialogs.length < 100) break;

      const lastMsg = result.messages?.[result.messages.length - 1];
      if (!lastMsg) break;
      offsetDate = lastMsg.date;
      offsetId = lastMsg.id;
      offsetPeer = result.dialogs[result.dialogs.length - 1].peer;
    }

    return map;
  }

  async collect() {
    const targetUsers = await this.#loadTargetUsers();
    console.log(`Users to analyze: ${targetUsers.size}`);

    const dialogMap = await this.#buildDialogMap(targetUsers);
    console.log(`Matched dialogs: ${dialogMap.size}`);

    const results = {};
    let i = 0;

    for (const [userKey, entity] of dialogMap) {
      i++;
      process.stdout.write(`\r[${i}/${dialogMap.size}] ${userKey}            `);
      try {
        const messages = await this.#client.getMessages(entity, { limit: MESSAGES_PER_CHAT });
        const analysis = this.#analyzer.analyze(messages);
        results[userKey] = { ...analysis, outcome: classifyOutcome(analysis) };
      } catch (err) {
        results[userKey] = { error: String(err.message) };
      }
      if (i < dialogMap.size) await sleep(FETCH_DELAY_MS);
    }

    console.log("\nCollection complete.");
    return results;
  }
}

// Outcome tiers (from highest to lowest):
// success_hard  — Zoom/Telemost link exchanged OR connected TG call
// success_soft  — we referred them to another person (@mention in our messages)
// interested    — they replied but no success signal
// no_reply      — zero incoming messages
function classifyOutcome({ hasExternalLink, hasConnectedCall, hasUsernameMention, repliesCount }) {
  if (hasExternalLink || hasConnectedCall) return "success_hard";
  if (hasUsernameMention) return "success_soft";
  if (repliesCount > 0) return "interested";
  return "no_reply";
}

async function connectClient() {
  const apiId = Number(process.env.API_ID);
  const apiHash = process.env.API_HASH;
  if (!apiId || !apiHash) throw new Error("API_ID/API_HASH missing in .env");

  const client = new TelegramClient(
    new StringSession(process.env.SESSION_STRING ?? ""),
    apiId, apiHash,
    { connectionRetries: 5 },
  );

  const orig = { info: console.info, debug: console.debug, warn: console.warn };
  try {
    console.info = console.debug = console.warn = () => {};
    await client.connect();
  } finally {
    Object.assign(console, orig);
  }

  if (!await client.checkAuthorization()) {
    throw new Error("Session expired. Run the spammer first to refresh the session.");
  }

  return client;
}

export async function runAnalyticsCollect() {
  const client = await connectClient();
  try {
    const collector = new ConversationCollector(client);
    const results = await collector.collect();
    await mkdir(path.dirname(PATHS.CONVERSATIONS_JSON), { recursive: true });
    await writeFile(PATHS.CONVERSATIONS_JSON, JSON.stringify(results, null, 2) + "\n", "utf8");
    console.log(`Saved to ${PATHS.CONVERSATIONS_JSON}`);
  } finally {
    const orig = { info: console.info, debug: console.debug, warn: console.warn };
    try {
      console.info = console.debug = console.warn = () => {};
      await client.disconnect();
    } finally {
      Object.assign(console, orig);
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith("analytics-collect.js")) {
  runAnalyticsCollect().catch(err => { console.error(err); process.exit(1); });
}
