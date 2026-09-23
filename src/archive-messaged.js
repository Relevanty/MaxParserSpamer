// Retroactive archive. The send flow archives chats going forward; this cleans
// up the backlog: for a chosen account it reads the messaged-users history
// (processed-users.json, main + per-profile), scans the account's current chats,
// and moves every already-messaged one into Telegram's Archive folder.
//
// Matching is by normalized username or numeric id, so only chats we actually
// messaged are touched — personal chats are left alone.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Api } from "telegram";

import { R, COLORS, sectionTitle } from "./animate.js";
import { showMenu, askConfirm } from "./prompt.js";
import { startClient, validateEnv, getErrorMessage } from "./auth.js";
import { loadAccounts } from "./storage.js";
import { PATHS } from "./config.js";
import { t } from "./i18n.js";
import { sleep } from "./utils.js";

const norm = (s) => String(s ?? "").trim().replace(/^@/, "").toLowerCase();

// Union of every processed-users ledger: the main file plus each per-profile
// storage/<profile>/processed-users.json (multi-account runs write there).
async function loadMessagedKeys() {
  const files = [PATHS.PROCESSED_USERS_JSON];
  try {
    const entries = await readdir(path.resolve("storage"), { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) files.push(path.resolve("storage", e.name, "processed-users.json"));
    }
  } catch { /* no storage dir yet */ }

  const keys = new Set();
  for (const f of files) {
    try {
      const data = JSON.parse(await readFile(f, "utf8"));
      if (Array.isArray(data.processed)) for (const k of data.processed) if (k) keys.add(norm(k));
    } catch { /* missing / malformed — skip */ }
  }
  return keys;
}

async function findMessagedDialogs(client, keys) {
  const matches = [];
  const dialogs = await client.getDialogs({});
  for (const d of dialogs) {
    if (!d.isUser || d.archived) continue;
    const ent = d.entity;
    if (!ent || ent.bot) continue;
    const candidates = [norm(ent.username), String(ent.id)];
    if (candidates.some((c) => c && keys.has(c))) matches.push(d);
  }
  return matches;
}

async function archiveDialogs(client, dialogs, onLog) {
  let archived = 0;
  for (let i = 0; i < dialogs.length; i += 100) {
    const chunk = dialogs.slice(i, i + 100);
    const folderPeers = [];
    for (const d of chunk) {
      try {
        const peer = await client.getInputEntity(d.entity);
        folderPeers.push(new Api.InputFolderPeer({ peer, folderId: 1 }));
      } catch { /* skip peers we can't resolve */ }
    }
    if (!folderPeers.length) continue;
    try {
      await client.invoke(new Api.folders.EditPeerFolders({ folderPeers }));
      archived += folderPeers.length;
    } catch (err) {
      onLog(getErrorMessage(err));
    }
    await sleep(500); // be gentle with the API between batches
  }
  return archived;
}

export async function runArchiveMessaged() {
  const accounts = await loadAccounts(PATHS.ACCOUNTS_JSON);
  const activeSession = process.env.SESSION_STRING || "";

  let session = activeSession;
  if (accounts.length > 0) {
    await sectionTitle(t("archMsgPickAccount"));
    const picked = await showMenu([
      ...accounts.map((a) => ({
        name: `  ${a.name}${a.session === activeSession ? `  ${COLORS.gray}${t("savedMsgActiveTag")}${R}` : ""}`,
        value: a,
      })),
      { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "__back", muted: true },
    ]);
    if (picked === "__back") return;
    session = picked.session;
  } else if (!activeSession) {
    console.log(`\n  ${COLORS.gray}${t("noAccounts")}${R}\n`);
    await sleep(1500);
    return;
  }

  const keys = await loadMessagedKeys();
  if (keys.size === 0) {
    console.log(`\n  ${COLORS.gray}${t("archMsgNoHistory")}${R}\n`);
    await sleep(2000);
    return;
  }

  const prevSession = process.env.SESSION_STRING;
  let client;
  try {
    const { apiId, apiHash, forceSms, authMethod } = validateEnv();
    process.env.SESSION_STRING = session;
    await sectionTitle(t("archMsgTitle"));
    console.log(`  ${COLORS.gray}${t("savedMsgConnecting")}${R}`);
    client = await startClient(apiId, apiHash, forceSms, authMethod);

    console.log(`  ${COLORS.gray}${t("archMsgScanning")}${R}`);
    const matches = await findMessagedDialogs(client, keys);
    if (matches.length === 0) {
      console.log(`\n  ${COLORS.gray}${t("archMsgNone")}${R}\n`);
      await sleep(2000);
      return;
    }

    console.log(`\n  ${COLORS.yellow}${t("archMsgFound", matches.length)}${R}`);
    console.log(`  ${COLORS.gray}${t("archMsgConfirm", matches.length)}${R}`);
    process.stdout.write("  ");
    if (!(await askConfirm())) return;

    const archived = await archiveDialogs(client, matches, (m) => console.log(`  ${COLORS.red}${m}${R}`));
    console.log(`\n  ${COLORS.green}${t("archMsgDone", archived)}${R}\n`);
    await sleep(2000);
  } catch (err) {
    console.log(`\n  ${COLORS.red}${getErrorMessage(err)}${R}\n`);
    await sleep(2000);
  } finally {
    if (prevSession === undefined) delete process.env.SESSION_STRING;
    else process.env.SESSION_STRING = prevSession;
    if (client) await client.disconnect().catch(() => {});
  }
}
