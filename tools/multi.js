// Multi-account parallel runner.
//
// Reads storage/multi-account.json, then spawns ONE isolated child process per
// account. Each child gets its own Telegram session, optional SOCKS proxy, and
// its own storage namespace (RELEVANTY_PROFILE) so progress / processed-users /
// daily-limit / reports never collide. Lists are assigned per account (manual).
//
//   node tools/multi.js            run all accounts in the config
//   node tools/multi.js --init     scaffold a sample config from accounts.json
//   node tools/multi.js acct1 acct3   run only the named profiles
import "dotenv/config";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadAccounts } from "../src/storage.js";
import { listListFiles } from "../src/io.js";
import { validateMultiConfig, maskProxy } from "../src/utils.js";
import { preflightAccounts, isHealthy } from "../src/preflight.js";

const CONFIG_PATH = path.resolve("storage", "multi-account.json");
const ACCOUNTS_PATH = path.resolve("storage", "accounts.json");
const RUN_ACCOUNT = path.resolve("src", "run-account.js");

const COLORS = ["\x1b[36m", "\x1b[32m", "\x1b[35m", "\x1b[33m", "\x1b[34m", "\x1b[31m"];
const RESET = "\x1b[0m";
const GRAY = "\x1b[90m";

// Keys that configure the account/transport itself — everything else in an
// account entry is forwarded to runSender as a setting.
const RESERVED_KEYS = new Set(["profile", "account", "session", "apiId", "apiHash", "proxy"]);

async function loadConfig() {
  const raw = await readFile(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.accounts)) {
    throw new Error("Config must be an object with an \"accounts\" array.");
  }
  return parsed;
}

async function scaffoldConfig() {
  if (existsSync(CONFIG_PATH)) {
    console.error(`Config already exists at ${CONFIG_PATH} — not overwriting.`);
    process.exit(1);
  }
  const allAccounts = await loadAccounts(ACCOUNTS_PATH);
  // Dedupe by account identity (name/phone). accounts.json often holds several
  // sessions for the SAME account (repeat logins); running one real account many
  // times in parallel = instant ban, so keep only the first session per identity.
  const seenNames = new Set();
  const accounts = allAccounts.filter((a) => {
    const key = String(a.name ?? a.session ?? "");
    if (!key || seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });
  let lists = [];
  try {
    lists = (await listListFiles(path.resolve("lists"))).map((f) => f.replace(/\.txt$/i, ""));
  } catch { /* lists dir may not exist yet */ }

  // Round-robin the available lists across the saved accounts as a starting point.
  const sample = {
    defaults: {
      sendMode: "instant",
      messageSource: "maxim",
      maximIntervals: "2-1-2",
      maximN: 1,
      allowExistingChats: false,
      ignoreProcessed: false,
      lang: "ru",
    },
    accounts: (accounts.length ? accounts : [{ name: "REPLACE_ME" }]).map((a, i) => ({
      profile: `acct${i + 1}`,
      account: a.name,
      proxy: "",
      lists: lists.filter((_, idx) => idx % Math.max(accounts.length, 1) === i),
    })),
  };

  await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(sample, null, 2)}\n`, "utf8");
  console.log(`Wrote sample config to ${CONFIG_PATH}`);
  console.log("Edit it: set a unique `proxy` per account (strongly recommended) and adjust `lists`.");
}

function resolveSession(entry, accounts) {
  if (entry.session) return entry.session;
  if (entry.account) {
    const match = accounts.find((a) => a.name === entry.account);
    if (match) return match.session;
    throw new Error(`Account "${entry.account}" (profile ${entry.profile}) not found in accounts.json`);
  }
  throw new Error(`Profile ${entry.profile} has neither "session" nor "account".`);
}

function buildSettings(defaults, entry) {
  const settings = { ...defaults };
  for (const [key, value] of Object.entries(entry)) {
    if (!RESERVED_KEYS.has(key)) settings[key] = value;
  }
  return settings;
}

// ── Aggregate dashboard ───────────────────────────────────────────────────────
// Live per-profile tallies, updated from children's RLV_EVT lines. Rendered as a
// throttled snapshot (a true in-place TUI panel would fight the passthrough log
// lines, so we print a compact block periodically instead).
const STATS = new Map(); // profile -> { color, sent, skip, err, last, status }
const START_MS = Date.now();
let lastPaint = 0;

function elapsed() {
  const s = Math.floor((Date.now() - START_MS) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function paintDashboard(force = false) {
  const now = Date.now();
  if (!force && now - lastPaint < 3000) return;
  lastPaint = now;
  let sent = 0; let skip = 0; let err = 0;
  const lines = [];
  for (const [profile, s] of STATS) {
    sent += s.sent; skip += s.skip; err += s.err;
    lines.push(`  ${s.color}${profile.padEnd(10)}${RESET} sent ${String(s.sent).padStart(3)}  skip ${String(s.skip).padStart(3)}  err ${String(s.err).padStart(2)}  ${GRAY}${s.status}${RESET}`);
  }
  console.log(`\n${GRAY}── dashboard  ${elapsed()} ──${RESET}`);
  for (const l of lines) console.log(l);
  console.log(`  ${"total".padEnd(10)} sent ${String(sent).padStart(3)}  skip ${String(skip).padStart(3)}  err ${String(err).padStart(2)}\n`);
}

function handleEvent(profile, ev) {
  const s = STATS.get(profile);
  if (!s) return;
  if (ev.type === "sent") { s.sent += 1; s.status = `→ ${ev.user ?? ""}${ev.ms != null ? ` (${ev.ms}ms)` : ""}`.slice(0, 30); }
  else if (ev.type === "skip") { s.skip += 1; }
  else if (ev.type === "error") { s.err += 1; s.status = `err ${ev.user ?? ""}`.slice(0, 30); }
  else if (ev.type === "flood") { s.status = "PEER_FLOOD"; }
  else if (ev.type === "tick") { s.status = `→ ${ev.user ?? ""}`.slice(0, 30); }
  paintDashboard();
}

function streamLines(stream, profile, prefix, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("RLV_EVT ")) {
        try { handleEvent(profile, JSON.parse(line.slice(8))); } catch { /* ignore */ }
      } else if (line.length) {
        onLine(`${prefix} ${line}`);
      }
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) onLine(`${prefix} ${buffer}`);
  });
}

function runAccount(entry, defaults, accounts, color) {
  const profile = entry.profile;
  if (!profile) throw new Error("Every account entry needs a unique \"profile\".");

  const session = entry.session || resolveSession(entry, accounts);
  const settings = buildSettings(defaults, entry);
  const prefix = `${color}[${profile}]${RESET}`;
  STATS.set(profile, { color, sent: 0, skip: 0, err: 0, last: "", status: "starting" });

  const childEnv = {
    ...process.env,
    RELEVANTY_PROFILE: profile,
    RELEVANTY_SETTINGS: JSON.stringify(settings),
    SESSION_STRING: session,
    // Shared across ALL accounts: guarantees no two accounts message the same user.
    RELEVANTY_SHARED_CLAIMS: path.resolve("storage", "shared-claims.json"),
    // Re-saved sessions land in a per-profile env file, never the main .env.
    DOTENV_CONFIG_PATH: path.resolve(`.env.${profile}`),
  };
  if (entry.apiId) childEnv.API_ID = String(entry.apiId);
  if (entry.apiHash) childEnv.API_HASH = String(entry.apiHash);
  if (entry.proxy) childEnv.SOCKS_PROXY = String(entry.proxy);
  if (settings.sendMode) childEnv.SEND_MODE = String(settings.sendMode);

  console.log(`${prefix} starting — lists: ${(entry.lists || []).join(", ") || "(all)"}  proxy: ${entry.proxy ? maskProxy(entry.proxy) : `${GRAY}none${RESET}`}`);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUN_ACCOUNT], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"], // no stdin: fail fast instead of hanging on QR login
    });

    streamLines(child.stdout, profile, prefix, (l) => console.log(l));
    streamLines(child.stderr, profile, prefix, (l) => console.error(l));

    child.on("exit", (code) => {
      const ok = code === 0;
      const s = STATS.get(profile);
      if (s) s.status = ok ? "done" : `exit ${code}`;
      console.log(`${prefix} ${ok ? "done" : `exited with code ${code}`}`);
      resolve({ profile, code: code ?? -1, ok });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--init")) {
    await scaffoldConfig();
    return;
  }

  if (!existsSync(CONFIG_PATH)) {
    console.error(`No config at ${CONFIG_PATH}. Run: node tools/multi.js --init`);
    process.exit(1);
  }

  const config = await loadConfig();
  const defaults = config.defaults || {};
  const accounts = await loadAccounts(ACCOUNTS_PATH);
  const skipPreflight = args.includes("--no-preflight");

  // Validate the config up front — abort on structural problems.
  const problems = validateMultiConfig(config);
  if (problems.length) {
    console.error("Config problems:");
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }

  const onlyProfiles = args.filter((a) => !a.startsWith("--"));
  let entries = config.accounts;
  if (onlyProfiles.length) {
    entries = entries.filter((e) => onlyProfiles.includes(e.profile));
    if (!entries.length) {
      console.error(`No matching profiles for: ${onlyProfiles.join(", ")}`);
      process.exit(1);
    }
  }

  // Resolve each entry's session now (from inline session or accounts.json).
  entries = entries.map((e) => {
    try {
      return { ...e, session: resolveSession(e, accounts) };
    } catch (err) {
      console.error(`  ✗ ${e.profile}: ${err.message}`);
      return { ...e, session: null };
    }
  });

  // Preflight: verify every session + proxy before committing to a run.
  if (!skipPreflight) {
    console.log("Preflight — checking sessions & proxies...\n");
    const health = await preflightAccounts(entries, {
      apiId: process.env.API_ID,
      apiHash: process.env.API_HASH,
    });
    for (const h of health) {
      const sess = h.sessionOk ? "\x1b[32m✓ session\x1b[0m" : "\x1b[31m✗ session\x1b[0m";
      const prox = h.proxyOk === null ? `${GRAY}no proxy${RESET}` : (h.proxyOk ? "\x1b[32m✓ proxy\x1b[0m" : "\x1b[31m✗ proxy\x1b[0m");
      console.log(`  ${h.profile.padEnd(10)} ${sess}  ${prox}  ${GRAY}${h.name || ""}${h.error ? ` — ${h.error}` : ""}${RESET}`);
    }
    const healthyProfiles = new Set(health.filter(isHealthy).map((h) => h.profile));
    const skipped = entries.filter((e) => !healthyProfiles.has(e.profile));
    if (skipped.length) {
      console.log(`\n${GRAY}Skipping unhealthy: ${skipped.map((e) => e.profile).join(", ")}${RESET}`);
    }
    entries = entries.filter((e) => healthyProfiles.has(e.profile));
    if (entries.length === 0) {
      console.error("\nNo healthy accounts to run.");
      process.exit(1);
    }
    console.log();
  }

  console.log(`Launching ${entries.length} account(s) in parallel...\n`);
  const results = await Promise.all(
    entries.map((entry, i) => runAccount(entry, defaults, accounts, COLORS[i % COLORS.length])),
  );

  paintDashboard(true);
  console.log("─── Summary ───");
  let tSent = 0; let tSkip = 0; let tErr = 0;
  for (const r of results) {
    const s = STATS.get(r.profile) || { sent: 0, skip: 0, err: 0 };
    tSent += s.sent; tSkip += s.skip; tErr += s.err;
    console.log(`  ${r.ok ? "✓" : "✗"}  ${r.profile.padEnd(10)} sent ${s.sent}  skip ${s.skip}  err ${s.err}${r.ok ? "" : `  (exit ${r.code})`}`);
  }
  console.log(`  ${"".padEnd(3)}${"TOTAL".padEnd(10)} sent ${tSent}  skip ${tSkip}  err ${tErr}`);
  const failed = results.filter((r) => !r.ok).length;
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("multi runner error:", err?.message || err);
  process.exit(1);
});
