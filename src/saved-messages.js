// Saved Messages editor. The "maxim" send method forwards from an account's
// Telegram Saved Messages (the chat with yourself), sliced by intervals. This
// lets you curate that pool from inside the tool: view, add, edit, and delete
// an account's Saved Messages over the console — per account, since each account
// has its own Saved Messages.
//
// Messages are shown oldest → newest, the same order the maxim source walks them
// (index.js reverses getMessages("me")), so item #1 here is the first one sent.
import { R, COLORS, sectionTitle } from "./animate.js";
import { showMenu, askConfirm, askMultiline } from "./prompt.js";
import { startClient, validateEnv, getErrorMessage } from "./auth.js";
import { loadAccounts } from "./storage.js";
import { loadSettings } from "./settings.js";
import { PATHS } from "./config.js";
import { t } from "./i18n.js";
import { sleep } from "./utils.js";

// Which group each message falls into, mirroring how index.js slices the pool:
// only the newest `sum(intervals)` messages are used, counted back from the
// newest. Returns a Map of pool index -> group number (1 = newest group), so a
// message that has drifted into the wrong group is visible while curating.
function groupBoundaries(count, intervalsStr) {
  const intervals = String(intervalsStr || "")
    .split("-")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const marks = new Map();
  if (!intervals.length) return { marks, used: 0, need: 0 };

  const need = intervals.reduce((a, b) => a + b, 0);
  let cursor = count; // walk backwards from the newest message
  for (let g = 0; g < intervals.length && cursor > 0; g += 1) {
    const start = Math.max(0, cursor - intervals[g]);
    for (let i = start; i < cursor; i += 1) marks.set(i, g + 1);
    cursor = start;
  }
  return { marks, used: Math.min(count, need), need };
}

function preview(msg) {
  const txt = String(msg?.message || "").replace(/\s+/g, " ").trim();
  if (txt) return txt.length > 56 ? txt.slice(0, 55) + "…" : txt;
  if (msg?.media) return t("savedMsgMedia");
  return t("savedMsgEmptyItem");
}

async function editLoop(client, onInfo, settings = {}) {
  while (true) {
    let msgs = [];
    try {
      const raw = await client.getMessages("me", { limit: 100 });
      msgs = [...raw].reverse(); // oldest → newest (maxim send order)
    } catch (err) {
      console.log(`\n  ${COLORS.red}${getErrorMessage(err)}${R}\n`);
      await sleep(1800);
      return;
    }

    await sectionTitle(t("savedMsgTitle"));
    console.log(`  ${COLORS.gray}${t("savedMsgCount", msgs.length)}${R}\n`);

    const { marks } = groupBoundaries(msgs.length, settings.maximIntervals);
    const opts = [];
    msgs.forEach((m, i) => {
      const g = marks.get(i);
      const tag = g
        ? `${COLORS.cyan}[${t("savedMsgGroupTag", g)}]${R} `
        : marks.size
          ? `${COLORS.gray}[${t("savedMsgUnusedTag")}]${R} `
          : "";
      opts.push({ name: `  ${String(i + 1).padStart(2)}. ${tag}${preview(m)}`, value: `msg:${i}` });
    });
    if (msgs.length === 0) opts.push({ name: `  ${COLORS.gray}${t("savedMsgNone")}${R}`, value: "_none", muted: true });
    opts.push({ name: `  ${COLORS.cyan}${t("savedMsgAdd")}${R}`, value: "add" });
    opts.push({ name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true });

    const choice = await showMenu(opts);
    if (choice === "back") return;
    if (choice === "_none") continue;

    if (choice === "add") {
      // A new message always lands at the newest end, so it joins group 1 and
      // pushes the oldest message out of the pool — every other group shifts.
      if (marks.size) console.log(`\n  ${COLORS.yellow}${t("savedMsgAddWarn")}${R}\n`);
      const text = (await askMultiline(t("savedMsgEnter"))).trim();
      if (text) {
        try {
          await client.sendMessage("me", { message: text });
          onInfo(t("savedMsgAdded"));
          await sleep(500);
        } catch (err) {
          console.log(`\n  ${COLORS.red}${getErrorMessage(err)}${R}\n`);
          await sleep(1800);
        }
      }
      continue;
    }

    const idx = parseInt(String(choice).slice(4), 10);
    const m = msgs[idx];
    if (!m) continue;

    const act = await showMenu([
      { name: `  ${t("savedMsgEditItem")}`, value: "edit" },
      { name: `  ${COLORS.red}${t("savedMsgDeleteItem")}${R}`, value: "delete" },
      { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
    ]);

    if (act === "edit") {
      if (!m.message) {
        console.log(`\n  ${COLORS.gray}${t("savedMsgNotText")}${R}\n`);
        await sleep(1600);
        continue;
      }
      console.log(`\n  ${COLORS.gray}${t("savedMsgCurrent")}${R}`);
      console.log(`  ${m.message.replace(/\n/g, "\n  ")}\n`);
      const text = (await askMultiline(t("savedMsgEnter"))).trim();
      if (text && text !== m.message) {
        try {
          await client.editMessage("me", { message: m.id, text });
          onInfo(t("savedMsgEdited"));
          await sleep(500);
        } catch (err) {
          console.log(`\n  ${COLORS.red}${getErrorMessage(err)}${R}\n`);
          await sleep(1800);
        }
      }
    } else if (act === "delete") {
      console.log(`\n  ${COLORS.red}${t("savedMsgDeleteConfirm")}${R}`);
      process.stdout.write("  ");
      if (await askConfirm()) {
        try {
          await client.deleteMessages("me", [m.id], { revoke: true });
          onInfo(t("savedMsgDeleted"));
          await sleep(500);
        } catch (err) {
          console.log(`\n  ${COLORS.red}${getErrorMessage(err)}${R}\n`);
          await sleep(1800);
        }
      }
    }
  }
}

// Pick an account (or use the active session), connect as it, run the editor.
// Restores the previously active session afterward — like the flush-contacts
// flow — so opening the editor never changes which account is "active".
export async function runSavedMessagesManager() {
  const accounts = await loadAccounts(PATHS.ACCOUNTS_JSON);
  const activeSession = process.env.SESSION_STRING || "";

  let session = activeSession;
  if (accounts.length > 0) {
    await sectionTitle(t("savedMsgPickAccount"));
    const opts = [
      ...accounts.map((a) => ({
        name: `  ${a.name}${a.session === activeSession ? `  ${COLORS.gray}${t("savedMsgActiveTag")}${R}` : ""}`,
        value: a,
      })),
      { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "__back", muted: true },
    ];
    const picked = await showMenu(opts);
    if (picked === "__back") return;
    session = picked.session;
  } else if (!activeSession) {
    console.log(`\n  ${COLORS.gray}${t("noAccounts")}${R}\n`);
    await sleep(1500);
    return;
  }

  const onInfo = (msg) => console.log(`  ${COLORS.green}${msg}${R}`);
  const prevSession = process.env.SESSION_STRING;
  let client;
  try {
    const { apiId, apiHash, forceSms, authMethod } = validateEnv();
    process.env.SESSION_STRING = session;
    console.log(`\n  ${COLORS.gray}${t("savedMsgConnecting")}${R}`);
    client = await startClient(apiId, apiHash, forceSms, authMethod);
    await editLoop(client, onInfo, await loadSettings());
  } catch (err) {
    console.log(`\n  ${COLORS.red}${getErrorMessage(err)}${R}\n`);
    await sleep(2000);
  } finally {
    if (prevSession === undefined) delete process.env.SESSION_STRING;
    else process.env.SESSION_STRING = prevSession;
    if (client) await client.disconnect().catch(() => {});
  }
}
