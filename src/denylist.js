// The denylist, and a guard on its integrity.
//
// lists/0-do-not-contact.txt is the single thing standing between a run and
// re-pitching someone who already said no. Re-pitching a decline is what got the
// account moderation-limited on 4 Aug, so the list shrinking is not a small
// event — but until now it was a plain text file that anything could truncate
// with no one noticing: a bad edit, a half-written save, or a OneDrive sync
// conflict that resolves in favour of an older copy.
//
// So: remember how many entries the list had last run. If it lost entries,
// refuse to send until a human confirms. A dry run always proceeds — the point
// is to stop messages going out, not to stop you looking.
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const DENYLIST = path.resolve("lists", "0-do-not-contact.txt");
const STATE = path.resolve("storage", "denylist-state.json");

export function parseDenylist(raw) {
  return new Set(
    String(raw).split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#"))
      // trim() already strips a BOM (U+FEFF counts as whitespace in JS), so a
      // file re-saved by Notepad cannot smuggle an unmatchable first entry.
      .map(l => l.replace(/^@/, "").toLowerCase()),
  );
}

// A cloud drive resolves a conflict by keeping both files. The copy it invents
// is never read by anything, so entries that live only in it are entries we
// would message.
async function findConflictCopies() {
  try {
    const entries = await readdir(path.dirname(DENYLIST));
    return entries.filter(n =>
      /do-not-contact/i.test(n)
      && n !== path.basename(DENYLIST)
      && /\.txt$/i.test(n));
  } catch { return []; }
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.send]   true when the caller intends to deliver
 * @param {boolean} [opts.allowShrink] operator override for a deliberate removal
 * @returns {Promise<{ deny: Set<string>, warnings: string[], blocked: boolean }>}
 */
export async function loadDenylist({ send = false, allowShrink = false } = {}) {
  const warnings = [];
  let raw = "";
  let missing = false;
  try {
    raw = await readFile(DENYLIST, "utf8");
  } catch {
    missing = true;
  }

  const deny = missing ? new Set() : parseDenylist(raw);
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);

  // A missing list is not "nobody declined" — it is a list we failed to read.
  if (missing) {
    warnings.push(`denylist not found at ${path.relative(process.cwd(), DENYLIST)} — treating as empty is unsafe`);
    return { deny, warnings, blocked: send && !allowShrink };
  }

  let prev = null;
  try { prev = JSON.parse(await readFile(STATE, "utf8")); } catch { /* first run */ }

  let blocked = false;
  if (prev && Number.isInteger(prev.count) && deny.size < prev.count) {
    const lost = prev.count - deny.size;
    warnings.push(`denylist SHRANK by ${lost} (${prev.count} → ${deny.size}) since ${prev.at}`);
    warnings.push("someone who declined may now be messageable — this is how the account got limited before");
    if (send && !allowShrink) {
      warnings.push("refusing to send. Check the file, then re-run with --allow-denylist-shrink if the removal was deliberate");
      blocked = true;
    }
  }

  const conflicts = await findConflictCopies();
  for (const c of conflicts) {
    warnings.push(`possible sync-conflict copy in lists/: ${c} — entries in it are NOT honoured`);
  }

  // Only record a new high-water mark once we are past the guard, so a blocked
  // run does not quietly bless the smaller list for next time.
  if (!blocked) {
    try {
      await mkdir(path.dirname(STATE), { recursive: true });
      await writeFile(STATE, JSON.stringify({
        count: Math.max(deny.size, prev?.count ?? 0),
        seen: deny.size,
        hash,
        at: new Date().toISOString(),
      }, null, 2), "utf8");
    } catch { /* a state write failure must not stop a run */ }
  }

  return { deny, warnings, blocked };
}

// Print warnings the same way everywhere, and say plainly when a run is stopping.
export function reportDenylist({ deny, warnings, blocked }, { log = console.log } = {}) {
  if (warnings.length) {
    log("");
    for (const w of warnings) log(`  ⚠ ${w}`);
    log("");
  }
  log(`Denylist: ${deny.size} people who must not be contacted.`);
  return !blocked;
}
