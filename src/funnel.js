// The three-question funnel.
//
// Three fixed questions, then an invite. Nothing is drafted by a model, so no
// reply can invent a fact.
//
// A yes of any strength advances, and is SCORED 1-10 for conviction: "ещё бы" is
// a 10, "допустим" is a 2, and both move to the next question — the score is how
// you tell a real yes from a shrug afterwards.
//
// Only an explicit "нет" ends a conversation. A question, an objection or a
// hedge is answered from reports/scenarios.json — 19 branches measured from real
// conversations, each with a human-written reply — and the funnel holds at the
// current question. If nothing in the playbook matches, it goes to a human
// rather than being guessed at.
//
//   Q1  Ты понимаешь почему до 30 надо накопить большое количество полезных связей?
//        нет → farewell
//        да  → Q2  У нас налажен уже процесс, хочешь с нами?
//               нет → farewell
//               да  → Q3  Ты ответил Да на оба вопроса, ты отвечаешь за свои слова?
//                      нет → farewell
//                      да  → invite
//
// Everything here is pure so the decision table can be tested without a
// Telegram client — see test/funnel.test.mjs.

import { matchScenario, TERMINAL_BRANCHES, HANDOFF_BRANCHES } from "./scenarios.js";

// ── The script ────────────────────────────────────────────────────────────────

export const QUESTIONS = [
  "Ты понимаешь почему до 30 надо накопить большое количество полезных связей?",
  "У нас налажен уже процесс, хочешь с нами?",
  "Ты ответил Да на оба вопроса, ты отвечаешь за свои слова?",
];

// Note: "хорошего" is spelled with Cyrillic х. The brief had a Latin x here —
// identical on screen, but it makes the word unsearchable and trips spam
// heuristics that look for mixed-script tokens.
export const FAREWELL =
  "Спасибо за честный ответ, извини что побеспокоил, всего хорошего!";

export const STEP = {
  ASK: "ask",           // send the next question
  INVITE: "invite",     // all three answered yes
  FAREWELL: "farewell", // close the conversation
  DONE: "done",         // nothing to do (already invited or already closed)
  WAIT: "wait",         // we asked, they have not answered yet
  SCENARIO: "scenario", // answer a known question, then hold at this question
  HANDOFF: "handoff",   // they named a time or gave a handle — a human takes it
  HUMAN: "human",       // nothing known matches; do not guess
};

// ── Normalization ─────────────────────────────────────────────────────────────

// Strip everything that is not a letter or a space: punctuation, emoji,
// zero-width joiners, variation selectors. Fold ё→е and lowercase, so "Да!!",
// "да 👍", "ДА." and "ЕЩЁ БЫ" all reduce to their bare words.
//
// Iterating code points (\p{L} with /u) rather than UTF-16 units matters here:
// a reply that is one astral emoji must normalize to "" and not to half a
// surrogate pair.
export function normalize(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// How convinced does the yes sound? Conviction is scored 1-10 so a lukewarm
// "допустим" can still advance the funnel while being marked for what it is.
// Order matters: the first pattern that matches sets the score, so the specific
// and emphatic forms are listed before the bare ones.
//
// The scale, roughly: 8-10 committed, 5-7 agreeing, 3-4 soft, 1-2 conceding the
// point without committing to anything.
const W2 = "[a-zа-яё0-9_]";
const yb = (src) => new RegExp(`(?<!${W2})(?:${src})(?!${W2})`, "i");

const YES_SCALE = [
  // Ordered by SPECIFICITY, not by score. A bare "да" matches inside "ну да"
  // and "думаю да", so every qualified form has to be tested first or the
  // hedges all score as a confident yes — which is exactly the distinction
  // this scale exists to make.
  [yb("еще бы|ещё бы"), 10],
  [yb("да конечно|конечно да|однозначно|обязательно|безусловно|разумеется|сто процентов"), 10],

  // Qualified: the word "да" is present but carried by a hedge.
  [yb("ну да|вроде да|скорее да|в целом да|как бы да|наверное да|наверно да"), 4],
  [yb("думаю да|полагаю да|может и да|возможно да|где-то да"), 3],

  // Hedges with no "да" at all — conceding the point, committing to nothing.
  [yb("допустим|пожалуй|отчасти|как-то так|более менее|более-менее|может быть|наверное|наверно|возможно|мб"), 2],

  // Emphatic and plain affirmatives.
  [yb("да да|дааа+"), 9],
  [yb("точно|верно|именно|в точку|правильно"), 8],
  [yb("да"), 8],
  [yb("конечно|согласен|согласна|поддерживаю|не против|не возражаю"), 7],
  [yb("ага|угу|ясно да|понимаю да"), 6],
  [yb("ок|окей|хорошо|ладно|идёт|идет"), 5],
];

// Why a message that is not a yes is not a yes. These do not change the outcome
// on their own — the scenario responder decides what to say — they label the
// conversation so the board explains itself.
// Stems, so these are plain substring patterns: yb() adds a trailing word
// boundary, which would stop a stem matching its inflected forms.
const REASONS = [
  [/подума|посмотрю|позже|потом|не сейчас|занят|некогда|сессия|завал/i, "needs_think"],
  [/что это|что за|расскажи|объясни|обьясни|не понял|не понимаю|подробнее|зачем|почему|в чём|в чем/i, "needs_explanation"],
  [/каждый день|не смогу|нет времени|не получится/i, "cannot_daily"],
];

// An explicit no is now the ONLY thing that ends a conversation. Hedging,
// questions and silence-adjacent answers are handled instead — a hedge gets a
// low score and the funnel continues.
// Idioms that contain "нет" but mean yes. Checked before NO, or "почему нет"
// ("why not") would be read as a refusal.
const YES_IDIOM = yb("почему нет|почему бы нет|почему бы и нет|отчего нет");
// "да нет" is a refusal in Russian despite opening with "да".
const NO_IDIOM = yb("да нет|ну нет|нет уж");

// Bare "не" is deliberately absent: it is a negation particle, not a refusal,
// and it appears in a large share of ordinary sentences — matching it turned
// "да, почему не" into an explicit no.
const NO = [
  yb("нет"),
  yb("не интересно|неинтересно|не интересует|не актуально|неактуально"),
  yb("не хочу|не буду|не надо|не нужно|откажусь|отказываюсь|пас"),
  yb("спасибо нет|нет спасибо|no|nope|not interested"),
  yb("удали|отпишись|не пиши|отстань"),
];

/**
 * Score how convinced an affirmative sounds.
 * @returns {number|null} 1-10, or null when the text is not affirmative at all.
 */
export function scoreYes(text) {
  // "+" is a complete answer in Russian chat, but normalize() strips it with the
  // rest of the punctuation, so it has to be read off the raw text.
  if (/^\s*[+\u{1F44D}\u2705]+\s*$/u.test(String(text ?? ""))) return 5;
  const norm = normalize(text);
  if (!norm) return null;
  for (const [re, score] of YES_SCALE) {
    if (re.test(norm)) return score;
  }
  return null;
}

// Labels for the score, so a board column reads as something other than a bare
// number.
export function convictionLabel(score) {
  if (score == null) return "—";
  if (score >= 9) return "committed";
  if (score >= 7) return "agreeing";
  if (score >= 5) return "soft yes";
  if (score >= 3) return "weak";
  return "conceding";
}

/**
 * Classify one inbound message.
 *
 * @returns {{ answer: "yes"|"no"|"other", reason: string, score: number|null }}
 *   score is the conviction of a yes (1-10), null for anything else.
 */
export function classify(text) {
  const norm = normalize(text);
  if (!norm) {
    // A bare "+" or a thumbs-up normalizes to nothing but is still an answer.
    const bare = scoreYes(text);
    return bare != null
      ? { answer: "yes", reason: convictionLabel(bare), score: bare }
      : { answer: "other", reason: "empty", score: null };
  }

  // Idioms first, then the explicit no. A no wins over a yes word in the same
  // sentence ("нет, не интересно").
  if (NO_IDIOM.test(norm)) return { answer: "no", reason: "explicit_no", score: null };
  if (YES_IDIOM.test(norm)) return { answer: "yes", reason: convictionLabel(6), score: 6 };
  if (NO.some((re) => re.test(norm))) {
    return { answer: "no", reason: "explicit_no", score: null };
  }

  // A question mark means they are asking, not answering — route it to the
  // scenario responder rather than reading it as agreement.
  const asksBack = /[?？]/.test(String(text));

  const score = asksBack ? null : scoreYes(norm);
  if (score != null) {
    return { answer: "yes", reason: convictionLabel(score), score };
  }

  for (const [re, label] of REASONS) {
    if (re.test(norm)) return { answer: "other", reason: label, score: null };
  }
  return { answer: "other", reason: asksBack ? "asks_back" : "not_a_yes", score: null };
}

// ── Where in the funnel a conversation already is ─────────────────────────────

// Fingerprints are matched against our own sent messages, so the stage survives
// a restart with no state file: the chat history *is* the state. Each is a
// distinctive fragment of its question, normalized the same way as replies.
const FINGERPRINTS = QUESTIONS.map((q) => normalize(q).slice(0, 40));
const FAREWELL_FP = normalize(FAREWELL).slice(0, 40);

/**
 * @param {string[]} outbound Text of every message we sent, oldest first.
 * @returns {{ asked: number, closed: boolean, invited: boolean }}
 *   asked — how many of the three questions have gone out (0-3).
 */
export function stageOf(outbound, { inviteMatcher = /discord\.gg\//i } = {}) {
  let asked = 0;
  let closed = false;
  let invited = false;

  for (const raw of outbound) {
    const norm = normalize(raw);
    if (norm.includes(FAREWELL_FP)) closed = true;
    if (inviteMatcher.test(raw)) invited = true;
    FINGERPRINTS.forEach((fp, i) => {
      if (norm.includes(fp)) asked = Math.max(asked, i + 1);
    });
  }
  return { asked, closed, invited };
}

/**
 * The whole decision table.
 *
 * @param {object} p
 * @param {string[]} p.outbound  our messages, oldest first
 * @param {string|null} p.lastInbound  their newest message, or null if they
 *   have not written since our last one
 * @returns {{ step: string, text: string|null, stage: number, answer: string|null, reason: string }}
 */
export function nextStep({ outbound = [], lastInbound = null, scenarios = null } = {}) {
  const { asked, closed, invited } = stageOf(outbound);

  if (closed) return { step: STEP.DONE, text: null, stage: asked, answer: null, reason: "already_closed", score: null };
  if (invited) return { step: STEP.DONE, text: null, stage: 3, answer: null, reason: "already_invited", score: null };

  if (asked === 0) {
    return { step: STEP.ASK, text: QUESTIONS[0], stage: 1, answer: null, reason: "opening", score: null };
  }

  if (lastInbound === null || !String(lastInbound).trim()) {
    return { step: STEP.WAIT, text: null, stage: asked, answer: null, reason: "no_answer_yet", score: null };
  }

  const { answer, reason, score } = classify(lastInbound);
  // `stage` is the question we are about to ask; `answered` is the one they just
  // replied to. Scores belong to the latter — filing a Q1 answer under Q2 makes
  // the mark unreadable.
  const answered = asked;

  // An explicit no is the only thing that ends a conversation. Everything else
  // gets an answer of some kind.
  if (answer === "no") {
    return { step: STEP.FAREWELL, text: FAREWELL, stage: asked, answered, answer, reason, score };
  }

  // A yes of any strength advances, and carries its conviction with it: a 2/10
  // "допустим" moves to the next question exactly like a 10/10 "ещё бы", and the
  // score is what tells them apart afterwards.
  if (answer === "yes") {
    if (asked >= QUESTIONS.length) {
      return { step: STEP.INVITE, text: null, stage: 3, answered, answer, reason, score };
    }
    return { step: STEP.ASK, text: QUESTIONS[asked], stage: asked + 1, answered, answer, reason, score };
  }

  // Not a yes, not a no: a question, an objection, a hedge. Answer it from the
  // measured playbook and stay on the current question — their next message is
  // judged against the same one.
  const hit = scenarios ? matchScenario(lastInbound, scenarios) : null;
  if (hit) {
    if (TERMINAL_BRANCHES.has(hit.key)) {
      return { step: STEP.FAREWELL, text: FAREWELL, stage: asked, answered, answer, reason: hit.key, score, branch: hit.key };
    }
    if (HANDOFF_BRANCHES.has(hit.key)) {
      return { step: STEP.HANDOFF, text: hit.reply, stage: asked, answered, answer, reason: hit.key, score, branch: hit.key, action: hit.action };
    }
    if (!hit.reply) {
      return { step: STEP.WAIT, text: null, stage: asked, answered, answer, reason: hit.key, score, branch: hit.key };
    }
    return { step: STEP.SCENARIO, text: hit.reply, stage: asked, answered, answer, reason: hit.key, score, branch: hit.key, seen: hit.seen };
  }

  // Nothing in the playbook matches. Queue it rather than improvise — an
  // unanswerable message is the one case where a human must look.
  return { step: STEP.HUMAN, text: null, stage: asked, answered, answer, reason: `unmatched: ${reason}`, score };
}

// ── Encoding-safe truncation ──────────────────────────────────────────────────

// slice() on a UTF-16 string can cut an emoji in half and leave a lone
// surrogate, which becomes U+FFFD once encoded — bad in a log line, worse in a
// JSON body. Cut by code point instead.
export function sliceChars(text, max) {
  const chars = [...String(text ?? "")];
  return chars.length > max ? chars.slice(0, max).join("") : chars.join("");
}
