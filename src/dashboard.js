import { R } from "./animate.js";

const CYAN = (s) => `\x1b[36m${s}${R}`;
const YELLOW = (s) => `\x1b[33m${s}${R}`;
const GREEN = (s) => `\x1b[32m${s}${R}`;
const RED = (s) => `\x1b[31m${s}${R}`;
const GRAY = (s) => `\x1b[90m${s}${R}`;
const BOLD = (s) => `\x1b[1m${s}${R}`;

export { CYAN, YELLOW, GREEN, RED, GRAY, BOLD };

/**
 * Format a single status line with label and value.
 */
export function statusLine(label, value, width = 45) {
  const labelStr = GRAY(label);
  const spaces = Math.max(1, width - label.length - String(value).length);
  return `${labelStr}${" ".repeat(spaces)}${YELLOW(value)}`;
}

/**
 * Build the top status bar with current settings.
 * Example:
 * source › txt files   mode › instant
 * maxim › intervals=2-1-2  N=1
 */
export function buildSettingsBar(settings) {
  const sourceLabel =
    {
      txt: "txt files",
      "saved-n": "Saved Messages",
      maxim: "Maxim Method",
    }[settings.messageSource] || settings.messageSource;

  let line1 = `${GRAY("source ›")} ${YELLOW(sourceLabel)}`;
  line1 += `   ${GRAY("mode ›")} ${YELLOW(settings.sendMode)}`;

  let line2 = "";
  if (settings.messageSource === "maxim") {
    line2 = `${GRAY("maxim ›")} ${YELLOW(`intervals=${settings.maximIntervals}`)}  ${GRAY("N=")}${YELLOW(settings.maximN)}`;
  } else if (settings.messageSource === "saved-n") {
    line2 = `${GRAY("saved-n ›")} ${YELLOW(`count=${settings.savedN}`)}`;
  }

  return [line1, line2].filter(Boolean).join("\n");
}

/**
 * Build the bottom status bar with session stats.
 * Example: processed › 248   sent › 42   failed › 3   runtime › 18m
 */
export function buildStatsBar(stats = {}) {
  const { processed = 0, sent = 0, failed = 0, skipped = 0, runtime = "—" } = stats;

  return `${GRAY("processed ›")} ${YELLOW(processed)}   ${GRAY("sent ›")} ${GREEN(sent)}   ${GRAY("skipped ›")} ${YELLOW(skipped)}   ${GRAY("failed ›")} ${RED(failed)}   ${GRAY("runtime ›")} ${YELLOW(runtime)}`;
}

/**
 * Format menu option with icon and description.
 */
export function menuOption(icon, title, desc) {
  const titleStr = BOLD(`${icon} ${title}`);
  const descStr = GRAY(desc);
  return `${titleStr}\n  ${descStr}`;
}

/**
 * Format grouped section header.
 */
export function sectionHeader(title) {
  const line = "─".repeat(Math.max(30, title.length + 4));
  return `\n${CYAN(`┌─ ${title} ${line.slice(title.length + 3)}`)}`;
}

/**
 * Format grouped section footer.
 */
export function sectionFooter() {
  return CYAN(`└${"─".repeat(52)}`);
}

/**
 * Build a grouped toolkit menu with icons and sections.
 */
export function buildGroupedToolkit() {
  const options = [
    {
      group: "📥 DATA SOURCES",
      items: [
        {
          name: "Parser — Telegram",
          desc: "extract users from group/channel",
          value: "parser",
        },
        {
          name: "Parser — Discord",
          desc: "fetch member IDs from server",
          value: "discord-parser",
        },
        {
          name: "Spammer — Discord",
          desc: "DM all server members",
          value: "discord",
        },
      ],
    },
    {
      group: "📊 ANALYTICS & REPORTING",
      items: [
        {
          name: "Analytics — Collect",
          desc: "gather conversations from Telegram",
          value: "analytics-collect",
        },
        {
          name: "Analytics — Report",
          desc: "generate CSV + HTML",
          value: "analytics-report",
        },
      ],
    },
    {
      group: "🧹 MAINTENANCE",
      items: [
        {
          name: "Cleanup",
          desc: "remove userId:accessHash from lists",
          value: "cleanup",
        },
      ],
    },
  ];

  return options;
}

/**
 * Format grouped toolkit for display.
 */
export function formatGroupedToolkit() {
  const groups = buildGroupedToolkit();
  let output = "";

  for (const group of groups) {
    output += sectionHeader(group.group);
    output += "\n";

    for (const item of group.items) {
      const name = BOLD(item.name);
      const desc = GRAY(item.desc);
      output += `│  ${name}\n│    ${desc}\n`;
    }

    output += sectionFooter();
    output += "\n";
  }

  return output;
}

/**
 * Build inquirer-compatible choices from grouped toolkit.
 */
export function buildGroupedToolkitChoices() {
  const groups = buildGroupedToolkit();
  const choices = [];

  for (const group of groups) {
    choices.push(new (require("inquirer").Separator)(CYAN(`\n  ${group.group}`)));

    for (const item of group.items) {
      const displayName = `  ${item.name}  ${GRAY(`— ${item.desc}`)}`;
      choices.push({
        name: displayName,
        value: item.value,
      });
    }
  }

  choices.push(new (require("inquirer").Separator)(""));
  choices.push({
    name: GRAY("  ← Back"),
    value: "back",
  });

  return choices;
}

/**
 * Build main menu with current settings inline.
 */
export function buildMainMenuChoices(settings, stats = {}) {
  const sourceLabel =
    {
      txt: "txt files",
      "saved-n": "Saved Messages",
      maxim: "Maxim Method",
    }[settings.messageSource] || settings.messageSource;

  const modeColor = settings.sendMode === "instant" ? RED : YELLOW;

  return [
    {
      name: `  ${BOLD("▶ START")}  send messages with ${sourceLabel} (${modeColor(settings.sendMode)})`,
      value: "start",
    },
    {
      name: `  ${BOLD("▶ TOOLKIT")}  parsers, discord, analytics, cleanup`,
      value: "toolkit",
    },
    {
      name: `  ${BOLD("▶ SETTINGS")}  source, mode, intervals`,
      value: "settings",
    },
    {
      name: `  ${BOLD("▶ EXIT")}`,
      value: "exit",
    },
  ];
}

/**
 * Build settings menu with inline toggles.
 */
export function buildSettingsChoices(settings) {
  const sourceLabel =
    {
      txt: "txt files",
      "saved-n": "Saved Messages",
      maxim: "Maxim Method",
    }[settings.messageSource] || settings.messageSource;

  const choices = [
    {
      name: `  ${BOLD("source")}  ${YELLOW(sourceLabel)}  ${GRAY("[SWITCH]")}`,
      value: "source",
    },
    {
      name: `  ${BOLD("mode")}  ${YELLOW(settings.sendMode)}  ${GRAY("[SWITCH]")}`,
      value: "mode",
    },
  ];

  if (settings.messageSource === "maxim") {
    choices.push({
      name: `  ${BOLD("maxim intervals")}  ${YELLOW(settings.maximIntervals)}  ${GRAY("[EDIT]")}`,
      value: "maxim-intervals",
    });
    choices.push({
      name: `  ${BOLD("maxim fixed N")}  ${YELLOW(settings.maximN)}  ${GRAY("[EDIT]")}`,
      value: "maxim-n",
    });
  } else if (settings.messageSource === "saved-n") {
    choices.push({
      name: `  ${BOLD("forward N messages")}  ${YELLOW(settings.savedN)}  ${GRAY("[EDIT]")}`,
      value: "saved-n-count",
    });
  }

  choices.push({
    name: GRAY("  ← Back"),
    value: "back",
  });

  return choices;
}

/**
 * Render a box-wrapped history list.
 */
export function renderHistoryList(historyEntries) {
  if (historyEntries.length === 0) {
    return CYAN(`╔${"═".repeat(54)}╗\n`) +
           CYAN(`║`) + `  No history yet`.padEnd(54) + CYAN(`║\n`) +
           CYAN(`╚${"═".repeat(54)}╝\n`);
  }

  let output = CYAN(`╔${"═".repeat(54)}╗\n`);
  output += CYAN(`║${BOLD("  RECENT SESSIONS").padEnd(56)}║\n`);
  output += CYAN(`╠${"═".repeat(54)}╣\n`);

  for (let i = 0; i < Math.min(5, historyEntries.length); i++) {
    const entry = historyEntries[historyEntries.length - 1 - i];
    const numStr = GRAY(`[${i + 1}]`);
    const actionStr = BOLD(entry.action.padEnd(18));
    const summaryStr = YELLOW(entry.summary || "—");
    const durationStr = GRAY(entry.duration);
    output += CYAN(`║`) + `  ${numStr} ${actionStr} ${summaryStr.padEnd(12)} ${durationStr}` + CYAN(`║\n`);
  }

  output += CYAN(`╚${"═".repeat(54)}╝\n`);
  return output;
}
