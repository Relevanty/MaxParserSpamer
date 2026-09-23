// Cross-account "claim" ledger. When several accounts run in parallel they share
// ONE claims file keyed by resolved Telegram user id, so a given person is only
// ever messaged by a single account. Claiming is guarded by an atomic lock
// directory (fs.mkdir is atomic), making the read-check-write race-free across
// separate processes. Keyed by user id (not username) so the same person listed
// as @name in one list and id:hash in another is still recognized as one person.
//
// Each entry is { owner, status, at } where status is:
//   "pending" — claimed, not yet delivered. May be stolen by another account if
//               older than the TTL (self-heals users reserved by an account that
//               crashed before sending).
//   "sent"    — delivered. Permanent; never stolen.
import { mkdir, rmdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { CLAIM_TTL_MS } from "./config.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockDir, { timeoutMs = 15000, staleMs = 30000 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      await mkdir(lockDir); // atomic: throws EEXIST if another process holds it
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Steal an abandoned lock (e.g. a process was killed mid-claim).
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > staleMs) {
          await rmdir(lockDir).catch(() => {});
          continue;
        }
      } catch { /* lock vanished between mkdir and stat — retry */ }
      if (Date.now() - start > timeoutMs) {
        throw new Error("shared-claims lock timeout");
      }
      await sleep(40 + Math.random() * 120);
    }
  }
}

async function readClaims(claimsPath) {
  try {
    const raw = await readFile(claimsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && parsed.claims && typeof parsed.claims === "object" ? parsed.claims : {};
  } catch {
    return {};
  }
}

// Normalize a stored value into { owner, status, at }. Legacy string entries
// (bare owner) are treated as already-sent so they stay permanent.
function normalizeEntry(value) {
  if (!value) return null;
  if (typeof value === "string") return { owner: value, status: "sent", at: 0 };
  if (typeof value === "object" && value.owner) {
    return { owner: value.owner, status: value.status === "pending" ? "pending" : "sent", at: Number(value.at) || 0 };
  }
  return null;
}

async function writeClaims(claimsPath, claims) {
  const payload = { claims, updatedAt: new Date().toISOString(), version: 2 };
  await writeFile(claimsPath, `${JSON.stringify(payload)}\n`, "utf8");
}

async function withLock(claimsPath, fn) {
  const lockDir = `${claimsPath}.lock`;
  await mkdir(dirname(claimsPath), { recursive: true });
  await acquireLock(lockDir);
  try {
    return await fn();
  } finally {
    await rmdir(lockDir).catch(() => {});
  }
}

// Attempt to claim `key` for `owner`. Returns:
//   { claimed: true, owner }                 — new claim, re-claim by self, or a
//                                              stolen stale pending claim
//   { claimed: false, owner: <other> }       — a different account holds it
export async function claimUser(claimsPath, key, owner, ttlMs = CLAIM_TTL_MS) {
  const normalizedKey = String(key).trim().toLowerCase();
  if (!normalizedKey) return { claimed: true, owner };

  return withLock(claimsPath, async () => {
    const claims = await readClaims(claimsPath);
    const cur = normalizeEntry(claims[normalizedKey]);

    if (cur && cur.owner !== owner) {
      const stale = cur.status === "pending" && (Date.now() - cur.at) > ttlMs;
      if (!stale) return { claimed: false, owner: cur.owner };
      // Steal an expired pending claim from a dead/stalled account.
    }

    claims[normalizedKey] = { owner, status: "pending", at: Date.now() };
    await writeClaims(claimsPath, claims);
    return { claimed: true, owner };
  });
}

// Mark our claim as delivered (permanent). No-op if another account owns the key.
export async function confirmClaim(claimsPath, key, owner) {
  const normalizedKey = String(key).trim().toLowerCase();
  if (!normalizedKey) return false;

  return withLock(claimsPath, async () => {
    const claims = await readClaims(claimsPath);
    const cur = normalizeEntry(claims[normalizedKey]);
    if (cur && cur.owner !== owner) return false;
    claims[normalizedKey] = { owner, status: "sent", at: Date.now() };
    await writeClaims(claimsPath, claims);
    return true;
  });
}

// Release our *pending* claim so another account can take the user (used when a
// send fails without delivering). Never releases a delivered ("sent") claim, and
// never touches a claim owned by someone else.
export async function releaseClaim(claimsPath, key, owner) {
  const normalizedKey = String(key).trim().toLowerCase();
  if (!normalizedKey) return false;

  return withLock(claimsPath, async () => {
    const claims = await readClaims(claimsPath);
    const cur = normalizeEntry(claims[normalizedKey]);
    if (!cur || cur.owner !== owner || cur.status === "sent") return false;
    delete claims[normalizedKey];
    await writeClaims(claimsPath, claims);
    return true;
  });
}
