// Startup check on where the credentials live.
//
// A Telegram session string is not a password — it is a restored login. Copy the
// string to another machine and Telegram opens the account with no password, no
// SMS code and no 2FA challenge; this is exactly how infostealers take Telegram
// accounts, and why 2FA does not help once the string is out. So the file's
// location *is* its protection, and a credential inside OneDrive / Dropbox /
// Google Drive has been uploaded to a third party and is replicated to every
// device signed into that drive.
//
// This warns; it never moves anything. `node tools/secure-secrets.js` does the
// move, on purpose, when you ask it to.
import { existsSync } from "node:fs";
import path from "node:path";
import { PATHS } from "./config.js";
// The .env path is passed in rather than imported from auth.js — auth.js calls
// into here, and importing back would make the cycle.

const CLOUD = [
  [/[\\/]onedrive[\\/]/i, "OneDrive"],
  [/[\\/]dropbox[\\/]/i, "Dropbox"],
  [/[\\/]google drive[\\/]/i, "Google Drive"],
  [/[\\/]my drive[\\/]/i, "Google Drive"],
  [/[\\/]icloud ?drive[\\/]/i, "iCloud Drive"],
  [/[\\/]yandex\.?disk[\\/]/i, "Yandex Disk"],
];

export function cloudProviderOf(filePath) {
  for (const [re, name] of CLOUD) if (re.test(String(filePath))) return name;
  return null;
}

/**
 * @returns {{ file: string, provider: string }[]} exposed credential files
 */
export function auditSecretLocations({ envPath = null } = {}) {
  const candidates = [
    envPath,
    PATHS.ACCOUNTS_JSON,
    PATHS.MULTI_ACCOUNT_JSON,
  ];
  const found = [];
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue;
    const provider = cloudProviderOf(file);
    if (provider) found.push({ file, provider });
  }
  return found;
}

let warned = false;

// Called once per run from validateEnv. Quiet when there is nothing to say, and
// silent under RELEVANTY_SKIP_SECRET_WARNING=1 for anyone who has read this and
// decided to accept it.
export function warnOnSecretLocations({ envPath = null, log = console.warn } = {}) {
  if (warned || process.env.RELEVANTY_SKIP_SECRET_WARNING === "1") return [];
  warned = true;

  const exposed = auditSecretLocations({ envPath });
  if (!exposed.length) return [];

  const provider = exposed[0].provider;
  log(`\n  ⚠ Credentials are inside ${provider} — they are synced off this machine.`);
  for (const { file } of exposed) {
    log(`      ${path.relative(process.cwd(), file) || file}`);
  }
  log("    A Telegram session string restores the account with no password, no SMS");
  log("    and no 2FA prompt. Move them out:  node tools/secure-secrets.js --apply");
  log("    Silence this with RELEVANTY_SKIP_SECRET_WARNING=1.\n");
  return exposed;
}
