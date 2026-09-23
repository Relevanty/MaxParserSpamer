// Call-funnel analyser.
//
// The binary `agreedToCall` regex in analytics-collect.js has two problems the
// corpus makes obvious: it ignores refusals (20% of its hits are contradicted
// by "не хочу созвон" / "не на этой неделе" later in the same chat), and it
// stops at agreement — so the actual conversion event is invisible. In this
// campaign that event is a discord.gg invite, not a Telegram call: the corpus
// has 26 outbound invites and 52 past-tense call confirmations against only 22
// native Telegram calls.
//
// So this models the call as an ordered funnel and reports the furthest stage
// reached, with direction-aware and order-aware signals: a decline that comes
// *after* an agreement is a reneg, one that comes *before* is a conversion.
//
// Pure functions, no I/O and no deps — runs against the sentMessages/replies
// already stored in conversations.json, so it backfills without re-collecting.

// JS \b is ASCII-only, so /ок\b/ never matches Cyrillic text (this is the live
// bug in AGREED_TO_CALL_PATTERNS). Lookarounds over an explicit word class fix it.
const W = "[a-zа-яё0-9_]";
const b = (src) => new RegExp(`(?<!${W})(?:${src})(?!${W})`, "i");

export const CALL_STAGE = {
  NONE: 0,        // call never came up
  DISCUSSED: 1,   // raised, and they engaged with it (asked how/when/why)
  AGREED: 2,      // affirmative, net of contradictions
  SCHEDULED: 3,   // a specific day or time got pinned
  INVITED: 4,     // invite link / platform handle exchanged
  COMPLETED: 5,   // the call actually happened
};

export const CALL_STAGE_NAME = {
  0: "no_call_signal",
  1: "call_discussed",
  2: "call_agreed",
  3: "call_scheduled",
  4: "invite_sent",
  5: "call_completed",
};

// ── Signal vocabulary ────────────────────────────────────────────────────────
// Every pattern below was checked against the real corpus; counts in comments
// are inbound-message hits at the time of writing.

const CALL_TOPIC = /созвон|созвонит|звонок|позвон|созвониться|встретит|встреч|голосов|voice|call\b/i;

// Unambiguous agreement. Deliberately narrow — broad forms like /хорошо/ and
// bare /давай/ are handled as WEAK_AGREE so they can't carry a stage on their own.
const STRONG_AGREE = [
  b("договорились"),
  b("давай(?:те)? созвонимся"),
  b("готов(?:а|ы)? (?:созвониться|созвонится|поговорить|пообщаться)"),
  b("я за"),
  b("я в деле"),
  b("можно созвониться"),
  b("буду рад(?:а)? (?:созвониться|пообщаться|поговорить)"),
  b("окей"),
  b("ок"),          // works now — b() uses Cyrillic-aware boundaries
  /\bok\b/i,
  b("идёт|идет"),
  b("согласен|согласна"),
];

const WEAK_AGREE = [
  b("давай(?:те)?"),
  b("хорошо"),
  b("интересно"),
  b("звучит (?:интересно|классно|круто|заманчиво)"),
  b("почему бы (?:и )?нет"),
  b("откликается"),
];

// Engagement without commitment — they're asking about the call, not accepting.
const DISCUSS = [
  b("когда"),
  b("во сколько"),
  b("как (?:происходит|проходит|будет)"),
  b("а почему (?:именно )?(?:созвон|звонок)"),
  b("обязательно (?:ли )?(?:созвон|звонок)"),
  b("какие слоты"),
  b("есть слоты"),
  b("сколько (?:по )?времени"),
  b("что за"),
  b("в чем (?:цель|смысл)"),
];

// Hard no to the call specifically.
const DECLINE = [
  b("не хочу (?:созвон|созваниваться|звонок|звонить)"),
  b("не буду созваниваться"),
  b("без созвона"),
  b("давай(?:те)? (?:в|по) переписке"),
  b("(?:лучше|можно) (?:в|по) переписке"),
  b("не интересно"),
  b("не интересует"),
  b("не актуально"),
  b("спасибо, нет"),
  b("нет, спасибо"),
  b("откажусь"),
];

// Soft no / postponement — blocks AGREED but is not a decline.
const DEFER = [
  b("не на этой неделе"),
  b("как-нибудь потом"),
  b("попозже"),
  b("не сейчас"),
  b("сейчас нет (?:времени|возможности)"),
  b("нет (?:времени|возможности)"),
  b("не (?:смогу|могу|получится)"),
  b("занят(?:а)?"),
  b("давай позже"),
  b("напиши позже"),
  b("перенес(?:ти|ем|у)"),
];

// The call happened. Past tense is the tell.
const COMPLETED = [
  b("созвонились"),
  b("созвонилась"),
  b("созвонился"),
  b("поболтали"),
  b("пообщались"),
  b("поговорили"),
  b("спасибо за (?:созвон|звонок|встречу|разговор)"),
  b("после (?:созвона|звонка)"),
  b("отзыв о созвоне"),
  b("(?:всё|все) (?:прошло|супер|отлично)"),
  b("на сервер добавил"),
];

// Platform / invite artefacts. discord.gg is the actual CTA in this campaign.
const PLATFORMS = [
  { name: "discord", link: /discord\.gg\/[\w-]+/gi, mention: /discord|дискорд/i },
  { name: "telemost", link: /telemost\.(?:yandex|360)\.[\w./-]+/gi, mention: /telemost|телемост/i },
  { name: "google_meet", link: /meet\.google\.com\/[\w-]+/gi, mention: /meet\.google|гугл ?мит/i },
  { name: "zoom", link: /(?:us\d+web\.)?zoom\.us\/j\/[\w?=-]+/gi, mention: /zoom|зум/i },
  { name: "telegram_call", link: null, mention: /телеграм ?звон|в тг созвон/i },
];

// `link` needs /g so String.match can collect every URL, but RegExp.test on a
// /g regex advances lastIndex and the next call resumes mid-string — across a
// loop of conversations that makes a link match depend on what the previous
// conversation contained. Test against a stateless clone instead.
for (const p of PLATFORMS) {
  p.linkTest = p.link ? new RegExp(p.link.source, p.link.flags.replace("g", "")) : null;
}

// ── Handoff ──────────────────────────────────────────────────────────────────
// The call is often not taken by the sender: the prospect gets passed to a
// teammate ("После него можно познакомиться с Олей: @olya_kt", or just a bare
// @handle). That is a *route* to the call, not a referral — the shipped
// `hasUsernameMention` metric reads outgoing mentions and labels them
// "referred / soft success", which inverts the direction. A referral is a
// handle *they* give us; a handoff is a handle *we* give them.
//
// The roster is derived from frequency rather than hardcoded, so it survives
// team changes: in this corpus 9 handles appear in >=5 conversations each
// (57, 46, 30, 25, 12, 9, 8, 8, 7) and the rest are one-offs.
const TEAM_MIN_CONVERSATIONS = 5;
const HANDLE_RE = /@[a-zA-Z0-9_]{4,}/g;

const HANDOFF_CONTEXT = [
  b("познакомь?ся"),
  b("познакомить"),
  b("напиши"),
  b("свяжись"),
  b("отпиши"),
  b("тебя ждет|тебя ждёт"),
  b("будет вести"),
  b("проведет|проведёт"),
];

// Their acknowledgement that the handoff landed.
const HANDOFF_ACCEPTED = [
  b("напишу (?:ему|ей|им)?"),
  b("написал(?:а)? (?:ему|ей|им)"),
  b("связал(?:ся|ась)"),
  b("познакомил(?:ся|ась)"),
  b("добавил(?:ся|ась)? в чат"),
  b("мы поговорили"),
  b("уже (?:написал|общаемся)"),
];

/**
 * Derive the teammate roster from outbound @mentions.
 * A handle we send into many separate conversations is a colleague; one we
 * send once is far more likely a genuine one-off introduction.
 *
 * @param {Iterable<object>} convs conversations.json entries
 * @param {{minConversations?: number}} [opts]
 * @returns {Set<string>} lowercase handles, including the leading "@"
 */
export function deriveTeam(convs, { minConversations = TEAM_MIN_CONVERSATIONS } = {}) {
  const counts = new Map();
  for (const c of convs) {
    if (!c || c.error) continue;
    const seen = new Set();
    for (const m of c.sentMessages ?? []) {
      for (const h of m.match(HANDLE_RE) ?? []) seen.add(h.toLowerCase());
    }
    for (const h of seen) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= minConversations).map(([h]) => h));
}

// Concrete scheduling. Requires a real time or a named day, not just "завтра".
// A colon always means a time. A dot is ambiguous — "16.00" is 16:00 but
// "10.05" is far more likely the 10th of May, so it is resolved by validity:
// a dotted pair is a date only when it forms a real day/month.
const TIME_COLON_RE = /(?<![\d:])(\d{1,2}):(\d{2})(?![\d])/;
const DOTTED_RE = /(?<![\d.])(\d{1,2})[./](\d{1,2})(?![\d.])/;
const DOTTED_ALL_RE = /(?<![\d.])(\d{1,2})[./](\d{1,2})(?![\d.])/g;
const DAY_RE = b("понедельник|вторник|сред[уаы]|четверг|пятниц[уаы]|суббот[уаы]|воскресень[еяю]|вс|сб|пн|вт|ср|чт|пт|сегодня|завтра|послезавтра|выходн");

const isDate = (a, b_) => a >= 1 && a <= 31 && b_ >= 1 && b_ <= 12;
const isTime = (h, m) => h <= 23 && m <= 59;

// Returns { time, date } for one message, resolving the dotted ambiguity.
// Scans every dotted pair, not just the first: "в вс 10.05 в 16.00" carries a
// date and a time, and taking only the leading match would drop the time.
function splitDateTime(text) {
  let time = text.match(TIME_COLON_RE)?.[0] ?? null;
  let date = null;
  for (const [raw, aStr, bStr] of text.matchAll(DOTTED_ALL_RE)) {
    const a = Number(aStr), b_ = Number(bStr);
    if (!date && isDate(a, b_)) date = raw;
    else if (!time && isTime(a, b_)) time = raw;
  }
  return { time, date };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const anyMatch = (patterns, text) => patterns.some((re) => re.test(text));

// Escaped, word-boundary-anchored matcher for a caller-supplied name, memoised
// so a roster is compiled once rather than once per conversation.
const nameRegexCache = new Map();
function nameRegex(name) {
  let re = nameRegexCache.get(name);
  if (!re) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(?<!${W})${escaped}`, "i");
    nameRegexCache.set(name, re);
  }
  return re;
}

// Index of the last message in `msgs` matching any pattern, or -1.
// Order matters: a decline after an agreement is a reneg, before it is a
// conversion, and only the later one should count.
function lastHit(msgs, patterns) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (anyMatch(patterns, msgs[i])) return i;
  }
  return -1;
}

function collectLinks(text) {
  const found = [];
  for (const p of PLATFORMS) {
    if (!p.link) continue;
    for (const m of text.match(p.link) ?? []) found.push({ platform: p.name, url: m });
  }
  return found;
}

function detectPlatform(outText, inText) {
  const both = `${outText}\n${inText}`;
  for (const p of PLATFORMS) {
    if (p.linkTest && p.linkTest.test(both)) return p.name;
  }
  for (const p of PLATFORMS) {
    if (p.mention.test(both)) return p.name;
  }
  return null;
}

function extractProposedTimes(msgs) {
  const out = [];
  for (const m of msgs) {
    const { time, date } = splitDateTime(m);
    const day = m.match(DAY_RE)?.[0] ?? null;
    if (time || date || (day && CALL_TOPIC.test(m))) {
      out.push({ raw: m.replace(/\s+/g, " ").trim().slice(0, 120), time, date, day });
    }
  }
  return out;
}

/**
 * Analyse one conversation's call funnel.
 *
 * @param {{sentMessages?: string[], replies?: string[], hasConnectedCall?: boolean}} conv
 *        A conversations.json entry (or a live analysis object — same shape).
 * @param {{team?: Set<string>|string[], teamNames?: string[]}} [opts]
 *        `team` is the teammate handle roster — pass the result of
 *        deriveTeam() once rather than recomputing it per conversation.
 *        `teamNames` catches first-name handoffs ("познакомься с Лизой")
 *        that carry no @handle; deployment-specific, so it defaults to none.
 * @returns {{
 *   stage: number, stageName: string, confidence: number,
 *   agreed: boolean, declined: boolean, deferred: boolean, reneged: boolean,
 *   route: "direct"|"handoff"|null, completedBy: "self"|"team"|null,
 *   handoff: {sent: boolean, accepted: boolean, teammates: string[]},
 *   referrals: string[], platform: string|null,
 *   inviteLinks: {platform:string,url:string}[],
 *   proposedTimes: object[], signals: string[],
 * }}
 */
export function analyseCall(conv = {}, opts = {}) {
  const team = opts.team instanceof Set ? opts.team : new Set(opts.team ?? []);
  // Names are caller-supplied text, so metacharacters have to be escaped —
  // "Оля (менеджер)" would otherwise throw and abort the whole classify pass.
  // Compiled regexes are cached per name so this is not redone per conversation.
  const teamNameRes = (opts.teamNames ?? []).map(nameRegex);
  const outbound = (conv.sentMessages ?? []).filter(Boolean);
  const inbound = (conv.replies ?? []).filter(Boolean);
  const outText = outbound.join("\n");
  const inText = inbound.join("\n");
  const signals = [];

  // Did the topic ever come up, from either side?
  const raisedByUs = CALL_TOPIC.test(outText);
  const raisedByThem = CALL_TOPIC.test(inText);
  if (raisedByUs) signals.push("we_raised_call");
  if (raisedByThem) signals.push("they_raised_call");

  // Order-aware agreement vs. refusal, on their side only.
  const iStrong = lastHit(inbound, STRONG_AGREE);
  const iWeak = lastHit(inbound, WEAK_AGREE);
  const iDecline = lastHit(inbound, DECLINE);
  const iDefer = lastHit(inbound, DEFER);
  const iAgree = Math.max(iStrong, iWeak);

  // `>=` so a qualifier in the *same* message wins: "можно созвониться, только
  // не на этой неделе" is a deferral, not an agreement. Across messages the
  // later signal still wins, so "не хочу" → "ладно, договорились" stays agreed.
  const declined = iDecline >= 0 && iDecline >= iAgree;
  const deferred = !declined && iDefer >= 0 && iDefer >= iAgree;
  // A reneg needs the refusal in a *later* message than the agreement;
  // a same-message qualifier is a hedge, not a reversal.
  const reneged = iAgree >= 0 && (declined || deferred) && Math.max(iDecline, iDefer) > iAgree;
  // Weak agreement alone doesn't count unless the call topic is actually live.
  const agreed =
    !declined && !deferred &&
    (iStrong >= 0 || (iWeak >= 0 && (raisedByUs || raisedByThem)));

  if (declined) signals.push("declined_call");
  if (deferred) signals.push("deferred_call");
  if (reneged) signals.push("reneged_after_agreeing");
  if (iStrong >= 0) signals.push("strong_agreement");
  else if (iWeak >= 0) signals.push("weak_agreement");

  const discussed = raisedByThem || anyMatch(DISCUSS, inText);
  if (discussed) signals.push("engaged_with_call");

  // Scheduling: a concrete time/day, raised while the call topic is live.
  const schedulingMsgs = [...outbound, ...inbound].filter(
    (m) => CALL_TOPIC.test(m) || TIME_COLON_RE.test(m) || DOTTED_RE.test(m));
  const proposedTimes = extractProposedTimes(schedulingMsgs);
  const scheduled = agreed && proposedTimes.some((p) => p.time || p.date || p.day);
  if (scheduled) signals.push("time_proposed");

  // Invite: a link we sent, or them handing over a handle to connect on.
  const inviteLinks = collectLinks(outText);
  const handleShared = /(?:мой )?(?:ник|тег|логин|юзер)/i.test(inText) && detectPlatform(outText, inText) !== null;
  if (inviteLinks.length) signals.push("invite_link_sent");
  if (handleShared) signals.push("handle_exchanged");

  // Handoff: teammate handles we passed to them, and any name we were told to
  // expect. Passing a colleague is the same funnel act as passing a link — it
  // is the artefact that connects them to the call — so it lands at INVITED.
  const outHandles = [...new Set((outText.match(HANDLE_RE) ?? []).map((h) => h.toLowerCase()))];
  const teammates = outHandles.filter((h) => team.has(h));
  const namedTeammate = teamNameRes.some((re) => re.test(`${outText}\n${inText}`));
  const handoffSent = teammates.length > 0 || (namedTeammate && anyMatch(HANDOFF_CONTEXT, outText));
  const handoffAccepted = handoffSent && anyMatch(HANDOFF_ACCEPTED, inText);
  if (handoffSent) signals.push("handed_off_to_team");
  if (handoffAccepted) signals.push("handoff_acknowledged");

  // A referral is the mirror image: a handle *they* gave us that is not ours.
  const referrals = [...new Set((inText.match(HANDLE_RE) ?? []).map((h) => h.toLowerCase()))]
    .filter((h) => !team.has(h));
  if (referrals.length) signals.push("referral_received");

  const invited = inviteLinks.length > 0 || handleShared || handoffSent;

  // Completed: their past-tense confirmation, or a real Telegram call.
  // After a handoff the call happens in someone else's chat, so their
  // acknowledgement is the only evidence we will ever see on this side.
  const completedByText = anyMatch(COMPLETED, inText);
  const completed = completedByText || conv.hasConnectedCall === true || handoffAccepted;
  if (completedByText) signals.push("past_tense_confirmation");
  if (conv.hasConnectedCall) signals.push("telegram_call_connected");

  const route = handoffSent ? "handoff"
    : (invited || scheduled || agreed || completed) ? "direct"
    : null;
  const completedBy = !completed ? null
    : conv.hasConnectedCall ? "self"
    : handoffSent ? "team" : "self";

  // Highest stage reached wins.
  let stage = CALL_STAGE.NONE;
  if (discussed || raisedByUs) stage = CALL_STAGE.DISCUSSED;
  if (agreed) stage = CALL_STAGE.AGREED;
  if (scheduled) stage = CALL_STAGE.SCHEDULED;
  if (invited) stage = CALL_STAGE.INVITED;
  if (completed) stage = CALL_STAGE.COMPLETED;

  // Confidence reflects how much independent evidence backs the stage.
  let confidence = 0.5;
  if (stage === CALL_STAGE.COMPLETED) confidence = conv.hasConnectedCall && completedByText ? 0.99 : 0.85;
  else if (stage === CALL_STAGE.INVITED) confidence = inviteLinks.length ? 0.9 : 0.6;
  else if (stage === CALL_STAGE.SCHEDULED) confidence = 0.8;
  else if (stage === CALL_STAGE.AGREED) confidence = iStrong >= 0 ? 0.75 : 0.5;
  else if (stage === CALL_STAGE.DISCUSSED) confidence = discussed ? 0.6 : 0.3;
  else confidence = 0.9; // confident there is no signal
  if (reneged) confidence = Math.min(confidence, 0.7);

  return {
    stage,
    stageName: CALL_STAGE_NAME[stage],
    confidence: Number(confidence.toFixed(2)),
    agreed,
    declined,
    deferred,
    reneged,
    route,
    completedBy,
    handoff: { sent: handoffSent, accepted: handoffAccepted, teammates },
    referrals,
    platform: detectPlatform(outText, inText),
    inviteLinks,
    proposedTimes: proposedTimes.slice(0, 5),
    signals,
  };
}

/**
 * Roll a set of conversations up into call-funnel counts.
 * Derives the teammate roster from the same set unless one is supplied.
 *
 * @param {Iterable<object>} convs conversations.json entries
 * @param {{team?: Set<string>|string[], teamNames?: string[]}} [opts]
 */
export function summariseCalls(convs, opts = {}) {
  const list = [...convs].filter((c) => c && !c.error);
  const team = opts.team ? (opts.team instanceof Set ? opts.team : new Set(opts.team)) : deriveTeam(list);
  const perConv = { team, teamNames: opts.teamNames };
  // Reuse an already-analysed result when the caller has one. Recomputing
  // unconditionally let this table disagree with a KPI row built from the same
  // conversations against a roster derived from a different set.
  const analysed = (c) => opts.reuseStored !== false && c.call ? c.call : analyseCall(c, perConv);

  const stages = Object.fromEntries(Object.values(CALL_STAGE_NAME).map((n) => [n, 0]));
  const platforms = {};
  const byTeammate = {};
  let reneged = 0, declined = 0, deferred = 0, n = 0;
  let handoffSent = 0, handoffAccepted = 0, referralsReceived = 0;
  const completedBy = { self: 0, team: 0 };
  const route = { direct: 0, handoff: 0 };

  for (const c of list) {
    n++;
    const r = analysed(c);
    stages[r.stageName]++;
    if (r.reneged) reneged++;
    if (r.declined) declined++;
    if (r.deferred) deferred++;
    if (r.platform) platforms[r.platform] = (platforms[r.platform] ?? 0) + 1;
    if (r.handoff.sent) handoffSent++;
    if (r.handoff.accepted) handoffAccepted++;
    if (r.referrals.length) referralsReceived++;
    if (r.route) route[r.route]++;
    if (r.completedBy) completedBy[r.completedBy]++;
    for (const h of r.handoff.teammates) byTeammate[h] = (byTeammate[h] ?? 0) + 1;
  }

  // Cumulative "reached at least this stage" — the funnel view.
  const order = Object.values(CALL_STAGE_NAME);
  const reached = {};
  for (let i = 1; i < order.length; i++) {
    reached[order[i]] = order.slice(i).reduce((sum, k) => sum + stages[k], 0);
  }

  return {
    total: n, stages, reached, platforms, reneged, declined, deferred,
    team: [...team],
    handoff: { sent: handoffSent, accepted: handoffAccepted, byTeammate },
    referralsReceived, route, completedBy,
  };
}
