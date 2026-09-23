// Auto-responder for the known scenarios.
//
// reports/scenarios.json holds 19 conversation branches measured from 215 real
// occurrences — each with the reply that was actually used. Those replies are
// written by a human and pinned to verified facts, so answering from them needs
// no model and cannot invent a community size. That is the whole point: the
// funnel can now respond to a question instead of going silent, without any of
// the hallucination risk that made the old drafted replier dangerous.
//
// The file's `trigger` field is a prose description for a human reader, so the
// matchers below are written here, keyed to the branch names. Order matters:
// the most specific patterns are tried first.
import { readFile } from "node:fs/promises";
import path from "node:path";

const SCENARIOS = path.resolve("reports", "scenarios.json");

// JS \b never matches at a Cyrillic boundary, so word edges are spelled out
// against an explicit letter class — same approach as watch-replies.js.
const W = "[a-zа-яё0-9_]";
const b = (src) => new RegExp(`(?<!${W})(?:${src})(?!${W})`, "i");

// [branch key, patterns]. First branch with any matching pattern wins.
const MATCHERS = [
  // Concrete signals first — these change what a human must do next.
  ["time_offered", [
    /(?<![\d:])([01]?\d|2[0-3])[:.][0-5]\d(?![\d])/,            // 19:30
    b("сегодня|завтра|послезавтра|вечером|утром|днём|днем"),
    b("в (?:пн|вт|ср|чт|пт|сб|вс)"),
    b("в (?:понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)"),
    b("на выходных|после (?:работы|пар|учёбы|учебы)"),
    b("давай в|можно в|удобно в"),
  ]],
  ["gave_handle", [
    /(?:discord|дискорд|дс)[^\p{L}\d]{0,12}[a-z0-9._#]{3,32}/iu,
    /\bmy (?:discord|tag)\b/i,
    /^[a-z0-9._]{3,32}#\d{4}$/i,
  ]],

  // Objections and questions.
  ["is_it_paid", [b("платно|сколько стоит|стоимость|цена|бесплатно ли|это реклама|продаёшь|продаешь|развод на деньги")]],
  ["sceptic", [b("развод|скам|секта|мошен|схема|пирамида|наеб|кидал|видел таких|подозрительно|не верю")]],
  ["hostile", [b("иди на|пошёл|пошел ты|отвали|бан|репорт|жалоб|отъеб|нахуй|блять")]],
  ["no_discord", [b("не пользуюсь дискорд|нет дискорда|не знаю дискорд|не умею дискорд|дискорд не"), b("а без дискорда|только телеграм|можно в телеграме")]],
  ["why_a_call", [b("зачем созвон|почему созвон|обязательно ли созвон|нужен ли созвон|можно без созвона|зачем звонить|а созвон обязателен")]],
  ["text_only", [b("напиши текстом|можешь текстом|расскажи текстом|только текстом|не хочу созвон|не буду созваниваться|созвон не хочу")]],
  ["why_me", [b("почему я|почему мне|как нашёл|как нашел|откуда у тебя|всем пишешь|рассылка|где взял мой")]],
  ["who_is_there", [b("сколько (?:вас|человек|людей|участников)|кто (?:уже )?(?:есть|там)|какой возраст|сколько лет ребятам|кто в сообществе")]],
  ["fit_doubt", [b("я не технич|я гуманитар|не участвовал|буду ли полезен|подойду ли|не уверен что подхожу|мне нечего дать|я новичок")]],
  ["geography", [b("ты же в австралии|ты в австралии|я не в москве|не из москвы|другой город|другая страна|как вы встречаетесь|где вы находитесь")]],
  ["no_time", [b("занят|нет времени|сессия|завал|дедлайн|экзамен|позже|потом напишу|не сейчас|сейчас никак|загружен")]],
  ["still_vague", [b("абстрактно|обобщённо|обобщенно|всё ещё не понимаю|все еще не понимаю|конкретнее|более конкретно|размыто|непонятно всё равно")]],
  ["what_is_it", [
    b("что (?:это|за сообщество|вы делаете|за клуб|за группа)"),
    b("в чём (?:суть|цель|смысл)|в чем (?:суть|цель|смысл)"),
    b("чем занимаетесь|чем вы занимаетесь|о чём речь|о чем речь|какая цель|что предлагаешь|расскажи подробнее|подробнее можно"),
  ]],
  ["returns_later", [b("я вернулся|всё ещё актуально|все еще актуально|актуально ли ещё|предложение в силе|помнишь меня")]],
  // agree_vague is intentionally last: it is the weakest signal and would
  // otherwise swallow messages that also carry a real question.
  ["agree_vague", [b("давай|хорошо|ладно|окей|ок|интересно|звучит интересно|почему нет|не против")]],
];

let cache = null;

export async function loadScenarios({ force = false } = {}) {
  if (cache && !force) return cache;
  const raw = JSON.parse(await readFile(SCENARIOS, "utf8"));
  cache = { branches: raw.branches ?? {}, rules: raw.rules ?? [] };
  return cache;
}

/**
 * Find the known scenario for an inbound message.
 *
 * @returns {{ key: string, reply: string|null, action: string|null, seen: number|null }|null}
 *   null when nothing matches — the caller must then escalate to a human rather
 *   than guess. A branch with a null reply (goes_quiet) is matched but has
 *   nothing to send, which is deliberate: you do not answer silence.
 */
export function matchScenario(text, scenarios) {
  const s = String(text ?? "");
  if (!s.trim()) return null;
  for (const [key, patterns] of MATCHERS) {
    if (!patterns.some((re) => re.test(s))) continue;
    const branch = scenarios?.branches?.[key];
    if (!branch) continue;
    return {
      key,
      reply: branch.reply ?? null,
      action: branch.action ?? null,
      seen: branch.seen ?? null,
    };
  }
  return null;
}

/** Branch keys that mean the conversation is over, whatever else they said. */
export const TERMINAL_BRANCHES = new Set(["decline", "hostile"]);

/** Branch keys where a human has to take over the same day. */
export const HANDOFF_BRANCHES = new Set(["time_offered", "gave_handle"]);

export { MATCHERS as SCENARIO_MATCHERS };
