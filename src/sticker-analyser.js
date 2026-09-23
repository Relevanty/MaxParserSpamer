// Sticker / emoji usage analysis.
//
// Three things blocked this before: the sticker feature is dead code
// (loadStickerDocument is defined in index.js but never called, and
// STICKER_CONFIG is imported but never read), the collector dropped stickers
// because they carry no `.message` text, and the one emoji-only template in
// report.csv ("🐱", 142 sends) postdates the last collection so has no
// outcome data at all.
//
// The collector now records a `stickers` field, so the sticker half of this
// becomes answerable once sending is wired up and a collection has run. The
// emoji half works on today's data — with the caveat documented in
// summariseEmoji() that the current corpus cannot separate emoji from template.

// A single visible emoji is often several codepoints: "👍🏻" carries a skin-tone
// modifier, "❤️" a variation selector, "👨‍👩‍👧" two zero-width joiners. Matching
// bare \p{Extended_Pictographic} splits those into pieces — which both
// miscounts them and leaves residue behind when stripping, so an emoji-only
// string stops looking emoji-only. Match whole clusters instead.
const EMOJI_RE = /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)?(?:‍\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)?)*/gu;
// Codepoints that are part of an emoji cluster but never start one.
const EMOJI_RESIDUE_RE = /[‍️︎\p{Emoji_Modifier}\p{Emoji_Component}]/gu;

const countEmoji = (text) => (String(text ?? "").match(EMOJI_RE) ?? []).length;
const rate = (n, d) => (d > 0 ? n / d : null);

// Treated as a reply for rate purposes. Kept in one place so the sticker and
// emoji summaries can't drift apart on what "worked" means.
const replied = (c) => (c.repliesCount ?? 0) > 0;

/**
 * Sticker usage vs. outcome. Reads the `stickers` field written by
 * ConversationAnalyzer#extractStickers.
 *
 * Returns `available: false` when no conversation carries the field — that
 * means the data predates the collector change, not that stickers underperform.
 * Reporting 0% in that case would be a false negative, so callers should
 * branch on `available` rather than plotting the zeros.
 *
 * @param {Iterable<object>} convs conversations.json entries
 */
export function summariseStickers(convs) {
  const list = [...convs].filter((c) => c && !c.error);
  const withField = list.filter((c) => c.stickers);

  if (!withField.length) {
    return {
      available: false,
      reason: list.length
        ? "no conversation carries a `stickers` field — re-collect with COLLECTOR_VERSION >= 5"
        : "no conversations to analyse",
      analysed: 0,
      totalSeen: list.length,
    };
  }

  const sentAny = withField.filter((c) => c.stickers.sent?.length > 0);
  const openedWith = withField.filter((c) => (c.stickers.sentInOpening ?? 0) > 0);
  const none = withField.filter((c) => !(c.stickers.sent?.length > 0));
  const receivedAny = withField.filter((c) => c.stickers.received?.length > 0);

  // Which sticker emoji we actually send, and how each performs.
  const byEmoji = {};
  for (const c of withField) {
    for (const e of new Set((c.stickers.sent ?? []).map((s) => s.emoji).filter(Boolean))) {
      (byEmoji[e] ??= []).push(c);
    }
  }
  const perEmoji = Object.entries(byEmoji)
    .map(([emoji, cs]) => ({
      emoji,
      sent: cs.length,
      replied: cs.filter(replied).length,
      replyRate: rate(cs.filter(replied).length, cs.length),
    }))
    .sort((a, b) => b.sent - a.sent);

  const bucket = (cs) => ({
    n: cs.length,
    replied: cs.filter(replied).length,
    replyRate: rate(cs.filter(replied).length, cs.length),
  });

  return {
    available: true,
    analysed: withField.length,
    totalSeen: list.length,
    withStickers: bucket(sentAny),
    withoutStickers: bucket(none),
    openedWithSticker: bucket(openedWith),
    theySentStickers: bucket(receivedAny),
    perEmoji,
  };
}

/**
 * Emoji-in-opening-message usage vs. outcome. Works on existing data.
 *
 * `confounded` is set when every emoji-bearing opening uses the same template,
 * which is exactly the situation in the current corpus: all 136 emoji openings
 * are the same 🤪 opener, so an emoji effect cannot be separated from a
 * template effect. Read the buckets as descriptive, not causal, when set.
 *
 * @param {Iterable<object>} convs conversations.json entries
 */
export function summariseEmoji(convs) {
  const list = [...convs].filter((c) => c && !c.error && c.firstSentMessage);
  if (!list.length) return { available: false, reason: "no opening messages", analysed: 0 };

  const buckets = { none: [], one: [], many: [] };
  for (const c of list) {
    const n = countEmoji(c.firstSentMessage);
    (n === 0 ? buckets.none : n === 1 ? buckets.one : buckets.many).push(c);
  }

  const byEmoji = {};
  const templatesPerEmoji = {};
  for (const c of list) {
    for (const e of new Set(c.firstSentMessage.match(EMOJI_RE) ?? [])) {
      (byEmoji[e] ??= []).push(c);
      (templatesPerEmoji[e] ??= new Set()).add(c.firstSentMessage.slice(0, 60));
    }
  }

  // Confounding is a matter of dominance, not exact uniqueness: near-identical
  // wordings split into separate keys but still leave the emoji arm resting on
  // one message. Flag when a single template carries most of it.
  const withEmoji = list.filter((c) => countEmoji(c.firstSentMessage) > 0);
  const templateCounts = new Map();
  for (const c of withEmoji) {
    const k = c.firstSentMessage.slice(0, 60);
    templateCounts.set(k, (templateCounts.get(k) ?? 0) + 1);
  }
  const topShare = withEmoji.length
    ? Math.max(...templateCounts.values()) / withEmoji.length
    : 0;
  const confounded = withEmoji.length > 0 && topShare >= 0.8;

  const bucket = (cs) => ({
    n: cs.length,
    replied: cs.filter(replied).length,
    replyRate: rate(cs.filter(replied).length, cs.length),
  });

  return {
    available: true,
    analysed: list.length,
    confounded,
    confoundNote: confounded
      ? `${(topShare * 100).toFixed(0)}% of emoji-bearing openings use a single template — emoji effect is not separable from template effect`
      : null,
    noEmoji: bucket(buckets.none),
    oneEmoji: bucket(buckets.one),
    manyEmoji: bucket(buckets.many),
    perEmoji: Object.entries(byEmoji)
      .map(([emoji, cs]) => ({
        emoji,
        sent: cs.length,
        replyRate: rate(cs.filter(replied).length, cs.length),
        templates: templatesPerEmoji[emoji].size,
      }))
      .sort((a, b) => b.sent - a.sent),
  };
}

/**
 * Classify a report.csv Template value by what led the sequence.
 *
 * The "maxim"/saved-n send modes forward Saved Messages wholesale
 * (index.js:382, client.forwardMessages from "me"), so a sticker sitting in
 * Saved Messages goes out as a forward. savedMessageTemplate (index.js:192)
 * falls back to `msg:<id>` when that first forwarded message has no text —
 * which is exactly the media case. So the Template column already records,
 * at send time, whether a send was media-led or text-led.
 *
 * This is the only trustworthy sticker signal available: it is written when
 * the send happens and does not depend on what the conversation looked like
 * afterwards.
 */
export function classifyTemplate(template) {
  const t = String(template ?? "").trim();
  if (!t) return "unknown";
  if (/^msg:\d+$/.test(t)) return "media";          // forwarded, no text => sticker/photo/video
  const stripped = t.replace(EMOJI_RE, "").replace(EMOJI_RESIDUE_RE, "").trim();
  if (countEmoji(t) > 0 && stripped === "") return "emoji-text";
  return "text";
}

/**
 * Success rate per template kind — the sticker-vs-text comparison.
 *
 * @param {Map<string,string>|Iterable<[string,string]>} sendsByUser
 *        lowercase username -> Template value from report.csv
 * @param {Record<string,object>} conversations conversations.json, keyed by username
 */
export function summariseTemplateArms(sendsByUser, conversations = {}) {
  const arms = {};
  for (const [user, template] of sendsByUser) {
    const kind = classifyTemplate(template);
    const a = (arms[kind] ??= { kind, sent: 0, withData: 0, replied: 0, agreed: 0 });
    a.sent++;
    const c = conversations[user];
    if (!c || c.error) continue;
    a.withData++;
    if ((c.repliesCount ?? 0) > 0) a.replied++;
    if (c.agreedToCall) a.agreed++;
  }
  for (const a of Object.values(arms)) {
    a.replyRate = rate(a.replied, a.withData);
    a.agreedRate = rate(a.agreed, a.withData);
    // Coverage is the thing that decides whether the rates mean anything.
    a.coverage = rate(a.withData, a.sent);
  }
  return arms;
}

/**
 * Minimum per-arm sample needed to detect `lift` at the given baseline.
 * Two-proportion test, 80% power, alpha 0.05 (z = 1.96 + 0.84).
 * Use it to decide whether a sticker A/B is worth starting before you start it.
 */
export function requiredSampleSize(baselineRate, absoluteLift) {
  const p1 = baselineRate, p2 = baselineRate + absoluteLift;
  if (p2 <= 0 || p2 >= 1 || absoluteLift === 0) return Infinity;
  const pBar = (p1 + p2) / 2;
  const n = ((1.96 + 0.84) ** 2 * 2 * pBar * (1 - pBar)) / absoluteLift ** 2;
  return Math.ceil(n);
}
