import { readFile, writeFile, unlink, rename, stat } from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";
import { PATHS } from "./config.js";
import { listListFiles } from "./io.js";
import { loadProcessedUsers } from "./storage.js";
import { reportPathForList } from "./report.js";
import { sectionTitle, errorLog, COLORS, R } from "./animate.js";
import { showMenu, askConfirm, askText, askCheckboxes } from "./prompt.js";
import { t } from "./i18n.js";
import { sleep, parseCsvLine } from "./utils.js";

// ── Entry key ──────────────────────────────────────────────────────────────────
// Mirrors parseUserEntry() + usernameKey() in index.js exactly, so "processed"
// / "duplicate" here means the same thing it means at send time: id:hash pairs
// key on the numeric id, everything else keys on the lowercased @username.
export function entryKey(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const idMatch = value.match(/^(\d+):(-?\d+)$/);
  if (idMatch) return `id:${idMatch[1]}`;
  const withAt = value.startsWith("@") ? value : `@${value}`;
  return withAt.toLowerCase();
}

async function readListLines(fileName) {
  const content = await readFile(path.join(PATHS.LISTS_DIR, fileName), "utf8");
  return content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

async function writeListLines(fileName, lines) {
  await writeFile(path.join(PATHS.LISTS_DIR, fileName), lines.length ? lines.join("\n") + "\n" : "", "utf8");
}

function sidecarPath(fileName) {
  return path.join(PATHS.LISTS_DIR, fileName.replace(/\.txt$/i, ".state.json"));
}

async function unlinkSidecar(fileName) {
  try { await unlink(sidecarPath(fileName)); } catch { /* no sidecar for this list */ }
}

// A list mutation shifts row order/count, which invalidates any saved resume
// index (storage/progress-state.json points at a row offset into the old
// content). Dropping it is safe: processed-users.json still prevents re-sends,
// the next run just re-scans from row 0 instead of resuming mid-list.
async function resetProgress() {
  try { await unlink(PATHS.PROGRESS_STATE_JSON); } catch { /* nothing to reset */ }
}

async function pause(ms = 1400) {
  await sleep(ms);
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${COLORS.gray}${promptText}${R} `, () => {
      rl.close();
      resolve();
    });
  });
}

async function noListsMessage() {
  console.log(`\n  ${COLORS.gray}${t("lmNoLists")}${R}\n`);
  await pause();
}

async function needTwoListsMessage() {
  console.log(`\n  ${COLORS.gray}${t("lmNeedTwoLists")}${R}\n`);
  await pause();
}

// ── Overview ───────────────────────────────────────────────────────────────────
function padRight(s, w) {
  return s.length >= w ? s.slice(0, w - 1) + "…" : s.padEnd(w);
}

function renderOverviewTable(rows) {
  const nameW = 30;
  const numW  = 9;
  const dateW = 12;

  const header = `  ${COLORS.gray}${"List".padEnd(nameW)}` +
    `${t("lmColTotal").padStart(numW)}${t("lmColUnique").padStart(numW)}` +
    `${t("lmColSent").padStart(numW)}${t("lmColPending").padStart(numW)}  ` +
    `${t("lmColModified").padEnd(dateW)}${R}`;
  const sep = `  ${COLORS.gray}${"─".repeat(nameW + numW * 4 + dateW + 2)}${R}`;

  console.log(header);
  console.log(sep);

  const totals = { total: 0, unique: 0, processed: 0, pending: 0 };
  for (const r of rows) {
    totals.total += r.total;
    totals.unique += r.unique;
    totals.processed += r.processed;
    totals.pending += r.pending;

    const pendingColor = r.pending > 0 ? COLORS.yellow : COLORS.gray;
    const dateStr = r.mtime ? r.mtime.toISOString().slice(0, 10) : "—";

    console.log(
      `  ${COLORS.white}${padRight(r.file, nameW)}${R}` +
      `${COLORS.gray}${String(r.total).padStart(numW)}${R}` +
      `${COLORS.gray}${String(r.unique).padStart(numW)}${R}` +
      `${COLORS.green}${String(r.processed).padStart(numW)}${R}` +
      `${pendingColor}${String(r.pending).padStart(numW)}${R}  ` +
      `${COLORS.gray}${dateStr.padEnd(dateW)}${R}`,
    );
  }

  console.log(sep);
  console.log(
    `  ${COLORS.white}${t("lmColTotalRow").padEnd(nameW)}${R}` +
    `${COLORS.gray}${String(totals.total).padStart(numW)}${R}` +
    `${COLORS.gray}${String(totals.unique).padStart(numW)}${R}` +
    `${COLORS.green}${String(totals.processed).padStart(numW)}${R}` +
    `${totals.pending > 0 ? COLORS.yellow : COLORS.gray}${String(totals.pending).padStart(numW)}${R}`,
  );
}

async function showOverview() {
  await sectionTitle(t("lmOverviewTitle"));
  const files = await listListFiles(PATHS.LISTS_DIR);
  if (files.length === 0) { await noListsMessage(); return; }

  const processed = await loadProcessedUsers(PATHS.PROCESSED_USERS_JSON);
  const rows = [];

  for (const file of files) {
    const lines = await readListLines(file);
    const uniqueKeys = new Set(lines.map(entryKey).filter(Boolean));
    let processedCount = 0;
    for (const key of uniqueKeys) if (processed.has(key)) processedCount++;

    let mtime = null;
    try { mtime = (await stat(path.join(PATHS.LISTS_DIR, file))).mtime; } catch { /* ignore */ }

    rows.push({
      file,
      total: lines.length,
      unique: uniqueKeys.size,
      processed: processedCount,
      pending: uniqueKeys.size - processedCount,
      mtime,
    });
  }

  console.log();
  renderOverviewTable(rows);
  console.log();
  await waitForEnter(t("lmPressEnter"));
}

// ── Per-chat reports ─────────────────────────────────────────────────────────────
// Reads the per-list CSV that index.js writes alongside the global report.csv
// (same columns, one file per source list — see report.js:reportPathForList)
// and rolls it up into counts so you can see a chat's send history without
// opening the file or grepping the global report.
function renderReportsTable(rows) {
  const nameW = 30;
  const numW  = 9;
  const dateW = 20;

  const active = rows.filter((r) => r.success + r.scheduled + r.skipped + r.errors > 0);
  if (active.length === 0) {
    console.log(`  ${COLORS.gray}${t("lmNoReportData")}${R}`);
    return;
  }

  const header = `  ${COLORS.gray}${"List".padEnd(nameW)}` +
    `${t("lmColSentReport").padStart(numW)}${t("lmColSkippedReport").padStart(numW)}${t("lmColErrorsReport").padStart(numW)}  ` +
    `${t("lmColLastActivity").padEnd(dateW)}${R}`;
  const sep = `  ${COLORS.gray}${"─".repeat(nameW + numW * 3 + dateW + 2)}${R}`;

  console.log(header);
  console.log(sep);

  for (const r of active) {
    const sent = r.success + r.scheduled;
    const errColor = r.errors > 0 ? COLORS.red : COLORS.gray;
    console.log(
      `  ${COLORS.white}${padRight(r.file, nameW)}${R}` +
      `${COLORS.green}${String(sent).padStart(numW)}${R}` +
      `${COLORS.gray}${String(r.skipped).padStart(numW)}${R}` +
      `${errColor}${String(r.errors).padStart(numW)}${R}  ` +
      `${COLORS.gray}${(r.lastTimestamp || "—").padEnd(dateW)}${R}`,
    );
  }
}

async function showReports() {
  await sectionTitle(t("lmReportsTitle"));
  const files = await listListFiles(PATHS.LISTS_DIR);
  if (files.length === 0) { await noListsMessage(); return; }

  const rows = [];
  for (const file of files) {
    let lines = [];
    try {
      const content = await readFile(reportPathForList(PATHS.REPORTS_DIR, file), "utf8");
      lines = content.trim().split(/\r?\n/).slice(1); // drop header row
    } catch { /* no sends logged for this list yet */ }

    let success = 0, scheduled = 0, skipped = 0, errors = 0, lastTimestamp = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      const timestamp = (cols[0] || "").trim();
      const status = (cols[5] || "").trim();
      if (timestamp && (!lastTimestamp || timestamp > lastTimestamp)) lastTimestamp = timestamp;

      if (status.startsWith("Success")) success++;
      else if (status.startsWith("Scheduled")) scheduled++;
      else if (status.startsWith("Skipped")) skipped++;
      else if (status.startsWith("Error") || status.includes("PEER_FLOOD") || status.includes("PERMANENT BLOCK")) errors++;
    }

    rows.push({ file, success, scheduled, skipped, errors, lastTimestamp });
  }

  console.log();
  renderReportsTable(rows);
  console.log();
  await waitForEnter(t("lmPressEnter"));
}

// ── Prune processed entries ─────────────────────────────────────────────────────
async function pruneProcessed() {
  const files = await listListFiles(PATHS.LISTS_DIR);
  if (files.length === 0) { await noListsMessage(); return; }

  const selected = await askCheckboxes(t("lmSelectListsPrune"), files.map((f) => ({ name: f, value: f })));
  if (selected.length === 0) return;

  const processed = await loadProcessedUsers(PATHS.PROCESSED_USERS_JSON);

  await sectionTitle(t("lmPruneTitle"));
  let totalRemoved = 0;

  for (const file of selected) {
    const lines = await readListLines(file);
    const kept = lines.filter((line) => {
      const key = entryKey(line);
      return !(key && processed.has(key));
    });
    const removed = lines.length - kept.length;

    if (removed > 0) {
      await writeListLines(file, kept);
      totalRemoved += removed;
      console.log(`  ${COLORS.green}${file}${R}  ${COLORS.gray}${t("lmRemoved", removed, kept.length)}${R}`);
    } else {
      console.log(`  ${COLORS.gray}${file}  ${t("lmNothingToRemove")}${R}`);
    }
  }

  if (totalRemoved > 0) {
    await resetProgress();
    console.log(`\n  ${COLORS.yellow}${t("lmProgressReset")}${R}\n`);
  } else {
    console.log();
  }
  await pause(1800);
}

// ── Cross-list dedup ─────────────────────────────────────────────────────────────
async function crossListDedup() {
  const files = await listListFiles(PATHS.LISTS_DIR);
  if (files.length < 2) { await needTwoListsMessage(); return; }

  await sectionTitle(t("lmDedupTitle"));

  const fileLines = {};
  for (const file of files) fileLines[file] = await readListLines(file);

  // First file (in sorted order) to mention a key "owns" it; every later
  // occurrence of that key — in any other file, including repeats — is a dup.
  const firstSeenFile = new Map();
  const dupKeysByFile = {};
  let dupCount = 0;

  for (const file of files) {
    for (const line of fileLines[file]) {
      const key = entryKey(line);
      if (!key) continue;
      if (!firstSeenFile.has(key)) {
        firstSeenFile.set(key, file);
      } else if (firstSeenFile.get(key) !== file) {
        (dupKeysByFile[file] ??= new Set()).add(key);
        dupCount++;
      }
    }
  }

  if (dupCount === 0) {
    console.log(`\n  ${COLORS.green}${t("lmNoDuplicates")}${R}\n`);
    await pause();
    return;
  }

  console.log(`\n  ${COLORS.yellow}${t("lmDupFound", dupCount)}${R}\n`);
  for (const file of files) {
    if (dupKeysByFile[file]) {
      console.log(`  ${COLORS.gray}${file.padEnd(30)}${R}${COLORS.red}-${dupKeysByFile[file].size}${R}`);
    }
  }
  console.log(`\n  ${COLORS.gray}${t("lmDupKeepPolicy")}${R}`);
  process.stdout.write("  ");
  if (!(await askConfirm())) return;

  for (const [file, keys] of Object.entries(dupKeysByFile)) {
    const kept = fileLines[file].filter((line) => !keys.has(entryKey(line)));
    await writeListLines(file, kept);
  }

  await resetProgress();
  console.log(`\n  ${COLORS.green}${t("lmDedupDone", dupCount)}${R}`);
  console.log(`  ${COLORS.yellow}${t("lmProgressReset")}${R}\n`);
  await pause(1800);
}

// ── Merge lists ────────────────────────────────────────────────────────────────
async function mergeLists() {
  const files = await listListFiles(PATHS.LISTS_DIR);
  if (files.length < 2) { await needTwoListsMessage(); return; }

  const selected = await askCheckboxes(t("lmSelectListsMerge"), files.map((f) => ({ name: f, value: f })));
  if (selected.length < 2) { await needTwoListsMessage(); return; }

  await sectionTitle(t("lmMergeTitle"));
  let destName = await askText(t("lmDestFileName"), "merged.txt");
  if (!destName.toLowerCase().endsWith(".txt")) destName += ".txt";

  const seen = new Set();
  const merged = [];
  for (const file of selected) {
    for (const line of await readListLines(file)) {
      const key = entryKey(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(line);
    }
  }

  let existing = [];
  try { existing = await readListLines(destName); } catch { /* destination is new */ }
  const existingKeys = new Set(existing.map(entryKey));
  const finalLines = [...existing, ...merged.filter((l) => !existingKeys.has(entryKey(l)))];

  await writeListLines(destName, finalLines);
  console.log(`\n  ${COLORS.green}${t("lmMergeDone", finalLines.length, destName)}${R}`);

  console.log(`\n  ${COLORS.yellow}${t("lmDeleteSourcesPrompt")}${R}`);
  process.stdout.write("  ");
  if (await askConfirm()) {
    for (const file of selected) {
      if (file === destName) continue;
      await unlink(path.join(PATHS.LISTS_DIR, file));
      await unlinkSidecar(file);
    }
    console.log(`  ${COLORS.green}${t("lmSourcesDeleted")}${R}`);
  }
  await resetProgress();
  await pause(1800);
}

// ── Rename a list ──────────────────────────────────────────────────────────────
async function renameList() {
  const files = await listListFiles(PATHS.LISTS_DIR);
  if (files.length === 0) { await noListsMessage(); return; }

  await sectionTitle(t("lmRenameTitle"));
  const opts = [
    ...files.map((f) => ({ name: `  ${f}`, value: f })),
    { name: `  ${COLORS.gray}${t("backOpt")}${R}`, value: "back", muted: true },
  ];
  const file = await showMenu(opts);
  if (file === "back") return;

  let newName = await askText(t("lmNewFileName"), file);
  if (!newName.toLowerCase().endsWith(".txt")) newName += ".txt";
  if (newName === file) return;

  const destPath = path.join(PATHS.LISTS_DIR, newName);
  try {
    await stat(destPath);
    console.log(`\n  ${COLORS.red}${t("lmNameTaken")}${R}\n`);
    await pause();
    return;
  } catch { /* destination free, proceed */ }

  await rename(path.join(PATHS.LISTS_DIR, file), destPath);

  try {
    await stat(sidecarPath(file));
    await rename(sidecarPath(file), sidecarPath(newName));
  } catch { /* no sidecar to carry over */ }

  console.log(`\n  ${COLORS.green}${t("lmRenamed", file, newName)}${R}\n`);
  await pause(1500);
}

// ── Delete lists ───────────────────────────────────────────────────────────────
async function deleteLists() {
  const files = await listListFiles(PATHS.LISTS_DIR);
  if (files.length === 0) { await noListsMessage(); return; }

  const selected = await askCheckboxes(t("lmSelectListsDelete"), files.map((f) => ({ name: f, value: f })));
  if (selected.length === 0) return;

  await sectionTitle(t("lmDeleteTitle"));
  console.log(`\n  ${COLORS.red}${t("lmDeleteConfirm", selected.length)}${R}`);
  process.stdout.write("  ");
  if (!(await askConfirm())) return;

  for (const file of selected) {
    await unlink(path.join(PATHS.LISTS_DIR, file));
    await unlinkSidecar(file);
  }

  await resetProgress();
  console.log(`\n  ${COLORS.green}${t("lmDeleted", selected.length)}${R}`);
  console.log(`  ${COLORS.yellow}${t("lmProgressReset")}${R}\n`);
  await pause(1800);
}

// ── Entry point ────────────────────────────────────────────────────────────────
export async function runListManager() {
  while (true) {
    await sectionTitle(t("listManagerTitle"));

    const choice = await showMenu([
      { name: `  ${t("lmOverviewOpt")}`,                    value: "overview" },
      { name: `  ${t("lmReportsOpt")}`,                     value: "reports"  },
      { name: `  ${t("lmPruneOpt")}`,                       value: "prune"    },
      { name: `  ${t("lmDedupOpt")}`,                       value: "dedup"    },
      { name: `  ${t("lmMergeOpt")}`,                       value: "merge"    },
      { name: `  ${t("lmRenameOpt")}`,                      value: "rename"   },
      { name: `  ${COLORS.red}${t("lmDeleteOpt")}${R}`,     value: "delete"   },
      { name: `  ${COLORS.gray}${t("backOpt")}${R}`,        value: "back", muted: true },
    ]);

    if (choice === "back") return;

    console.log();
    try {
      if      (choice === "overview") await showOverview();
      else if (choice === "reports")  await showReports();
      else if (choice === "prune")    await pruneProcessed();
      else if (choice === "dedup")    await crossListDedup();
      else if (choice === "merge")    await mergeLists();
      else if (choice === "rename")   await renameList();
      else if (choice === "delete")   await deleteLists();
    } catch (err) {
      errorLog(t("listManagerTitle"), err.message ?? String(err));
    }
  }
}
