// Multi-Account Manager — interactive UI for configuring and launching several
// Telegram accounts in parallel. Edits storage/multi-account.json: per-profile
// account, proxy, and list assignment, a shared proxy pool, global send
// defaults, and a one-key "run all". Mirrors the menu conventions of
// lists-manager.js. The actual parallel run is delegated to tools/multi.js.
import path from "node:path";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

import { R, COLORS, sectionTitle } from "./animate.js";
import { showMenu, askConfirm, askText, askCheckboxes } from "./prompt.js";
import { loadAccounts } from "./storage.js";
import { loginAndSaveAccount } from "./auth.js";
import { floodProfilePhotos, clearProfilePhotos } from "./profile-photos.js";
import { listListFiles } from "./io.js";
import { PATHS } from "./config.js";
import { parseProxy, maskProxy, sleep, validateMultiConfig } from "./utils.js";
import { t } from "./i18n.js";

const CONFIG_PATH = path.resolve("storage", "multi-account.json");
const CLAIMS_PATH = path.resolve("storage", "shared-claims.json");
const MULTI_RUNNER = path.resolve("tools", "multi.js");

const DEFAULT_DEFAULTS = {
  sendMode: "instant",
  messageSource: "maxim",
  maximIntervals: "2-1-2",
  maximN: 1,
  allowExistingChats: false,
  ignoreProcessed: false,
  lang: "ru",
};

const stripTxt = (name) => String(name ?? "").replace(/\.txt$/i, "");

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      defaults: { ...DEFAULT_DEFAULTS, ...(parsed.defaults || {}) },
      proxies: Array.isArray(parsed.proxies) ? parsed.proxies.filter(Boolean) : [],
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
    };
  } catch {
    return null;
  }
}

async function saveConfig(cfg) {
  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

async function createConfigFromAccounts() {
  const all = await loadAccounts(PATHS.ACCOUNTS_JSON);
  const seen = new Set();
  const accounts = all.filter((a) => {
    const key = String(a.name ?? a.session ?? "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let lists = [];
  try {
    lists = (await listListFiles(PATHS.LISTS_DIR)).map(stripTxt);
  } catch { /* ignore */ }

  const n = Math.max(accounts.length, 1);
  const cfg = {
    defaults: { ...DEFAULT_DEFAULTS },
    proxies: [],
    accounts: (accounts.length ? accounts : [{ name: "REPLACE_ME", session: "" }]).map((a, i) => ({
      profile: `acct${i + 1}`,
      account: a.name,
      session: a.session,
      proxy: "",
      lists: lists.filter((_, idx) => idx % n === i),
    })),
  };
  await saveConfig(cfg);
  return cfg;
}

function accountLabel(entry) {
  return entry.account || (entry.session ? "session" : t("multiNoAccount"));
}

// Assigned list names, joined for a compact one-line summary. Falls back to the
// localized "0 list(s) assigned" when none are set; caps long assignments with a
// "+N" tail so the menu row stays readable.
function listsSummary(entry, max = 3) {
  const names = (entry.lists || []).map(stripTxt).filter(Boolean);
  if (names.length === 0) return t("multiListsAssigned", 0);
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} +${names.length - max}`;
}

function pad(str, width) {
  const s = String(str ?? "");
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

function printOverview(cfg) {
  const rows = cfg.accounts;
  console.log(
    `  ${COLORS.gray}${pad(t("multiColProfile"), 12)} ${pad(t("multiColAccount"), 18)} ${pad(t("multiColProxy"), 26)} ${t("multiColLists")}${R}`,
  );
  for (const e of rows) {
    const listsAndCap = e.messageLimit ? `${(e.lists || []).length}  ${COLORS.gray}(cap ${e.messageLimit})${R}` : `${(e.lists || []).length}`;
    console.log(
      `  ${COLORS.yellow}${pad(e.profile, 12)}${R} ${pad(accountLabel(e), 18)} ${pad(e.proxy ? maskProxy(e.proxy) : t("multiNoProxy"), 26)} ${listsAndCap}`,
    );
  }

  // Warn about the same account assigned to more than one profile.
  const byAccount = new Map();
  for (const e of rows) {
    const key = e.session || e.account;
    if (!key) continue;
    byAccount.set(key, (byAccount.get(key) || 0) + 1);
  }
  const dups = rows
    .filter((e) => (e.session || e.account) && byAccount.get(e.session || e.account) > 1)
    .map((e) => e.account)
    .filter((v, i, arr) => arr.indexOf(v) === i);
  if (dups.length) {
    console.log(`\n  ${COLORS.red}${t("multiDupAccountWarn", dups.join(", "))}${R}`);
  }
  console.log();
}

// ── Proxy assignment submenu (for one profile) ────────────────────────────────
async function setProxyForProfile(cfg, entry) {
  const opts = [
    ...(cfg.proxies.length ? [{ name: `  ${t("multiProxyPickPool")}`, value: "pool" }] : []),
    { name: `  ${t("multiProxyType")}`, value: "type" },
    { name: `  ${COLORS.red}${t("multiProxyClear")}${R}`, value: "clear" },
    { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
  ];
  const choice = await showMenu(opts);
  if (choice === "back") return;

  if (choice === "clear") {
    entry.proxy = "";
  } else if (choice === "pool") {
    const poolOpts = [
      ...cfg.proxies.map((p) => ({ name: `  ${maskProxy(p)}`, value: p })),
      { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "__back", muted: true },
    ];
    const picked = await showMenu(poolOpts);
    if (picked !== "__back") entry.proxy = picked;
  } else if (choice === "type") {
    const raw = await askText(t("multiProxyEnterPrompt"), entry.proxy || "");
    if (raw && !parseProxy(raw)) {
      console.log(`\n  ${COLORS.red}${t("multiProxyInvalid")}${R}\n`);
      await sleep(1500);
      return;
    }
    entry.proxy = raw;
    if (raw && !cfg.proxies.includes(raw)) cfg.proxies.push(raw); // remember it in the pool
  }
}

// ── Send overrides submenu (per profile) ──────────────────────────────────────
async function editOverrides(entry) {
  const modeChoice = await showMenu([
    { name: `  ${COLORS.gray}${t("multiOverridesInherit")}${R}`, value: "__inherit" },
    { name: `  ${t("instantOpt")}`, value: "instant" },
    { name: `  ${t("scheduleOpt")}`, value: "schedule" },
  ], entry.sendMode === "schedule" ? 2 : entry.sendMode === "instant" ? 1 : 0);
  if (modeChoice === "__inherit") delete entry.sendMode;
  else entry.sendMode = modeChoice;

  const srcChoice = await showMenu([
    { name: `  ${COLORS.gray}${t("multiOverridesInherit")}${R}`, value: "__inherit" },
    { name: `  ${t("maximOpt")}`, value: "maxim" },
    { name: `  ${t("savedNOpt")}`, value: "saved-n" },
    { name: `  ${t("txtOpt")}`, value: "txt" },
  ], ["maxim", "saved-n", "txt"].indexOf(entry.messageSource) + 1);
  if (srcChoice === "__inherit") delete entry.messageSource;
  else entry.messageSource = srcChoice;
}

// ── Per-profile editor ────────────────────────────────────────────────────────
async function editProfile(cfg, entry) {
  while (true) {
    await sectionTitle(t("multiEditTitle", entry.profile));
    console.log(`  ${COLORS.gray}${t("multiColAccount")}:${R} ${COLORS.yellow}${accountLabel(entry)}${R}`);
    console.log(`  ${COLORS.gray}${t("multiColProxy")}:${R} ${COLORS.yellow}${entry.proxy ? maskProxy(entry.proxy) : t("multiNoProxy")}${R}`);
    const assignedNames = (entry.lists || []).map(stripTxt).filter(Boolean);
    const listsValue = assignedNames.length
      ? `${t("multiListsAssigned", assignedNames.length)}${COLORS.gray} — ${COLORS.yellow}${assignedNames.join(", ")}`
      : t("multiListsAssigned", 0);
    console.log(`  ${COLORS.gray}${t("multiColLists")}:${R} ${COLORS.yellow}${listsValue}${R}`);
    console.log(`  ${COLORS.gray}${t("multiColLimit")}:${R} ${COLORS.yellow}${entry.messageLimit ? entry.messageLimit : t("multiLimitNone")}${R}`);
    const ivLabel = entry.maximIntervals
      ? `${entry.maximIntervals}${entry.maximN ? `${COLORS.gray}  (N ${entry.maximN})${R}${COLORS.yellow}` : ""}`
      : (entry.maximN ? `${t("multiFixedNShort")} ${entry.maximN}` : t("multiIntervalsInherit"));
    console.log(`  ${COLORS.gray}${t("multiColIntervals")}:${R} ${COLORS.yellow}${ivLabel}${R}\n`);

    const choice = await showMenu([
      { name: `  ${t("multiAssignAccount")}`, value: "account" },
      { name: `  ${t("multiSetProxy")}`, value: "proxy" },
      { name: `  ${t("multiAssignLists")}`, value: "lists" },
      { name: `  ${t("multiSetMessageLimit")}`, value: "limit" },
      { name: `  ${t("multiFloodPhotos")}`, value: "photos" },
      { name: `  ${t("multiClearPhotos")}`, value: "clearphotos" },
      { name: `  ${t("multiSendOverrides")}`, value: "overrides" },
      { name: `  ${t("multiSetIntervals")}`, value: "intervals" },
      { name: `  ${t("multiRename")}`, value: "rename" },
      { name: `  ${COLORS.red}${t("multiRemoveProfile")}${R}`, value: "remove" },
      { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
    ]);

    if (choice === "back") return;

    if (choice === "account") {
      const accounts = await loadAccounts(PATHS.ACCOUNTS_JSON);
      await sectionTitle(t("multiSelectAccount"));
      const picked = await showMenu([
        { name: `  ${COLORS.cyan}${t("multiLoginNewAccount")}${R}`, value: "__login" },
        ...accounts.map((a) => ({ name: `  ${a.name}`, value: a })),
        { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "__back", muted: true },
      ]);
      if (picked === "__login") {
        try {
          console.log(`\n  ${COLORS.gray}${t("multiLoggingIn")}${R}\n`);
          const acct = await loginAndSaveAccount();
          entry.account = acct.name;
          entry.session = acct.session;
          await saveConfig(cfg);
          console.log(`\n  ${COLORS.green}${t("accountAdded")}${R}\n`);
          await sleep(1500);
        } catch (err) {
          console.log(`\n  ${COLORS.red}${t("multiLoginError", err.message)}${R}\n`);
          await sleep(2000);
        }
      } else if (picked !== "__back") {
        entry.account = picked.name;
        entry.session = picked.session;
        await saveConfig(cfg);
      }
    } else if (choice === "proxy") {
      await setProxyForProfile(cfg, entry);
      await saveConfig(cfg);
    } else if (choice === "lists") {
      let files = [];
      try {
        files = await listListFiles(PATHS.LISTS_DIR);
      } catch { /* ignore */ }
      if (files.length === 0) {
        console.log(`\n  ${COLORS.gray}${t("lmNoLists")}${R}\n`);
        await sleep(1200);
        continue;
      }
      const assigned = new Set((entry.lists || []).map(stripTxt));
      // Which OTHER profiles already have each list, so you can see overlap
      // before double-assigning a chat across accounts.
      const alsoOn = new Map();
      for (const e of cfg.accounts) {
        if (e === entry) continue;
        for (const l of (e.lists || []).map(stripTxt)) {
          if (!alsoOn.has(l)) alsoOn.set(l, []);
          alsoOn.get(l).push(e.profile);
        }
      }
      const selected = await askCheckboxes(
        t("multiSelectLists"),
        files.map((f) => {
          const key = stripTxt(f);
          const on = alsoOn.get(key);
          const suffix = on && on.length ? `  ${t("multiListAlsoOn", on.join(", "))}` : "";
          return { name: `${f}${suffix}`, value: key, checked: assigned.has(key) };
        }),
      );
      entry.lists = selected;
      await saveConfig(cfg);
    } else if (choice === "limit") {
      const cur = entry.messageLimit ? String(entry.messageLimit) : "";
      const raw = (await askText(t("multiMessageLimitPrompt"), cur)).trim();
      if (raw === "") {
        delete entry.messageLimit;
      } else {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) entry.messageLimit = n;
        else delete entry.messageLimit;
      }
      await saveConfig(cfg);
    } else if (choice === "photos") {
      let session = entry.session;
      if (!session && entry.account) {
        const accounts = await loadAccounts(PATHS.ACCOUNTS_JSON);
        session = accounts.find((a) => a.name === entry.account)?.session;
      }
      if (!session) {
        console.log(`\n  ${COLORS.gray}${t("multiPhotoNoAccount")}${R}\n`);
        await sleep(1500);
        continue;
      }
      const seedUrl = (await askText(t("multiPhotoSeedPrompt"), "")).trim();
      if (!seedUrl) continue;
      const nStr = (await askText(t("multiPhotoCountPrompt"), "5")).trim();
      const count = Math.max(1, parseInt(nStr, 10) || 5);
      try {
        console.log(`\n  ${COLORS.cyan}${t("multiPhotoStarting", count)}${R}\n`);
        const uploaded = await floodProfilePhotos({
          session,
          proxy: entry.proxy || "",
          seedUrl,
          count,
          onProgress: (ev) => {
            if (ev.type === "uploaded") console.log(`  ${COLORS.green}✓${R}  ${COLORS.gray}${t("multiPhotoUploaded", `${ev.index}/${ev.total}`)}${R}`);
            else if (ev.type === "error") console.log(`  ${COLORS.red}✗${R}  ${COLORS.gray}${ev.message}${R}`);
            else if (ev.message) console.log(`  ${COLORS.gray}${ev.message}${R}`);
          },
        });
        console.log(`\n  ${COLORS.green}${t("multiPhotoDone", uploaded)}${R}\n`);
        await sleep(1800);
      } catch (err) {
        console.log(`\n  ${COLORS.red}${t("multiPhotoError", err.message)}${R}\n`);
        await sleep(2000);
      }
    } else if (choice === "clearphotos") {
      let session = entry.session;
      if (!session && entry.account) {
        const accounts = await loadAccounts(PATHS.ACCOUNTS_JSON);
        session = accounts.find((a) => a.name === entry.account)?.session;
      }
      if (!session) {
        console.log(`\n  ${COLORS.gray}${t("multiPhotoNoAccount")}${R}\n`);
        await sleep(1500);
        continue;
      }
      console.log(`\n  ${COLORS.red}${t("multiClearPhotosConfirm")}${R}`);
      process.stdout.write("  ");
      if (!(await askConfirm())) continue;
      try {
        console.log(`\n  ${COLORS.cyan}${t("multiClearPhotosStarting")}${R}\n`);
        const removed = await clearProfilePhotos({
          session,
          proxy: entry.proxy || "",
          onProgress: (ev) => {
            if (ev.type === "removed") console.log(`  ${COLORS.gray}${t("multiClearPhotosProgress", ev.count)}${R}`);
            else if (ev.message) console.log(`  ${COLORS.gray}${ev.message}${R}`);
          },
        });
        console.log(`\n  ${COLORS.green}${t("multiClearPhotosDone", removed)}${R}\n`);
        await sleep(1800);
      } catch (err) {
        console.log(`\n  ${COLORS.red}${t("multiClearPhotosError", err.message)}${R}\n`);
        await sleep(2000);
      }
    } else if (choice === "overrides") {
      await editOverrides(entry);
      await saveConfig(cfg);
    } else if (choice === "intervals") {
      // Per-account maxim intervals / N. Blank clears the override so this
      // account falls back to the global default set in "Global send defaults".
      await sectionTitle(t("multiIntervalsTitle", entry.profile));
      console.log(`  ${COLORS.gray}${t("multiIntervalsHint")}${R}\n`);
      const iv = (await askText(t("intervalsPrompt"), entry.maximIntervals ?? "")).trim();
      if (iv === "") delete entry.maximIntervals;
      else entry.maximIntervals = iv;
      const nRaw = (await askText(t("fixedNPrompt"), entry.maximN ? String(entry.maximN) : "")).trim();
      if (nRaw === "") {
        delete entry.maximN;
      } else {
        const n = parseInt(nRaw, 10);
        if (Number.isFinite(n) && n > 0) entry.maximN = n;
        else delete entry.maximN;
      }
      await saveConfig(cfg);
    } else if (choice === "rename") {
      const name = (await askText(t("multiProfileNamePrompt"), entry.profile)).trim();
      if (name && name !== entry.profile) {
        if (cfg.accounts.some((e) => e !== entry && e.profile === name)) {
          console.log(`\n  ${COLORS.red}${t("multiNameTaken")}${R}\n`);
          await sleep(1500);
        } else {
          entry.profile = name;
          await saveConfig(cfg);
        }
      }
    } else if (choice === "remove") {
      console.log(`\n  ${COLORS.red}${t("multiRemoveConfirm", entry.profile)}${R}`);
      process.stdout.write("  ");
      if (await askConfirm()) {
        cfg.accounts = cfg.accounts.filter((e) => e !== entry);
        await saveConfig(cfg);
        return;
      }
    }
  }
}

// ── Proxy pool manager ────────────────────────────────────────────────────────
function proxyUsageCount(cfg, proxy) {
  return cfg.accounts.filter((e) => e.proxy === proxy).length;
}

async function manageProxies(cfg) {
  while (true) {
    await sectionTitle(t("multiProxyTitle"));
    if (cfg.proxies.length === 0) {
      console.log(`  ${COLORS.gray}${t("multiProxyPoolEmpty")}${R}\n`);
    } else {
      for (const p of cfg.proxies) {
        console.log(`  ${COLORS.yellow}${maskProxy(p)}${R}  ${COLORS.gray}${t("multiProxyUsedBy", proxyUsageCount(cfg, p))}${R}`);
      }
      console.log();
    }

    const opts = [
      { name: `  ${COLORS.cyan}${t("multiProxyAdd")}${R}`, value: "add" },
      ...(cfg.proxies.length ? [{ name: `  ${t("multiProxyAutoAssign")}`, value: "auto" }] : []),
      ...cfg.proxies.map((p) => ({ name: `  ${maskProxy(p)}`, value: `edit:${p}` })),
      { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
    ];
    const choice = await showMenu(opts);
    if (choice === "back") return;

    if (choice === "add") {
      const raw = (await askText(t("multiProxyEnterPrompt"), "")).trim();
      if (raw && parseProxy(raw)) {
        if (!cfg.proxies.includes(raw)) cfg.proxies.push(raw);
        await saveConfig(cfg);
      } else if (raw) {
        console.log(`\n  ${COLORS.red}${t("multiProxyInvalid")}${R}\n`);
        await sleep(1500);
      }
    } else if (choice === "auto") {
      if (cfg.proxies.length === 0) {
        console.log(`\n  ${COLORS.gray}${t("multiProxyNoneToAssign")}${R}\n`);
        await sleep(1200);
        continue;
      }
      cfg.accounts.forEach((e, i) => { e.proxy = cfg.proxies[i % cfg.proxies.length]; });
      await saveConfig(cfg);
      console.log(`\n  ${COLORS.green}${t("multiProxyAutoAssignDone")}${R}\n`);
      await sleep(1200);
    } else if (String(choice).startsWith("edit:")) {
      const proxy = choice.slice(5);
      const sub = await showMenu([
        { name: `  ${t("multiProxyEdit")}`, value: "edit" },
        { name: `  ${COLORS.red}${t("multiProxyDelete")}${R}`, value: "delete" },
        { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
      ]);
      if (sub === "edit") {
        const raw = (await askText(t("multiProxyEnterPrompt"), proxy)).trim();
        if (raw && parseProxy(raw)) {
          const idx = cfg.proxies.indexOf(proxy);
          if (idx !== -1) cfg.proxies[idx] = raw;
          cfg.accounts.forEach((e) => { if (e.proxy === proxy) e.proxy = raw; });
          await saveConfig(cfg);
        } else if (raw) {
          console.log(`\n  ${COLORS.red}${t("multiProxyInvalid")}${R}\n`);
          await sleep(1500);
        }
      } else if (sub === "delete") {
        cfg.proxies = cfg.proxies.filter((p) => p !== proxy);
        cfg.accounts.forEach((e) => { if (e.proxy === proxy) e.proxy = ""; });
        await saveConfig(cfg);
      }
    }
  }
}

// ── Global send defaults ──────────────────────────────────────────────────────
async function editDefaults(cfg) {
  const d = cfg.defaults;
  await sectionTitle(t("multiGlobalDefaults"));

  d.sendMode = await showMenu([
    { name: `  ${t("instantOpt")}`, value: "instant" },
    { name: `  ${t("scheduleOpt")}`, value: "schedule" },
  ], d.sendMode === "schedule" ? 1 : 0);

  d.messageSource = await showMenu([
    { name: `  ${t("maximOpt")}`, value: "maxim" },
    { name: `  ${t("savedNOpt")}`, value: "saved-n" },
    { name: `  ${t("txtOpt")}`, value: "txt" },
  ], ["maxim", "saved-n", "txt"].indexOf(d.messageSource) < 0 ? 0 : ["maxim", "saved-n", "txt"].indexOf(d.messageSource));

  if (d.messageSource === "maxim") {
    d.maximIntervals = await askText(t("intervalsPrompt"), d.maximIntervals || "");
    const n = await askText(t("fixedNPrompt"), String(d.maximN || 1));
    d.maximN = parseInt(n, 10) || d.maximN || 1;
  }
  await saveConfig(cfg);
  console.log(`  ${COLORS.green}${t("multiSaved")}${R}`);
  await sleep(600);
}

// ── Launch all accounts (delegates to tools/multi.js) ─────────────────────────
async function runAll(cfg) {
  const runnable = cfg.accounts.filter((e) => e.profile && (e.session || e.account) && (e.lists || []).length);
  if (runnable.length === 0) {
    console.log(`\n  ${COLORS.red}${t("multiNeedProfiles")}${R}\n`);
    await sleep(1800);
    return;
  }

  const missingProxy = runnable.some((e) => !e.proxy);
  if (missingProxy) {
    console.log(`\n  ${COLORS.yellow}${t("multiNoProxyWarn")}${R}`);
    process.stdout.write("  ");
    if (!(await askConfirm())) return;
  }

  console.log(`\n  ${COLORS.cyan}${t("multiRunStarting", runnable.length)}${R}\n`);
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [MULTI_RUNNER], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: "inherit",
    });
    child.on("exit", () => resolve());
    child.on("error", (err) => {
      console.error(`  ${COLORS.red}${t("multiRunError", err.message)}${R}`);
      resolve();
    });
  });
  console.log(`\n  ${COLORS.green}${t("multiRunFinished")}${R}\n`);
  await sleep(1500);
}

// ── Entry point ───────────────────────────────────────────────────────────────
export async function runMultiManager() {
  let cfg = await loadConfig();

  if (!cfg) {
    await sectionTitle(t("multiTitle"));
    console.log(`  ${COLORS.gray}${t("multiNoConfig")}${R}\n`);
    const choice = await showMenu([
      { name: `  ${COLORS.cyan}${t("multiCreateConfig")}${R}`, value: "create" },
      { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
    ]);
    if (choice !== "create") return;
    cfg = await createConfigFromAccounts();
    console.log(`\n  ${COLORS.green}${t("multiConfigCreated")}${R}\n`);
    await sleep(1500);
  }

  while (true) {
    await sectionTitle(t("multiTitle"));
    console.log(`  ${COLORS.gray}${t("multiSubtitle", cfg.accounts.length)}${R}\n`);
    printOverview(cfg);

    const problems = validateMultiConfig(cfg);
    if (problems.length) {
      console.log(`  ${COLORS.red}${t("multiConfigProblems")}${R}`);
      for (const p of problems.slice(0, 6)) console.log(`    ${COLORS.red}✗${R} ${COLORS.gray}${p}${R}`);
      console.log();
    }

    const opts = [
      ...cfg.accounts.map((e, i) => ({
        name: `  ${COLORS.yellow}${e.profile}${R}  ${COLORS.gray}${accountLabel(e)} · ${listsSummary(e)} · ${e.messageLimit ? `cap ${e.messageLimit} · ` : ""}${e.proxy ? maskProxy(e.proxy) : t("multiNoProxy")}${R}`,
        value: `profile:${i}`,
      })),
      { name: `  ${COLORS.cyan}${t("multiAddProfile")}${R}`, value: "add" },
      { name: `  ${t("multiProxyManager")}`, value: "proxies" },
      { name: `  ${t("multiGlobalDefaults")}`, value: "defaults" },
      { name: `  ${COLORS.green}${t("multiRunAll")}${R}`, value: "run" },
      { name: `  ${COLORS.red}${t("multiResetClaims")}${R}`, value: "reset-claims" },
      { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
    ];

    const choice = await showMenu(opts);
    if (choice === "back") return;

    if (String(choice).startsWith("profile:")) {
      const idx = parseInt(choice.slice(8), 10);
      if (cfg.accounts[idx]) await editProfile(cfg, cfg.accounts[idx]);
    } else if (choice === "add") {
      const existing = new Set(cfg.accounts.map((e) => e.profile));
      let i = cfg.accounts.length + 1;
      while (existing.has(`acct${i}`)) i += 1;
      cfg.accounts.push({ profile: `acct${i}`, account: "", session: "", proxy: "", lists: [] });
      await saveConfig(cfg);
      await editProfile(cfg, cfg.accounts[cfg.accounts.length - 1]);
    } else if (choice === "proxies") {
      await manageProxies(cfg);
    } else if (choice === "defaults") {
      await editDefaults(cfg);
    } else if (choice === "run") {
      await runAll(cfg);
    } else if (choice === "reset-claims") {
      if (existsSync(CLAIMS_PATH)) await rm(CLAIMS_PATH, { force: true });
      console.log(`\n  ${COLORS.green}${t("multiClaimsReset")}${R}\n`);
      await sleep(1200);
    }
  }
}
