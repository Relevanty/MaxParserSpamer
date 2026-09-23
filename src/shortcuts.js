/**
 * Keyboard shortcuts handler for quick navigation.
 * Provides global shortcuts: S, T, G, I, ?, etc.
 */

import { R } from "./animate.js";

const CYAN = (s) => `\x1b[36m${s}${R}`;
const YELLOW = (s) => `\x1b[33m${s}${R}`;
const GRAY = (s) => `\x1b[90m${s}${R}`;
const BOLD = (s) => `\x1b[1m${s}${R}`;

export const SHORTCUTS = {
  S: { name: "START", desc: "Quick start with current settings" },
  T: { name: "TOOLKIT", desc: "Open toolkit menu" },
  G: { name: "SETTINGS", desc: "Open settings (Gear)" },
  I: { name: "TOGGLE MODE", desc: "Toggle instant ↔ schedule" },
  "?": { name: "HELP", desc: "Show keyboard shortcuts" },
  E: { name: "EXIT", desc: "Exit application" },
};

export const WORKFLOWS = [
  {
    num: 1,
    name: "Parse TG → Send Discord",
    steps: [
      "Toolkit → Parser — Telegram (extract users)",
      "Export CSV from storage/",
      "Toolkit → Discord Parser (import to server)",
      "Start → Send to Discord members",
    ],
  },
  {
    num: 2,
    name: "Schedule Messages to Peak Hours",
    steps: [
      "Settings → mode: schedule",
      "Settings → source: saved-n or txt files",
      "Start → Messages scheduled for peak Moscow hours",
    ],
  },
  {
    num: 3,
    name: "Quick Instant Send",
    steps: [
      "Settings → mode: instant (or press I)",
      "Start → Messages sent immediately",
      "View results in analytics-report.csv",
    ],
  },
  {
    num: 4,
    name: "Analyze Telegram Conversations",
    steps: [
      "Toolkit → Analytics — Collect",
      "Toolkit → Analytics — Report (CSV + HTML)",
      "Open report.html in browser",
    ],
  },
  {
    num: 5,
    name: "Clean Up ID Lists",
    steps: [
      "Add lists/ with user data",
      "Toolkit → Cleanup",
      "Removes userId:accessHash entries",
    ],
  },
];

/**
 * Render shortcuts guide.
 */
export function renderShortcuts() {
  let output = "\n";
  output += CYAN(`╔${"═".repeat(54)}╗\n`);
  output += CYAN(`║${BOLD("  KEYBOARD SHORTCUTS").padEnd(56)}║\n`);
  output += CYAN(`╠${"═".repeat(54)}╣\n`);

  for (const [key, shortcut] of Object.entries(SHORTCUTS)) {
    const keyStr = BOLD(key.padEnd(3));
    const nameStr = BOLD(shortcut.name.padEnd(15));
    const descStr = GRAY(shortcut.desc);
    output += CYAN(`║`) + `  ${keyStr} ${nameStr} ${descStr}` + CYAN(`║\n`);
  }

  output += CYAN(`╠${"═".repeat(54)}╣\n`);
  output += CYAN(`║${BOLD("  COMMON WORKFLOWS").padEnd(56)}║\n`);
  output += CYAN(`╠${"═".repeat(54)}╣\n`);

  for (const workflow of WORKFLOWS) {
    const numStr = BOLD(`[${workflow.num}]`);
    const nameStr = BOLD(workflow.name);
    output += CYAN(`║`) + `  ${numStr} ${nameStr}` + CYAN(`║\n`);
    for (const step of workflow.steps) {
      output += CYAN(`║`) + `     ${GRAY(step)}` + CYAN(`║\n`);
    }
  }

  output += CYAN(`╚${"═".repeat(54)}╝\n`);
  return output;
}

/**
 * Handle keyboard shortcut and return action or null.
 */
export function handleShortcut(key) {
  const upper = String(key).toUpperCase();

  if (upper === "S") return "start";
  if (upper === "T") return "toolkit";
  if (upper === "G") return "settings";
  if (upper === "I") return "toggle-mode";
  if (upper === "?") return "help";
  if (upper === "E") return "exit";

  return null;
}
