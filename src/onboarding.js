// First-run setup wizard. Turns "just installed, dropped at a menu" into a
// guided path: pick a language, enter Telegram API keys (written to .env), log
// in, and read a one-screen explanation of the parse → compose → send workflow.
//
// Runs only for a genuinely fresh install (no session and no saved accounts) and
// is fully skippable. Once completed or skipped it sets settings.onboarded so it
// never nags again.
import { existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import path from "node:path";

import { R, COLORS, sectionTitle } from "./animate.js";
import { showMenu, askText, askConfirm } from "./prompt.js";
import { loadSettings, saveSettings } from "./settings.js";
import { upsertEnvValue, resolveEnvPath, loginAndSaveAccount } from "./auth.js";
import { t, setLang } from "./i18n.js";
import { sleep } from "./utils.js";

const DEFAULT_API_HASH = "b18441a1ff607e10a989891a5462e627"; // Telegram's built-in fallback

// Real credentials = present, numeric, and not Telegram's shared defaults.
function hasRealApiCreds() {
  const id = String(process.env.API_ID || "").trim();
  const hash = String(process.env.API_HASH || "").trim();
  const n = Number(id);
  const idOk = id && !Number.isNaN(n) && n > 0 && id !== "2040";
  const hashOk = hash && hash !== DEFAULT_API_HASH;
  return idOk && hashOk;
}

// Only onboard a truly fresh install: never onboarded, no active session, and no
// saved accounts. An existing user (session in .env or accounts.json) is skipped.
export function needsOnboarding(settings, accounts) {
  if (settings?.onboarded) return false;
  const hasSession = !!String(process.env.SESSION_STRING || "").trim();
  return !hasSession && (accounts?.length ?? 0) === 0;
}

async function markDone(settings) {
  settings.onboarded = true;
  await saveSettings(settings);
}

export async function runOnboarding() {
  const settings = await loadSettings();

  // ── Language ────────────────────────────────────────────────────────────────
  await sectionTitle(t("obWelcomeTitle"));
  const lang = await showMenu(
    [
      { name: "  EN — English", value: "en" },
      { name: "  RU — Русский", value: "ru" },
    ],
    settings.language === "ru" ? 1 : 0,
  );
  setLang(lang);
  settings.language = lang;
  await saveSettings(settings);

  console.log(`\n  ${COLORS.gray}${t("obWelcomeIntro")}${R}\n`);
  const go = await showMenu([
    { name: `  ${COLORS.cyan}${t("obStartBtn")}${R}`, value: "go" },
    { name: `  ${COLORS.gray}${t("obSkipBtn")}${R}`, value: "skip", muted: true },
  ]);
  if (go === "skip") {
    await markDone(settings);
    return;
  }

  // Make sure a .env exists before we write keys into it.
  const envPath = resolveEnvPath();
  try {
    const example = path.resolve(".env.example");
    if (!existsSync(envPath) && existsSync(example)) await copyFile(example, envPath);
  } catch { /* non-fatal — upsertEnvValue creates the file if needed */ }

  // ── Step 1: API keys ──────────────────────────────────────────────────────────
  await sectionTitle(t("obApiTitle"));
  if (hasRealApiCreds()) {
    console.log(`  ${COLORS.green}${t("obApiHave")}${R}\n`);
    await sleep(500);
  } else {
    console.log(`  ${COLORS.gray}${t("obApiExplain")}${R}`);
    console.log(`  ${COLORS.cyan}${t("obApiLink")}${R}\n`);
    const apiId = (await askText(t("obApiIdPrompt"), "")).trim();
    const apiHash = (await askText(t("obApiHashPrompt"), "")).trim();
    if (apiId && apiHash) {
      process.env.API_ID = apiId;
      process.env.API_HASH = apiHash;
      await upsertEnvValue(envPath, "API_ID", apiId);
      await upsertEnvValue(envPath, "API_HASH", apiHash);
      console.log(`\n  ${COLORS.green}${t("obApiSaved")}${R}\n`);
    } else {
      console.log(`\n  ${COLORS.yellow}${t("obApiSkipWarn")}${R}\n`);
    }
    await sleep(900);
  }

  // ── Step 2: login ─────────────────────────────────────────────────────────────
  await sectionTitle(t("obLoginTitle"));
  console.log(`  ${COLORS.gray}${t("obLoginExplain")}${R}\n`);
  console.log(`  ${COLORS.gray}${t("obLoginNowPrompt")}${R}`);
  process.stdout.write("  ");
  if (await askConfirm()) {
    try {
      const acct = await loginAndSaveAccount({ activate: true });
      console.log(`\n  ${COLORS.green}${t("obLoginOk", acct.name)}${R}\n`);
    } catch (err) {
      console.log(`\n  ${COLORS.red}${t("obLoginErr", err?.message || String(err))}${R}\n`);
    }
    await sleep(1300);
  } else {
    console.log(`\n  ${COLORS.gray}${t("obLoginSkipped")}${R}\n`);
    await sleep(800);
  }

  // ── Step 3: orientation ───────────────────────────────────────────────────────
  await sectionTitle(t("obFlowTitle"));
  for (const line of t("obFlowBody").split("\n")) {
    console.log(line ? `  ${COLORS.gray}${line}${R}` : "");
  }
  console.log(`\n  ${COLORS.cyan}${t("obReady")}${R}\n`);
  await sleep(1600);

  await markDone(settings);
}
