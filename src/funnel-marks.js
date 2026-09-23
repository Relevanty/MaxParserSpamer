// Conversation marks.
//
// A yes is not a yes. "Ещё бы" and "допустим" both advance the funnel, so the
// only thing that separates a real prospect from someone being polite is how
// convinced each answer sounded. This records that: every answer's conviction
// score, per person, so the board and the review queue can rank people instead
// of just listing them.
//
// Stored as one JSON file rather than in the chat history, because the history
// can tell you *what* someone said but not how we judged it.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "./config.js";

const MARKS = path.join(path.dirname(PATHS.PROGRESS_STATE_JSON), "funnel-marks.json");

let cache = null;

export async function loadMarks() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(MARKS, "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}

// Written via a temp file + rename so an interrupt cannot leave a half-written
// JSON that the next run fails to parse — the marks are the only copy of this
// judgement, unlike progress state which can be rebuilt from the chat.
async function persist() {
  const tmp = MARKS + ".tmp";
  await mkdir(path.dirname(MARKS), { recursive: true });
  await writeFile(tmp, JSON.stringify(cache, null, 2) + "\n", "utf8");
  await rename(tmp, MARKS);
}

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Record one answer against a person.
 *
 * @param {string} handle
 * @param {object} d  a nextStep() decision
 * @returns {Promise<object>} the person's updated mark
 */
export async function mark(handle, d) {
  const all = await loadMarks();
  const m = all[handle] ?? { handle, scores: [], stage: 0, tags: [], first: new Date().toISOString() };

  // d.answered is the question they replied to; d.stage is the next one.
  if (typeof d.score === "number") {
    const q = d.answered ?? d.stage;
    const last = m.scores[m.scores.length - 1];
    // Re-running (a dry run, a retry, a restart) re-judges the same message, so
    // the same question+score must overwrite rather than append — otherwise each
    // pass drags the average toward whatever was scored twice.
    if (last && last.q === q && last.score === d.score) {
      last.at = new Date().toISOString();
    } else {
      m.scores.push({ q, score: d.score, at: new Date().toISOString() });
    }
  }
  m.stage = Math.max(m.stage ?? 0, d.stage ?? 0);
  m.last = new Date().toISOString();
  m.lastStep = d.step;
  m.lastReason = d.reason;

  // Tags are the quick filter: what happened to this person, not what they said.
  const tag = d.step === "invite" ? "invited"
    : d.step === "farewell" ? "closed"
    : d.step === "handoff" ? "needs-human-now"
    : d.step === "human" ? "unmatched"
    : d.step === "scenario" ? `asked:${d.branch ?? "?"}`
    : null;
  if (tag && !m.tags.includes(tag)) m.tags.push(tag);

  const nums = m.scores.map((s) => s.score);
  m.conviction = nums.length ? Math.round(avg(nums) * 10) / 10 : null;
  m.weakest = nums.length ? Math.min(...nums) : null;

  all[handle] = m;
  await persist();
  return m;
}

/** Compact rendering for a log line or a board cell: "2/10 conceding (q1)". */
export function summarize(m) {
  if (!m || !m.scores?.length) return "unscored";
  const parts = m.scores.map((s) => `q${s.q}:${s.score}`).join(" ");
  return `${m.conviction}/10 avg  [${parts}]${m.tags.length ? "  " + m.tags.join(",") : ""}`;
}

export { MARKS as MARKS_PATH };
