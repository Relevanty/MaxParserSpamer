// Multi-account batch parser. Spreads the target links across every saved
// account and parses them in parallel — one isolated child process per account,
// each running parse-batch.js for its own slice of the targets.
//
// Why a child per account (mirrors tools/multi.js): startClient() reads the
// session/proxy from process.env at connect time and can re-save the session to
// its env file, so several accounts cannot share one process safely. Each child
// gets its own SESSION_STRING + SOCKS_PROXY, RELEVANTY_PROFILE (so an expired
// session fails fast instead of hanging on an unscannable QR), and a per-profile
// DOTENV_CONFIG_PATH so a refreshed session never clobbers the main .env.
//
// Targets are partitioned (round-robin) so each group is parsed by exactly one
// account — no two accounts touch the same lists/<name>.txt file. A single group
// still parses on a single account (splitting one group's member scan across
// accounts would need query sharding; not done here).
//
// Sessions are health-checked before the targets are dealt out, so an expired
// account is dropped rather than taking its share of the targets with it.
//
//   node src/parse-multi.js                 parse parse/links.txt across all accounts
//   node src/parse-multi.js @a @b           parse the given targets across all accounts
//   node src/parse-multi.js --no-preflight  skip the session check (deal out blind)
import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";

import { loadAccounts } from "./storage.js";
import { resolveTargets } from "./parse-batch.js";
import { preflightAccounts, isHealthy } from "./preflight.js";
import { PATHS } from "./config.js";

// The per-account child script. Overridable via env so the orchestration
// (partitioning + per-child isolation) can be dry-run against a stub without
// connecting to Telegram.
const RUN_PARSE = process.env.RELEVANTY_PARSE_CHILD || path.resolve("src", "parse-batch.js");
const COLORS = ["\x1b[36m", "\x1b[32m", "\x1b[35m", "\x1b[33m", "\x1b[34m", "\x1b[31m"];
const RESET = "\x1b[0m";
const GRAY = "\x1b[90m";

// accounts.json often stores several sessions for the SAME real account (repeat
// logins). Running one account in multiple parallel processes risks a ban, so
// keep the first session per identity and drop entries without a session.
function distinctAccounts(all) {
  const seen = new Set();
  const out = [];
  for (const a of all) {
    const key = String(a.name ?? "").trim() || String(a.session ?? "");
    if (!key || !a.session || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function partition(items, n) {
  const buckets = Array.from({ length: n }, () => []);
  items.forEach((item, i) => buckets[i % n].push(item));
  return buckets;
}

function streamLines(stream, prefix, sink) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      sink(`${prefix} ${line}`);
    }
  });
  stream.on("end", () => {
    if (buffer.trim()) sink(`${prefix} ${buffer}`);
  });
}

function runChild(account, targets, color, profile) {
  const prefix = `${color}[${profile}]${RESET}`;
  const childEnv = {
    ...process.env,
    SESSION_STRING: account.session,
    RELEVANTY_PROFILE: profile,
    DOTENV_CONFIG_PATH: path.resolve(`.env.${profile}`),
  };
  if (account.proxy) childEnv.SOCKS_PROXY = String(account.proxy);
  else delete childEnv.SOCKS_PROXY;

  console.log(`${prefix} ${GRAY}${account.name || "account"} — ${targets.length} target(s): ${targets.join(", ")}${RESET}`);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUN_PARSE, ...targets], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"], // no stdin: fail fast rather than hang on a QR prompt
    });
    streamLines(child.stdout, prefix, (l) => console.log(l));
    streamLines(child.stderr, prefix, (l) => console.error(l));
    child.on("exit", (code) => {
      console.log(`${prefix} ${code === 0 ? "done" : `exited with code ${code}`}`);
      resolve({ profile, name: account.name, code: code ?? -1, targets: targets.length });
    });
    child.on("error", (err) => {
      console.error(`${prefix} spawn error: ${err.message}`);
      resolve({ profile, name: account.name, code: -1, targets: targets.length });
    });
  });
}

async function main() {
  const targets = await resolveTargets();
  if (targets.length === 0) {
    console.log("\nNothing to parse. Add Telegram links to parse/links.txt and run again.");
    process.exit(0);
  }

  let accounts = distinctAccounts(await loadAccounts(PATHS.ACCOUNTS_JSON))
    .map((account, i) => ({ ...account, profile: `parse${i + 1}` }));

  // No saved accounts — keep the original single-session behaviour (uses .env).
  if (accounts.length === 0) {
    console.log("No saved accounts in storage/accounts.json — parsing with the .env session only.\n");
    const child = spawn(process.execPath, [RUN_PARSE, ...targets], { cwd: process.cwd(), env: process.env, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 1));
    child.on("error", (err) => { console.error(err.message); process.exit(1); });
    return;
  }

  // Preflight before partitioning. A dead session used to take its whole target
  // group down with it: the child exited with "session missing or expired" and
  // those targets were never parsed by anyone. Checking first means the targets
  // get dealt out to the accounts that can actually parse them.
  if (!process.argv.includes("--no-preflight")) {
    console.log("Preflight — checking sessions...\n");
    const health = await preflightAccounts(
      accounts.map((a) => ({ profile: a.profile, account: a.name, session: a.session, proxy: a.proxy })),
      { apiId: process.env.API_ID, apiHash: process.env.API_HASH },
    );
    for (const h of health) {
      const sess = h.sessionOk ? "\x1b[32m✓ session\x1b[0m" : "\x1b[31m✗ session\x1b[0m";
      console.log(`  ${h.profile.padEnd(8)} ${sess}  ${GRAY}${h.name || ""}${h.error ? ` — ${h.error}` : ""}${RESET}`);
    }
    const healthy = new Set(health.filter(isHealthy).map((h) => h.profile));
    const dead = accounts.filter((a) => !healthy.has(a.profile));
    if (dead.length) {
      console.log(
        `\n${GRAY}Skipping ${dead.map((a) => `${a.name || a.profile}`).join(", ")} ` +
        `— re-add via the Accounts menu to bring ${dead.length > 1 ? "them" : "it"} back.${RESET}`,
      );
    }
    accounts = accounts.filter((a) => healthy.has(a.profile));
    if (accounts.length === 0) {
      console.log("\nEvery saved session is expired — nothing can be parsed. Re-add an account via the Accounts menu.");
      process.exit(1);
    }
  }

  // One account per target group; idle accounts beyond the target count add nothing.
  const n = Math.min(accounts.length, targets.length);
  const useAccounts = accounts.slice(0, n);
  const buckets = partition(targets, n);

  console.log(`\nParsing ${targets.length} target(s) across ${n} account(s) in parallel.`);
  if (accounts.length > n) {
    console.log(`${GRAY}(${accounts.length} accounts available; ${n} used — one per target group.)${RESET}`);
  }
  console.log();

  const results = await Promise.all(
    useAccounts.map((account, i) => runChild(account, buckets[i], COLORS[i % COLORS.length], account.profile)),
  );

  console.log("\n─── Multi-account parse summary ───");
  for (const r of results) {
    const label = (r.name || r.profile).padEnd(16);
    console.log(`  ${r.code === 0 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"}  ${label} ${r.targets} target(s)${r.code === 0 ? "" : `  (exit ${r.code})`}`);
  }
  process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
}

main().catch((err) => {
  console.error("parse-multi error:", err?.message || err);
  process.exit(1);
});
