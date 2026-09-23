/**
 * Session history — track all runs so users can replay them.
 */

import fs from "node:fs/promises";
import path from "node:path";

const HISTORY_PATH = path.resolve("storage", "history.json");
const MAX_HISTORY = 10;

/**
 * Session entry schema:
 * {
 *   id: uuid-like string
 *   timestamp: ISO string
 *   action: "start" | "parser" | "discord" | etc.
 *   settings: { source, mode, ... }
 *   duration: milliseconds
 *   status: "success" | "error" | "skipped"
 *   summary: { sent, skipped, failed, etc. }
 * }
 */

export async function loadHistory() {
  try {
    const content = await fs.readFile(HISTORY_PATH, "utf8");
    return JSON.parse(content) || [];
  } catch {
    return [];
  }
}

export async function saveHistory(entries) {
  await fs.mkdir(path.resolve("storage"), { recursive: true });
  // Keep only last MAX_HISTORY entries
  const trimmed = entries.slice(-MAX_HISTORY);
  await fs.writeFile(HISTORY_PATH, JSON.stringify(trimmed, null, 2), "utf8");
}

export async function addHistoryEntry(entry) {
  const history = await loadHistory();
  history.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  });
  await saveHistory(history);
}

export function formatDuration(ms) {
  if (!ms) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${remSec}s`;
}

export function formatHistoryEntry(entry) {
  const date = new Date(entry.timestamp);
  const timeStr = date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  let summary = "";
  if (entry.summary) {
    const { sent, skipped, failed } = entry.summary;
    if (sent !== undefined) summary += `✓ ${sent}`;
    if (skipped !== undefined) summary += ` ⚠ ${skipped}`;
    if (failed !== undefined) summary += ` ✗ ${failed}`;
  }

  const durationStr = formatDuration(entry.duration);

  return {
    timestamp: timeStr,
    action: entry.action || "unknown",
    summary: summary || "—",
    duration: durationStr,
  };
}
