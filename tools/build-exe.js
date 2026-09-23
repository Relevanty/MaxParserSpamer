// Build a standalone Windows .exe of the interactive app.
//
// Uses caxa, which embeds the real Node binary + node_modules and runs the
// app unmodified — so ESM, dynamic imports, discord.js and gramjs all work.
//
// The exe is built from a CLEAN staging directory (code + node_modules only),
// so secrets and user data (.env, storage/, lists/, messages/) are NEVER baked
// in. Those are read from the working directory at runtime, so keep Relevanty.exe
// in the project folder and launch it from there.
//
// Run:  npm run build:exe

import { execSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = path.join(tmpdir(), "relevanty-stage");
const OUT   = path.join(ROOT, "Relevanty.exe");

// Only these are needed at runtime. Everything else (secrets, lists, storage,
// reports, .git) is deliberately left out of the binary.
const INCLUDE = ["src", "tools", "package.json", "node_modules"];

console.log("→ staging clean inputs (no secrets) ...");
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const entry of INCLUDE) {
  const from = path.join(ROOT, entry);
  if (!existsSync(from)) {
    console.error(`   missing required input: ${entry}`);
    process.exit(1);
  }
  cpSync(from, path.join(STAGE, entry), { recursive: true });
}

console.log("→ packaging with caxa (embeds Node + node_modules) ...");
execSync(
  [
    "npx --yes caxa@3.0.1",
    `--input "${STAGE}"`,
    `--output "${OUT}"`,
    "--no-dedupe",
    `--uncompression-message "Starting Relevanty (first run unpacks, please wait)..."`,
    `-- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/tools/start.js"`,
  ].join(" "),
  { stdio: "inherit" },
);

rmSync(STAGE, { recursive: true, force: true });

const mb = (statSync(OUT).size / 1024 / 1024).toFixed(0);
console.log(`\n✓ Built ${OUT}  (${mb} MB)`);
console.log("  Keep it in the project folder and run it from there — it reads");
console.log("  .env / lists / messages / storage from the current directory.");
