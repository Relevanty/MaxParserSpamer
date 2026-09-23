// Single-writer lock for a sender run.
//
// Two senders started against the same state directory will both read the same
// progress-state.json and both keep their own in-memory "seen this run" set,
// so neither can see the other's sends. On 2026-08-03 that put two different
// Saved Messages groups into the same chat 42 seconds apart — below the 45s
// INTER_USER_DELAY floor a single process can achieve, which is what gives it
// away. Shared claims guard the cross-account case, but only once an entity has
// been resolved and only when configured; this refuses the situation outright.
//
// The lock is advisory and self-healing: a crashed run leaves a file behind,
// so a lock whose owner is gone (or which has simply aged out) is taken over
// rather than blocking the tool for ever.
import { mkdir, readFile } from "node:fs/promises";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// A run can legitimately sit idle for a while — BATCH_SLEEP_MS is 30 minutes
// and a PEER_FLOOD wait is 40 — so the lock has to outlive those before it is
// considered abandoned.
const DEFAULT_STALE_MS = 90 * 60 * 1000;

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return err.code === "EPERM";
  }
}

async function readLock(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Take the run lock, or explain who holds it.
 *
 * @param {string} lockPath
 * @param {{label?: string, staleMs?: number}} [opts]
 * @returns {Promise<{ok: true, release: () => Promise<void>} | {ok: false, holder: object, reason: string}>}
 */
export async function acquireRunLock(lockPath, { label = "sender", staleMs = DEFAULT_STALE_MS } = {}) {
  const existing = await readLock(lockPath);
  if (existing) {
    const age = Date.now() - (Number(existing.startedAt) || 0);
    const sameHost = existing.host === os.hostname();
    // Only trust a pid check on the machine that wrote it.
    const alive = sameHost ? isProcessAlive(Number(existing.pid)) : age < staleMs;
    if (alive && age < staleMs) {
      return {
        ok: false,
        holder: existing,
        reason: `${existing.label ?? "a run"} started ${Math.round(age / 1000)}s ago`
          + ` (pid ${existing.pid}${sameHost ? "" : ` on ${existing.host}`}) still holds the lock`,
      };
    }
  }

  await mkdir(path.dirname(lockPath), { recursive: true });
  const payload = {
    pid: process.pid,
    host: os.hostname(),
    label,
    startedAt: Date.now(),
    // Recorded for diagnosis when a stale lock is taken over.
    takeoverOf: existing ? { pid: existing.pid, startedAt: existing.startedAt } : null,
  };
  const body = JSON.stringify(payload, null, 2) + "\n";

  // Create exclusively. The old code read the lock and then wrote it as two
  // separate steps, so two senders starting at the same moment both saw "no
  // lock" and both proceeded — which is the failure this module exists to
  // prevent. "wx" makes the create atomic: exactly one process can win.
  try {
    writeFileSync(lockPath, body, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    // Someone created it between our read and our write. Re-inspect: only take
    // it over if it is genuinely abandoned.
    const now = await readLock(lockPath);
    const age = Date.now() - (Number(now?.startedAt) || 0);
    const sameHost = now?.host === os.hostname();
    const alive = sameHost ? isProcessAlive(Number(now?.pid)) : age < staleMs;
    if (now && alive && age < staleMs) {
      return {
        ok: false,
        holder: now,
        reason: `${now.label ?? "a run"} won the race ${Math.round(age / 1000)}s ago`
          + ` (pid ${now.pid}${sameHost ? "" : ` on ${now.host}`}) and holds the lock`,
      };
    }
    writeFileSync(lockPath, body, { encoding: "utf8" });
  }

  let released = false;
  // Synchronous so it can run from a process "exit" handler, where promises
  // never settle. Only ever removes our own lock: a takeover may have happened.
  const releaseSync = () => {
    if (released) return;
    released = true;
    try {
      const cur = JSON.parse(readFileSync(lockPath, "utf8"));
      if (cur.pid !== process.pid || cur.host !== os.hostname()) return;
    } catch { /* unreadable or already gone — fall through to the unlink */ }
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  };
  const release = async () => releaseSync();

  // Backstop for a hard exit. This fires on process.exit() from anywhere,
  // including a forced Ctrl+C, so the lock is cleaned up without needing a
  // signal handler of our own.
  process.once("exit", releaseSync);

  // Only take over the signal if the application has not said how it wants to
  // handle it. quick-send.js, for one, asks the send loop to stop at a clean
  // boundary — hard-exiting from here used to pre-empt that, killing the run
  // mid-send so the person just messaged was never recorded and got a second
  // copy on the next run.
  // process.once removes its own wrapper *before* invoking it, so by the time
  // this runs the count reflects only other listeners: 0 means the application
  // has no opinion and we must terminate it ourselves, anything else means it
  // does and we must not.
  const signalExit = (signal, code) => () => {
    releaseSync();
    if (process.listenerCount(signal) === 0) process.exit(code);
  };
  process.once("SIGINT", signalExit("SIGINT", 130));
  process.once("SIGTERM", signalExit("SIGTERM", 143));

  return { ok: true, release };
}
