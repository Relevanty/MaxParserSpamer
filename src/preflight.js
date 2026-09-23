// Pre-run health check for parallel accounts. For each account it connects with
// that account's session + proxy and verifies the session is still authorized,
// so a run never burns attempts on a dead session or a broken proxy discovered
// mid-flight. Each check is time-boxed so a hanging proxy can't stall the batch.
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { ConnectionTCPFull } from "telegram/network/index.js";

import { parseProxy } from "./utils.js";
import { PREFLIGHT_TIMEOUT_MS } from "./config.js";

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function buildProxy(proxyStr) {
  const p = parseProxy(proxyStr);
  if (!p) return undefined;
  return {
    ip: p.host,
    port: p.port,
    socksType: p.type,
    ...(p.username ? { username: p.username } : {}),
    ...(p.password ? { password: p.password } : {}),
  };
}

async function checkOne(entry, defaults, timeoutMs) {
  const result = {
    profile: entry.profile,
    name: entry.account || null,
    sessionOk: false,
    proxyOk: entry.proxy ? false : null, // null = no proxy configured
    error: null,
  };

  if (!entry.session) {
    result.error = "no session";
    return result;
  }

  const apiId = Number(entry.apiId || defaults.apiId);
  const apiHash = String(entry.apiHash || defaults.apiHash || "");
  const proxy = buildProxy(entry.proxy);

  const client = new TelegramClient(new StringSession(entry.session), apiId, apiHash, {
    connection: ConnectionTCPFull,
    connectionRetries: 1,
    timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    ...(proxy ? { proxy } : {}),
    receiveUpdates: false,
  });
  try { client.setLogLevel("none"); } catch { /* older gramJS */ }

  try {
    await withTimeout(client.connect(), timeoutMs, "connect timeout (proxy?)");
    if (proxy) result.proxyOk = true; // reaching Telegram through the proxy worked
    const authed = await withTimeout(client.checkAuthorization(), timeoutMs, "auth check timeout");
    result.sessionOk = Boolean(authed);
    if (authed) {
      try {
        const me = await withTimeout(client.getMe(), timeoutMs, "getMe timeout");
        result.name = me?.phone ? `+${me.phone}` : (me?.username || result.name);
      } catch { /* name is best-effort */ }
    } else {
      result.error = "session expired / unauthorized";
    }
  } catch (err) {
    result.error = err?.message || String(err);
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
    try { await client.destroy?.(); } catch { /* ignore */ }
  }
  return result;
}

// Sequentially health-check each entry (entries must already carry a resolved
// `session`). Returns [{ profile, name, sessionOk, proxyOk, error }].
export async function preflightAccounts(entries, { apiId, apiHash, timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  const defaults = { apiId, apiHash };
  const results = [];
  for (const entry of entries) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await checkOne(entry, defaults, timeoutMs));
  }
  return results;
}

// An account is runnable if its session is valid and its proxy (when set) works.
export function isHealthy(result) {
  return result.sessionOk === true && result.proxyOk !== false;
}
