// Move the credential files out of the cloud-synced project folder.
//
//   node tools/secure-secrets.js            # dry run — shows the plan, changes nothing
//   node tools/secure-secrets.js --apply    # do it
//
// What it moves, and why each one matters:
//   .env                       API_ID, API_HASH, SESSION_STRING
//   storage/accounts.json      one saved session string per account
//   storage/multi-account.json per-profile assignment, may hold sessions/proxies
//
// A session string is a restored login: no password, no SMS, no 2FA prompt. While
// these files sit in OneDrive they are on Microsoft's servers and on every device
// signed into the same drive.
//
// Destination: %LOCALAPPDATA%\Relevanty\secrets (not synced), locked to the
// current user with icacls. Afterwards two environment variables point the app
// at the new location — both are already honoured by the code:
//   DOTENV_CONFIG_PATH      → the moved .env
//   RELEVANTY_SECRETS_DIR   → the moved accounts.json / multi-account.json
//
// Nothing is deleted: each file is copied, verified byte-for-byte, and only then
// removed from the project. A .bak of the original stays in the destination.
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

const APPLY = process.argv.includes("--apply");
const HOME = process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
const DEST = process.env.RELEVANTY_SECRETS_DIR
  ? path.resolve(process.env.RELEVANTY_SECRETS_DIR)
  : path.join(HOME, "Relevanty", "secrets");

const FILES = [
  { from: path.resolve(".env"), to: path.join(DEST, ".env"), env: "DOTENV_CONFIG_PATH", what: "API_ID / API_HASH / SESSION_STRING" },
  { from: path.resolve("storage", "accounts.json"), to: path.join(DEST, "accounts.json"), what: "saved session strings" },
  { from: path.resolve("storage", "multi-account.json"), to: path.join(DEST, "multi-account.json"), what: "profile map, proxies" },
];

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

async function main() {
  console.log(`\nSecrets → ${DEST}`);
  console.log(APPLY ? "MODE: APPLY\n" : "MODE: dry run — pass --apply to move the files\n");

  const present = [];
  for (const f of FILES) {
    if (!existsSync(f.from)) { console.log(`  skip   ${path.relative(process.cwd(), f.from)} — not present`); continue; }
    const { size } = await stat(f.from);
    console.log(`  move   ${path.relative(process.cwd(), f.from)}  (${size} B — ${f.what})`);
    present.push(f);
  }
  if (!present.length) { console.log("\nNothing to move."); return; }

  if (existsSync(path.join(DEST, ".env")) && present.some(f => f.to.endsWith(".env"))) {
    console.log(`\n  ⚠ ${path.join(DEST, ".env")} already exists — it would be overwritten.`);
    console.log("    Move or delete it first; refusing to clobber a credential file.");
    if (APPLY) process.exit(1);
  }

  if (!APPLY) {
    console.log("\nThen set, once, in a normal (non-admin) prompt:");
    console.log(`  setx DOTENV_CONFIG_PATH "${path.join(DEST, ".env")}"`);
    console.log(`  setx RELEVANTY_SECRETS_DIR "${DEST}"`);
    console.log("\nScheduled tasks pick these up on their next run (they read the user");
    console.log("environment). Open a new terminal before running the app by hand.");
    return;
  }

  await mkdir(DEST, { recursive: true });

  // Strip inherited permissions and grant only this user. Without this the
  // destination keeps whatever the parent folder allowed.
  try {
    execFileSync("icacls", [DEST, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:(OI)(CI)F`], { stdio: "pipe" });
    console.log(`\n  locked ${DEST} to ${process.env.USERNAME} only`);
  } catch (err) {
    console.log(`\n  ⚠ could not tighten permissions on ${DEST}: ${String(err.message).slice(0, 80)}`);
    console.log("    The files still move; fix the ACL by hand if you care about other local accounts.");
  }

  for (const f of present) {
    const original = await readFile(f.from);
    await copyFile(f.from, f.to);
    const landed = await readFile(f.to);
    if (sha(original) !== sha(landed)) {
      console.log(`  FAIL   ${f.to} — copy does not match source, leaving the original in place`);
      continue;
    }
    // Keep a copy at the destination before the original goes away.
    await writeFile(f.to + ".bak", original);
    await rename(f.from, f.from + ".moved");
    console.log(`  moved  ${path.basename(f.from)} → ${f.to}  (original kept as ${path.basename(f.from)}.moved)`);
  }

  console.log("\nNow set the pointers, once, in a normal (non-admin) prompt:");
  console.log(`  setx DOTENV_CONFIG_PATH "${path.join(DEST, ".env")}"`);
  console.log(`  setx RELEVANTY_SECRETS_DIR "${DEST}"`);
  console.log("\nThen open a NEW terminal and check the app still logs in:");
  console.log("  node src/auto-reply.js --cap=1        # dry run, no sends");
  console.log("\nOnce that works, delete the *.moved leftovers — and because they were");
  console.log("in a synced folder, also clear them from the OneDrive recycle bin and");
  console.log("version history. Treat the old session strings as exposed: revoke them");
  console.log("in Telegram → Settings → Devices → Terminate other sessions.");
}

main().catch(err => { console.error(err); process.exit(1); });
