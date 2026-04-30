import path from "node:path";
import readline from "node:readline";
import { runSpammer, runTestSend } from "./index.js";
import { runParser } from "./parser.js";
import { runDiscordSpammer } from "./discord.js";
import { runDiscordParser } from "./discord-parser.js";
import { runAnalyticsCollect } from "./analytics-collect.js";
import { runAnalyticsReport } from "./analytics-report.js";
import { runCleanup } from "./cleanup-ids.js";
import { loadSettings, saveSettings } from "./settings.js";
import { loadAccounts, saveAccounts } from "./storage.js";
import { startClient, validateEnv, upsertEnvValue } from "./auth.js";
import { runSplash } from "./splash.js";
import { sleep } from "./utils.js";
import { loadListUsers } from "./io.js";
import { PATHS } from "./config.js";
import { t, setLang } from "./i18n.js";
import {
  R, COLORS,
  hideCursor, showCursor,
  sectionTitle,
  printBox,
  liveStats, clearLiveStats,
  skipLog, errorLog, peerFloodBox,
  printSummary,
  renderMenu, clearMenu,
} from "./animate.js";

// ── Raw-mode menu ─────────────────────────────────────────────────────────────
function showMenu(options, initialIndex = 0) {
  return new Promise((resolve) => {
    let selected = Math.max(0, Math.min(initialIndex, options.length - 1));
    const total  = options.length;

    hideCursor();
    renderMenu(options, selected);

    const onData = (key) => {
      if (key === "\x1b[A" || key === "\x1b[D") {
        selected = (selected - 1 + total) % total;
        renderMenu(options, selected);
      } else if (key === "\x1b[B" || key === "\x1b[C") {
        selected = (selected + 1) % total;
        renderMenu(options, selected);
      } else if (key === "\r" || key === "\n") {
        cleanup();
        clearMenu();
        const opt = options[selected];
        resolve(typeof opt === "object" ? opt.value : opt);
      } else if (key === "") {
        cleanup();
        showCursor();
        process.exit(0);
      }
    };

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      showCursor();
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
}

// ── y/n confirmation ──────────────────────────────────────────────────────────
function askConfirm() {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (key) => {
      if (key === "y" || key === "Y") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write(`${COLORS.yellow}y${R}\n`);
        resolve(true);
      } else if (key === "n" || key === "N" || key === "") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write(`${COLORS.gray}n${R}\n`);
        if (key === "") process.exit(0);
        resolve(false);
      }
    };

    process.stdin.on("data", onData);
  });
}

// ── Single-line text input ────────────────────────────────────────────────────
function askText(prompt, defaultVal = "") {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${COLORS.gray}${prompt}${R} ${COLORS.yellow}[${defaultVal}]${R} `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultVal);
    });
  });
}

// ── Multiline text input (empty line to finish) ───────────────────────────────
function askMultiline(prompt) {
  return new Promise((resolve) => {
    const lines = [];
    process.stdout.write(`  ${COLORS.gray}${prompt}${R}\n`);

    const ask = () => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("  > ", (line) => {
        rl.close();
        if (line === "") {
          resolve(lines.join("\n"));
        } else {
          lines.push(line);
          ask();
        }
      });
    };
    ask();
  });
}

// ── Tag helper ────────────────────────────────────────────────────────────────
const tag = (val) => `${COLORS.gray}[${COLORS.yellow}${val}${COLORS.gray}]${R}`;

// ── Source label map ──────────────────────────────────────────────────────────
const srcLabelMap = () => ({
  txt: t("txtLabel"),
  "saved-n": t("savedNLabel"),
  maxim: t("maximLabel"),
  "text-seq": t("textSeqLabel"),
});

// ── Header ────────────────────────────────────────────────────────────────────
const INNER = 50;

function printHeader(settings) {
  const hr    = "═".repeat(INNER);
  const title = t("header");
  const lpad  = Math.floor((INNER - title.length) / 2);
  const rpad  = INNER - title.length - lpad;

  const srcLabel = srcLabelMap()[settings.messageSource] || settings.messageSource;

  console.log();
  console.log(`${COLORS.cyan}╔${hr}╗${R}`);
  console.log(`${COLORS.cyan}║${R}${" ".repeat(lpad)}${COLORS.yellow}${title}${R}${" ".repeat(rpad)}${COLORS.cyan}║${R}`);
  console.log(`${COLORS.cyan}╚${hr}╝${R}`);
  console.log();
  console.log(
    `  ${COLORS.gray}${t("sourceTag")} ›${R}  ${COLORS.yellow}${srcLabel}${R}` +
    `   ${COLORS.gray}${t("modeTag")} ›${R}  ${COLORS.yellow}${settings.sendMode}${R}`
  );
  console.log();
}

// ── Append text config ────────────────────────────────────────────────────────
async function configureAppend(settings) {
  await sectionTitle(t("appendTitle"));
  const current = settings.maximAppendText || "";
  const preview = current.length > 20 ? current.slice(0, 19) + "…" : current;

  const opts = [];
  if (current) {
    opts.push({ name: `  ${t("appendKeep", preview)}`, value: "keep" });
    opts.push({ name: `  ${t("appendEdit")}`,          value: "edit"  });
    opts.push({ name: `  ${t("appendClear")}`,         value: "clear" });
  } else {
    opts.push({ name: `  ${t("appendNone")}`,          value: "keep"  });
    opts.push({ name: `  ${t("appendEdit")}`,          value: "edit"  });
  }

  const choice = await showMenu(opts);
  if (choice === "edit") {
    settings.maximAppendText = await askMultiline(t("appendEnterPrompt"));
  } else if (choice === "clear") {
    settings.maximAppendText = "";
  }
}

// ── Maxim sequence config (intervals + fixedN + append) ──────────────────────
async function configureSequence(settings) {
  await sectionTitle(t("seqConfigTitle"));

  const newIntervals = await askText(t("intervalsPrompt"), settings.maximIntervals || "");
  settings.maximIntervals = newIntervals;

  const newN = await askText(t("fixedNPrompt"), String(settings.maximN || 1));
  settings.maximN = parseInt(newN, 10) || settings.maximN || 1;

  await configureAppend(settings);
}

// ── Text sequence editor ──────────────────────────────────────────────────────
async function editTextSequence(messages) {
  while (true) {
    await sectionTitle(t("textSeqEditorTitle"));

    const opts = [];
    for (let i = 0; i < messages.length; i++) {
      const preview = messages[i].replace(/\n/g, " ").slice(0, 38);
      const truncated = messages[i].replace(/\n/g, " ").length > 38 ? preview + "…" : preview;
      opts.push({ name: `  ${i + 1}. ${truncated}`, value: `msg:${i}` });
    }
    if (messages.length === 0) {
      opts.push({ name: `  ${COLORS.gray}${t("textSeqEmpty")}${R}`, value: "_empty", muted: true });
    }
    opts.push({ name: `  ${COLORS.cyan}${t("textSeqAddTerminal")}${R}`, value: "add-terminal" });
    opts.push({ name: `  ${COLORS.cyan}${t("textSeqAddFile")}${R}`,     value: "add-file"     });
    opts.push({ name: `  ${COLORS.green}${t("textSeqDone")}${R}`,       value: "done"          });

    const choice = await showMenu(opts);

    if (choice === "done") return messages;
    if (choice === "_empty") continue;

    if (choice === "add-terminal") {
      const text = await askMultiline(t("textSeqEnterPrompt"));
      if (text.trim()) messages.push(text.trim());

    } else if (choice === "add-file") {
      let fileNames = [];
      try {
        const { readdir } = await import("node:fs/promises");
        const entries = await readdir(PATHS.MESSAGES_DIR, { withFileTypes: true });
        fileNames = entries
          .filter((e) => e.isFile() && e.name.endsWith(".txt"))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
      } catch { /* ignore */ }

      if (fileNames.length === 0) {
        console.log(`\n  ${COLORS.gray}${t("textSeqNoFiles")}${R}\n`);
        await sleep(1200);
        continue;
      }

      await sectionTitle(t("selectFileTitle"));
      const fileOpts = [
        ...fileNames.map((name) => ({ name: `  ${name}`, value: name })),
        { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "_back", muted: true },
      ];
      const chosen = await showMenu(fileOpts);
      if (chosen !== "_back") {
        try {
          const { readFile } = await import("node:fs/promises");
          const text = await readFile(path.resolve(PATHS.MESSAGES_DIR, chosen), "utf8");
          if (text.trim()) messages.push(text.trim());
        } catch (err) {
          console.log(`\n  ${COLORS.red}Error: ${err.message}${R}\n`);
          await sleep(1200);
        }
      }

    } else if (String(choice).startsWith("msg:")) {
      const idx = parseInt(choice.slice(4), 10);
      if (idx < 0 || idx >= messages.length) continue;

      const action = await showMenu([
        { name: `  ${t("textSeqEdit")}`,                             value: "edit"   },
        { name: `  ${COLORS.red}${t("textSeqDelete")}${R}`,          value: "delete" },
        { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "_back", muted: true },
      ]);

      if (action === "edit") {
        const newText = await askMultiline(t("textSeqEditPrompt"));
        if (newText.trim()) messages[idx] = newText.trim();
      } else if (action === "delete") {
        messages.splice(idx, 1);
      }
    }
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function runSettings() {
  while (true) {
    const settings = await loadSettings();
    await sectionTitle(t("settingsTitle"));

    const srcLabel  = srcLabelMap()[settings.messageSource] || settings.messageSource;
    const langLabel = settings.language === "ru" ? "RU" : "EN";

    const opts = [
      { name: `  ${t("settingSendMode").padEnd(18)} ${tag(settings.sendMode)}`,  value: "mode"     },
      { name: `  ${t("settingSource").padEnd(18)} ${tag(srcLabel)}`,             value: "source"   },
      { name: `  ${t("settingLanguage").padEnd(18)} ${tag(langLabel)}`,          value: "language" },
    ];

    if (settings.messageSource === "maxim") {
      opts.splice(2, 0, { name: `  ${t("settingIntervals").padEnd(18)} ${tag(settings.maximIntervals)}`, value: "maxim-intervals" });
      opts.splice(3, 0, { name: `  ${t("settingFixedN").padEnd(18)} ${tag(settings.maximN)}`,           value: "maxim-n"         });
    } else if (settings.messageSource === "saved-n") {
      opts.splice(2, 0, { name: `  ${t("settingForwardN").padEnd(18)} ${tag(settings.savedN)}`, value: "saved-n-count" });
    }

    opts.push({ name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true });

    const choice = await showMenu(opts);
    if (choice === "back") return;

    if (choice === "mode") {
      settings.sendMode = await showMenu([
        { name: `  ${t("scheduleOpt")}`, value: "schedule" },
        { name: `  ${t("instantOpt")}`,  value: "instant"  },
        { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
      ]);
      if (settings.sendMode === "back") continue;
    } else if (choice === "source") {
      settings.messageSource = await showMenu([
        { name: `  ${t("maximOpt")}`,    value: "maxim"    },
        { name: `  ${t("savedNOpt")}`,   value: "saved-n"  },
        { name: `  ${t("txtOpt")}`,      value: "txt"      },
        { name: `  ${t("textSeqOpt")}`,  value: "text-seq" },
        { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
      ]);
      if (settings.messageSource === "back") continue;
    } else if (choice === "language") {
      settings.language = await showMenu([
        { name: "  EN — English", value: "en" },
        { name: "  RU — Русский", value: "ru" },
        { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
      ], settings.language === "ru" ? 1 : 0);
      if (settings.language === "back") continue;
      setLang(settings.language);
    } else if (choice === "maxim-intervals") {
      settings.maximIntervals = await askText(t("intervalsPrompt"), settings.maximIntervals);
    } else if (choice === "maxim-n") {
      const val = await askText(t("fixedNPrompt"), String(settings.maximN));
      settings.maximN = parseInt(val, 10) || settings.maximN;
    } else if (choice === "saved-n-count") {
      const val = await askText(t("settingForwardN"), String(settings.savedN));
      settings.savedN = parseInt(val, 10) || settings.savedN;
    }

    await saveSettings(settings);
    console.log(`  ${COLORS.green}${t("savedConfirm")}${R}`);
    await sleep(600);
  }
}

// ── Toolkit ───────────────────────────────────────────────────────────────────
async function runToolkit() {
  while (true) {
    await sectionTitle(t("toolkitTitle"));

    const tool = await showMenu([
      { name: `  ${t("spammerTgOpt").padEnd(22)} ${t("spammerTgDesc")}`,      value: "telegram"          },
      { name: `  ${t("spammerDcOpt").padEnd(22)} ${t("spammerDcDesc")}`,      value: "discord"           },
      { name: `  ${t("parserTgOpt").padEnd(22)} ${t("parserTgDesc")}`,        value: "parser"            },
      { name: `  ${t("parserDcOpt").padEnd(22)} ${t("parserDcDesc")}`,        value: "discord-parser"    },
      { name: `  ${t("analyticsCollectOpt").padEnd(22)} ${t("analyticsCollectDesc")}`, value: "analytics-collect" },
      { name: `  ${t("analyticsReportOpt").padEnd(22)} ${t("analyticsReportDesc")}`,   value: "analytics-report"  },
      { name: `  ${t("cleanupOpt").padEnd(22)} ${t("cleanupDesc")}`,          value: "cleanup"           },
      { name: `  ${COLORS.gray}${t("backOpt")}${R}`,                          value: "back", muted: true },
    ]);

    if (tool === "back") return;

    console.log();
    try {
      if      (tool === "telegram")           { await startSpammer(); }
      else if (tool === "parser")             { await sectionTitle(t("parserTelegramTitle"));  await runParser(); }
      else if (tool === "discord-parser")     { await sectionTitle(t("parserDiscordTitle"));   await runDiscordParser(); }
      else if (tool === "discord")            { await sectionTitle(t("spammerDiscordTitle"));  await runDiscordSpammer(); }
      else if (tool === "analytics-collect")  { await sectionTitle(t("analyticsCollectTitle")); await runAnalyticsCollect(); }
      else if (tool === "analytics-report")   { await sectionTitle(t("analyticsReportTitle"));  await runAnalyticsReport(); }
      else if (tool === "cleanup")            { await sectionTitle(t("cleanupTitle"));          await runCleanup(); }
    } catch (err) {
      errorLog(t("toolkitTitle"), err.message ?? String(err));
    }
  }
}

// ── Account Management ────────────────────────────────────────────────────────
async function runAccounts() {
  while (true) {
    const accounts = await loadAccounts(PATHS.ACCOUNTS_JSON);
    const currentSession = process.env.SESSION_STRING || "";
    const activeAccount = accounts.find((a) => a.session === currentSession);
    const activeLabel = activeAccount ? activeAccount.name : (currentSession ? "Unknown / .env" : "None");

    await sectionTitle(t("accountsTitle"));
    console.log(`  ${COLORS.gray}${t("activeAccount")}: ${R}${COLORS.yellow}${activeLabel}${R}\n`);

    const choice = await showMenu([
      { name: `  ${t("switchAccount")}`, value: "switch" },
      { name: `  ${t("addAccount")}`,    value: "add"    },
      { name: `  ${t("deleteAccount")}`, value: "delete" },
      { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
    ]);

    if (choice === "back") return;

    if (choice === "add") {
      try {
        const { apiId, apiHash, forceSms, authMethod } = validateEnv();
        
        // Temporarily clear session to force new login
        const originalSession = process.env.SESSION_STRING;
        delete process.env.SESSION_STRING;
        
        const client = await startClient(apiId, apiHash, forceSms, authMethod);
        const me = await client.getMe();
        const session = client.session.save();
        const name = me.phone ? `+${me.phone}` : (me.username || me.firstName || "Account");
        
        // Restore session in env if it was there (startClient already updated it if we logged in)
        // But we want to manage it in accounts.json too
        const newAccounts = await loadAccounts(PATHS.ACCOUNTS_JSON);
        if (!newAccounts.find(a => a.session === session)) {
          newAccounts.push({ name, session });
          await saveAccounts(PATHS.ACCOUNTS_JSON, newAccounts);
        }
        
        console.log(`\n  ${COLORS.green}${t("accountAdded")}${R}\n`);
        await client.disconnect();
        await sleep(1500);
      } catch (err) {
        console.log(`\n  ${COLORS.red}Error: ${err.message}${R}\n`);
        await sleep(2000);
      }

    } else if (choice === "switch") {
      if (accounts.length === 0) {
        console.log(`\n  ${COLORS.gray}${t("noAccounts")}${R}\n`);
        await sleep(1200);
        continue;
      }

      await sectionTitle(t("selectAccountToSwitch"));
      const opts = [
        ...accounts.map((a) => ({ name: `  ${a.name}`, value: a })),
        { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
      ];
      const selected = await showMenu(opts);
      if (selected !== "back") {
        process.env.SESSION_STRING = selected.session;
        await upsertEnvValue(path.resolve(".env"), "SESSION_STRING", selected.session);
        console.log(`\n  ${COLORS.green}${t("accountSwitched")} ${selected.name}${R}\n`);
        await sleep(1200);
      }

    } else if (choice === "delete") {
      if (accounts.length === 0) {
        console.log(`\n  ${COLORS.gray}${t("noAccounts")}${R}\n`);
        await sleep(1200);
        continue;
      }

      await sectionTitle(t("selectAccountToDelete"));
      const opts = [
        ...accounts.map((a) => ({ name: `  ${a.name}`, value: a })),
        { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
      ];
      const selected = await showMenu(opts);
      if (selected !== "back") {
        console.log(`\n  ${COLORS.red}${t("confirmDelete")}${R}`);
        process.stdout.write("  ");
        if (await askConfirm()) {
          const filtered = accounts.filter(a => a.session !== selected.session);
          await saveAccounts(PATHS.ACCOUNTS_JSON, filtered);
          if (process.env.SESSION_STRING === selected.session) {
             delete process.env.SESSION_STRING;
             await upsertEnvValue(path.resolve(".env"), "SESSION_STRING", "");
          }
        }
      }
    }
  }
}

// ── Spammer confirmation + run ─────────────────────────────────────────────────
async function startSpammer() {
  const settings = await loadSettings();

  // ── 1. Send mode ───────────────────────────────────────────────────────────
  await sectionTitle(t("sendModeTitle"));
  const modeOpts = [
    { name: `  ${t("instantOpt")}`,  value: "instant"  },
    { name: `  ${t("scheduleOpt")}`, value: "schedule" },
    { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
  ];
  settings.sendMode = await showMenu(modeOpts, modeOpts.findIndex((o) => o.value === settings.sendMode));
  if (settings.sendMode === "back") return;

  // ── 2. Message source ──────────────────────────────────────────────────────
  await sectionTitle(t("sourceTitle"));
  const sourceOpts = [
    { name: `  ${t("maximOpt")}`,   value: "maxim"    },
    { name: `  ${t("savedNOpt")}`,  value: "saved-n"  },
    { name: `  ${t("txtOpt")}`,     value: "txt"      },
    { name: `  ${t("textSeqOpt")}`, value: "text-seq" },
  ];
  settings.messageSource = await showMenu(sourceOpts, sourceOpts.findIndex((o) => o.value === settings.messageSource));

  // ── 2.5. Sequence config ───────────────────────────────────────────────────
  if (settings.messageSource === "text-seq") {
    settings.textMessages = await editTextSequence(Array.isArray(settings.textMessages) ? settings.textMessages : []);
    await configureAppend(settings);
  } else if (settings.messageSource === "maxim") {
    await configureSequence(settings);
  }

  // ── 3. Pick message file (txt source only) ─────────────────────────────────
  let specificFile = settings.specificFile ?? null;
  if (settings.messageSource === "txt") {
    let txtFileNames = [];
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(PATHS.MESSAGES_DIR, { withFileTypes: true });
      txtFileNames = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    } catch { /* ignore */ }

    if (txtFileNames.length > 1) {
      await sectionTitle(t("selectFileTitle"));
      const fileOpts = [
        { name: `  ${t("randomFileOpt")}`, value: null },
        ...txtFileNames.map((name) => ({ name: `  ${name}`, value: name })),
      ];
      const defaultFileIdx = fileOpts.findIndex((o) => o.value === specificFile);
      specificFile = await showMenu(fileOpts, defaultFileIdx >= 0 ? defaultFileIdx : 0);
    } else if (txtFileNames.length === 1) {
      specificFile = txtFileNames[0];
    }
  } else {
    specificFile = null;
  }

  // ── 4. Target list ─────────────────────────────────────────────────────────
  let specificList = settings.specificList ?? null;
  {
    let listFileNames = [];
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(PATHS.LISTS_DIR, { withFileTypes: true });
      listFileNames = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    } catch { /* ignore */ }

    if (listFileNames.length > 1) {
      await sectionTitle(t("selectListTitle"));
      const listOpts = [
        { name: `  ${t("allListsOpt")}`, value: null },
        ...listFileNames.map((name) => ({ name: `  ${name}`, value: name })),
      ];
      const defaultListIdx = listOpts.findIndex((o) => o.value === specificList);
      specificList = await showMenu(listOpts, defaultListIdx >= 0 ? defaultListIdx : 0);
    } else if (listFileNames.length === 1) {
      specificList = listFileNames[0];
    }
  }

  await saveSettings({ ...settings, specificFile, specificList });

  // ── 5. Confirmation ────────────────────────────────────────────────────────
  let totalUsers = 0;
  let fileCount  = 0;
  try {
    const users = await loadListUsers(PATHS.LISTS_DIR);
    const filtered = specificList ? users.filter((u) => u.fileName === specificList) : users;
    totalUsers = filtered.length;
    if (specificList) {
      fileCount = 1;
    } else {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(PATHS.LISTS_DIR, { withFileTypes: true });
      fileCount = entries.filter((e) => e.isFile()).length;
    }
  } catch { /* ignore */ }

  const labels  = srcLabelMap();
  const msgLabel = specificFile ? specificFile : (labels[settings.messageSource] || settings.messageSource);
  const listLabel = specificList ?? t("allListsOpt");

  // Build sequence summary row for maxim / text-seq
  let seqSummary = null;
  if (settings.messageSource === "maxim") {
    const ivals = settings.maximIntervals
      ? t("seqIntervals", settings.maximIntervals)
      : t("seqFixedN", settings.maximN || 1);
    const appPart = settings.maximAppendText
      ? `  +  ${t("seqAppend", (settings.maximAppendText || "").slice(0, 14))}`
      : `  ·  ${t("seqNoAppend")}`;
    seqSummary = ivals + appPart;
  } else if (settings.messageSource === "text-seq") {
    const count = Array.isArray(settings.textMessages) ? settings.textMessages.length : 0;
    const appPart = settings.maximAppendText
      ? `  +  ${t("seqAppend", (settings.maximAppendText || "").slice(0, 14))}`
      : `  ·  ${t("seqNoAppend")}`;
    seqSummary = t("seqTextMsgs", count) + appPart;
  }

  const boxLines = [
    `${COLORS.gray}${t("sourceRow").padEnd(10)}${R}${COLORS.yellow}${msgLabel}${R}`,
    ...(seqSummary !== null
      ? [`${COLORS.gray}${t("sequenceRow").padEnd(10)}${R}${COLORS.yellow}${seqSummary}${R}`]
      : []),
    `${COLORS.gray}${t("listRow").padEnd(10)}${R}${COLORS.yellow}${listLabel}${R}`,
    `${COLORS.gray}${t("modeRow").padEnd(10)}${R}${COLORS.yellow}${settings.sendMode}${settings.sendMode === "schedule" ? t("scheduleSuffix") : ""}${R}`,
    `${COLORS.gray}${t("accountsRow").padEnd(10)}${R}${COLORS.yellow}${totalUsers.toLocaleString()}${R}${COLORS.gray}  ${t("acrossSuffix")} ${fileCount} ${t("filesSuffix")}${R}`,
    `${COLORS.gray}${t("continueQ")}${R}`,
  ];

  printBox(t("launchTitle"), boxLines, COLORS.cyan);

  process.stdout.write(`  `);
  const confirmed = await askConfirm();
  if (!confirmed) {
    console.log(`  ${COLORS.gray}${t("aborted")}${R}`);
    return;
  }

  await sectionTitle(t("spammerTelegramTitle"));

  // ── Progress handler ───────────────────────────────────────────────────────
  let startMs = Date.now();
  let sent    = 0;
  let skipped = 0;
  let errors  = 0;

  const onProgress = (event) => {
    if (event.type === "start") {
      startMs = Date.now();
      sent = skipped = errors = 0;
    } else if (event.type === "tick") {
      liveStats({
        current: event.index + 1,
        total:   event.total,
        user:    event.user,
        sent,
        skipped,
        errors,
        startMs,
        mode:    settings.sendMode,
      });
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
    await runSpammer({ ...settings, specificFile, specificList }, onProgress);
  } catch (err) {
    clearLiveStats();
    errorLog(t("spammerTelegramTitle"), err.message ?? String(err));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  process.on("SIGINT", () => { showCursor(); process.exit(0); });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (msg === "TIMEOUT") return;
  });

  const initSettings = await loadSettings();
  setLang(initSettings.language);

  await runSplash();

  while (true) {
    const settings = await loadSettings();
    printHeader(settings);

    const choice = await showMenu([
      { name: `  ${t("startOpt").padEnd(16)} ${t("startDesc")}`,      value: "start"    },
      { name: `  ${t("accountsOpt").padEnd(16)} ${t("accountsDesc")}`,  value: "accounts" },
      { name: `  ${t("toolkitOpt").padEnd(16)} ${t("toolkitDesc")}`,  value: "toolkit"  },
      { name: `  ${t("settingsOpt").padEnd(16)} ${t("settingsDesc")}`, value: "settings" },
      { name: `  ${COLORS.gray}${t("exitOpt")}${R}`,                  value: "exit", muted: true },
    ]);

    console.log();

    try {
      if      (choice === "start")    await startSpammer();
      else if (choice === "accounts") await runAccounts();
      else if (choice === "toolkit")  await runToolkit();
      else if (choice === "settings") await runSettings();
      else {
        console.log(`  ${COLORS.gray}${t("goodbye")}${R}\n`);
        process.exit(0);
      }
    } catch (err) {
      errorLog("Main", err.message ?? String(err));
    }
  }
}

main().catch((err) => {
  showCursor();
  console.error(err);
  process.exit(1);
});
