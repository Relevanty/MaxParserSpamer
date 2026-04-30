import { sleep } from "./utils.js";
import { t } from "./i18n.js";

// ── Reset & cursor ─────────────────────────────────────────────────────────────
export const R          = "\x1b[0m";
export const hideCursor = () => process.stdout.write("\x1b[?25l");
export const showCursor = () => process.stdout.write("\x1b[?25h");
export const clearLine  = () => process.stdout.write("\r\x1b[2K");

// ── 5-Color Semantic System ────────────────────────────────────────────────────
export const COLORS = {
  cyan:    "\x1b[36m",   // primary — borders, headers
  yellow:  "\x1b[33m",   // accent  — values, current user
  green:   "\x1b[32m",   // success — ✓, sent count, fill
  red:     "\x1b[31m",   // error   — ✗, error boxes
  magenta: "\x1b[35m",   // warning — PEER_FLOOD
  gray:    "\x1b[90m",   // muted   — labels, skip logs
  white:   "\x1b[97m",
};

// Convenience wrappers
export const c = {
  cyan:    (s) => `${COLORS.cyan}${s}${R}`,
  yellow:  (s) => `${COLORS.yellow}${s}${R}`,
  green:   (s) => `${COLORS.green}${s}${R}`,
  red:     (s) => `${COLORS.red}${s}${R}`,
  magenta: (s) => `${COLORS.magenta}${s}${R}`,
  gray:    (s) => `${COLORS.gray}${s}${R}`,
};

// ── Rainbow ────────────────────────────────────────────────────────────────────
const RAINBOW = [
  COLORS.red, COLORS.yellow, COLORS.green,
  COLORS.cyan, "\x1b[34m", COLORS.magenta,
];

export function rainbow(text, offset = 0) {
  return text
    .split("")
    .map((ch, i) => ch === " " ? ch : RAINBOW[(i + offset) % RAINBOW.length] + ch + R)
    .join("");
}

// ── Typewriter ─────────────────────────────────────────────────────────────────
export async function typewrite(text, delayMs = 30) {
  for (const ch of text) {
    process.stdout.write(ch);
    await sleep(delayMs);
  }
}

// ── Spinner ────────────────────────────────────────────────────────────────────
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(label) {
  let frame = 0;
  let currentLabel = label;

  hideCursor();
  process.stdout.write(`${COLORS.cyan}${SPIN[0]}${R}  ${currentLabel}`);

  const id = setInterval(() => {
    frame = (frame + 1) % SPIN.length;
    clearLine();
    process.stdout.write(`${COLORS.cyan}${SPIN[frame]}${R}  ${currentLabel}`);
  }, 80);

  function stop() {
    clearInterval(id);
    clearLine();
    showCursor();
  }

  return {
    update(msg) { currentLabel = msg; },
    succeed(msg) { stop(); console.log(`${COLORS.green}✓${R}  ${msg}`); },
    fail(msg)    { stop(); console.log(`${COLORS.red}✗${R}  ${msg}`); },
    stop,
  };
}

// ── Progress bar (legacy, kept for compat) ────────────────────────────────────
export function progressBar(current, total, width = 32) {
  const pct    = total > 0 ? current / total : 0;
  const filled = Math.round(pct * width);
  const bar    = COLORS.green + "█".repeat(filled) + COLORS.gray + "░".repeat(width - filled) + R;
  const pad    = String(total).length;
  const nums   = `${COLORS.gray}${String(current).padStart(pad)} / ${total}${R}`;
  return `${COLORS.gray}Progress${R}  [${bar}]  ${nums}`;
}

// ── Section title ──────────────────────────────────────────────────────────────
export async function sectionTitle(label) {
  const bar    = "─".repeat(Math.max(0, 50 - label.length - 4));
  const prefix = `── ${label} `;
  console.log();
  hideCursor();
  process.stdout.write(COLORS.cyan + prefix);
  for (const ch of bar) {
    process.stdout.write(ch);
    await sleep(3);
  }
  process.stdout.write(`${R}\n\n`);
  showCursor();
}

// ── Box ────────────────────────────────────────────────────────────────────────
const BOX_INNER = 50;

export function printBox(title, lines, borderColor = COLORS.cyan) {
  const B       = borderColor;
  const titleFmt = ` ${title} `;
  const dashes  = "─".repeat(Math.max(0, BOX_INNER - 2 - titleFmt.length));
  const top     = `${B}┌─${titleFmt}${dashes}┐${R}`;
  const bottom  = `${B}└${"─".repeat(BOX_INNER)}┘${R}`;
  const empty   = `${B}│${R}${" ".repeat(BOX_INNER)}${B}│${R}`;
  const row     = (text) => {
    // strip ANSI for length calc
    const bare = text.replace(/\x1b\[[0-9;]*m/g, "");
    const pad  = Math.max(0, BOX_INNER - 3 - bare.length);
    return `${B}│${R}   ${text}${" ".repeat(pad)}${B}│${R}`;
  };

  console.log();
  console.log(top);
  console.log(empty);
  for (const line of lines) console.log(row(line));
  console.log(empty);
  console.log(bottom);
  console.log();
}

// ── Live Stats (4-line in-place block) ────────────────────────────────────────
let _liveLines = 0;

export function liveStats({ current, total, user, sent, skipped, errors, startMs, mode }) {
  // Wipe previous render
  if (_liveLines > 0) {
    process.stdout.write(`\x1b[${_liveLines}A`);
    for (let i = 0; i < _liveLines; i++) process.stdout.write("\r\x1b[2K\n");
    process.stdout.write(`\x1b[${_liveLines}A`);
  }

  const pct    = total > 0 ? current / total : 0;
  const pctStr = `${Math.floor(pct * 100)}%`.padStart(4);
  const filled = Math.round(pct * 32);
  const bar    = COLORS.green + "█".repeat(filled) + COLORS.gray + "░".repeat(32 - filled) + R;
  const pad    = String(total).length;

  // ETA
  const elapsed = Date.now() - startMs;
  let etaStr    = "—";
  if (pct > 0.005 && elapsed > 500) {
    const leftMs  = (elapsed / pct) * (1 - pct);
    const leftSec = Math.ceil(leftMs / 1000);
    etaStr = leftSec > 60 ? `~${Math.ceil(leftSec / 60)} min` : `~${leftSec} sec`;
  }

  const userStr  = (user || "").length > 34 ? (user || "").slice(0, 33) + "…" : (user || "").padEnd(34);
  const errColor = errors > 0 ? COLORS.red : COLORS.gray;

  const output = [
    `  ${COLORS.gray}${t("progress")}${R}  [${bar}]  ${COLORS.gray}${String(current).padStart(pad)} / ${total}  ·  ${pctStr}${R}`,
    `  ${COLORS.gray}${t("current")}${R}   ${COLORS.yellow}${userStr}${R}`,
    `  ${COLORS.green}${t("sent")}  ${String(sent).padStart(4)}${R}    ${COLORS.gray}${t("skipped")}  ${String(skipped).padStart(4)}${R}    ${errColor}${t("errors")}  ${String(errors).padStart(3)}${R}`,
    `  ${COLORS.gray}${t("eta")}  ${etaStr}  ·  ${t("mode")}: ${mode || "—"}  ·  ${t("ctrlCStop")}${R}`,
  ];

  for (const line of output) process.stdout.write(line + "\n");
  _liveLines = output.length;
}

export function clearLiveStats() {
  if (_liveLines > 0) {
    process.stdout.write(`\x1b[${_liveLines}A`);
    for (let i = 0; i < _liveLines; i++) process.stdout.write("\r\x1b[2K\n");
    process.stdout.write(`\x1b[${_liveLines}A`);
    _liveLines = 0;
  }
}

// ── Parser Stats (3-line in-place block) ──────────────────────────────────────
export function parserStats({ messagesDone, usersFound, staleCount, staleLimit }) {
  if (_liveLines > 0) {
    process.stdout.write(`\x1b[${_liveLines}A`);
    for (let i = 0; i < _liveLines; i++) process.stdout.write("\r\x1b[2K\n");
    process.stdout.write(`\x1b[${_liveLines}A`);
  }

  const spin = SPIN[Math.floor(Date.now() / 80) % SPIN.length];
  
  let staleStr = "";
  if (staleLimit > 0) {
      const stalePct = Math.min(1, staleCount / staleLimit);
      const staleColor = stalePct > 0.8 ? COLORS.red : (stalePct > 0.5 ? COLORS.yellow : COLORS.green);
      staleStr = `  ·  ${COLORS.gray}${t("stale")}:${R} ${staleColor}${staleCount} / ${staleLimit}${R}`;
  }

  const output = [
    `  ${COLORS.cyan}${spin}${R}  ${COLORS.gray}${t("scanningGroup")}${R}`,
    `  ${COLORS.gray}${t("messagesChecked")} ${R} ${COLORS.yellow}${messagesDone}${R}`,
    `  ${COLORS.green}${t("usersExtracted")}  ${R} ${COLORS.green}${usersFound}${R}${staleStr}`,
  ];

  for (const line of output) process.stdout.write(line + "\n");
  _liveLines = output.length;
}

// ── Skip log (compact, below live block) ──────────────────────────────────────
export function skipLog(user, reason) {
  process.stdout.write(
    `  ${COLORS.gray}↷  ${(user || "").padEnd(28)}—  ${reason}${R}\n`
  );
}

// ── Error box ──────────────────────────────────────────────────────────────────
export function errorLog(user, message) {
  printBox(t("errorBoxTitle"), [
    `${COLORS.gray}${t("userLabel")}    ${R}${COLORS.yellow}${user}${R}`,
    `${COLORS.gray}${t("messageLabel")} ${R}${message}`,
  ], COLORS.red);
}

// ── PEER_FLOOD box ─────────────────────────────────────────────────────────────
export function peerFloodBox(message) {
  printBox(t("peerFloodTitle"), [message], COLORS.magenta);
}

// ── Summary screen ─────────────────────────────────────────────────────────────
export function printSummary({ sent, skipped, errors, startMs }) {
  const elapsed  = Date.now() - startMs;
  const sec      = Math.floor(elapsed / 1000);
  const min      = Math.floor(sec / 60);
  const duration = min > 0 ? `${min} min ${sec % 60} sec` : `${sec} sec`;
  const hr       = COLORS.gray + "─".repeat(48) + R;

  console.log();
  console.log(`${COLORS.cyan}── ${t("sessionComplete")} ${"─".repeat(50 - t("sessionComplete").length - 4)}${R}`);
  console.log();
  console.log(`  ${COLORS.green}✓${R}  ${t("sentLabel").padEnd(9)} ${String(sent).padStart(5)}`);
  console.log(`  ${COLORS.gray}↷  ${t("skippedLabel").padEnd(9)} ${String(skipped).padStart(5)}  ${t("skippedNote")}${R}`);
  console.log(`  ${errors > 0 ? COLORS.red : COLORS.gray}✗  ${t("errorsLabel").padEnd(9)} ${String(errors).padStart(5)}${R}`);
  console.log();
  console.log(`  ${hr}`);
  console.log();
  console.log(`  ${COLORS.gray}⏱  ${t("duration").padEnd(9)} ${duration}${R}`);
  console.log(`  ${COLORS.gray}📊  ${t("report").padEnd(9)} ${t("reportFile")}${R}`);
  console.log(`  ${COLORS.gray}🔖  ${t("progressSaved").padEnd(9)} ${t("resumeNote")}${R}`);
  console.log();
}

// ── Menu renderer (in-place, arrow-key driven) ────────────────────────────────
let _menuLines = 0;

export function renderMenu(options, selectedIndex) {
  if (_menuLines > 0) {
    process.stdout.write(`\x1b[${_menuLines}A`);
    for (let i = 0; i < _menuLines; i++) process.stdout.write("\r\x1b[2K\n");
    process.stdout.write(`\x1b[${_menuLines}A`);
  }

  const lines = options.map((opt, i) => {
    const label  = typeof opt === "string" ? opt : opt.name;
    const muted  = typeof opt === "object" && opt.muted;
    const isSelected = i === selectedIndex;

    if (isSelected) {
      return `${COLORS.cyan}❯${R}   ${muted ? COLORS.gray : ""}${label}${muted ? R : ""}`;
    }
    return `${muted ? COLORS.gray : ""}    ${label}${muted ? R : ""}`;
  });

  for (const line of lines) process.stdout.write(line + "\n");
  _menuLines = lines.length;
}

export function clearMenu() {
  if (_menuLines > 0) {
    process.stdout.write(`\x1b[${_menuLines}A`);
    for (let i = 0; i < _menuLines; i++) process.stdout.write("\r\x1b[2K\n");
    process.stdout.write(`\x1b[${_menuLines}A`);
    _menuLines = 0;
  }
}
