// Run the flood-resolution routine on demand.
//
// The same routine the sender runs automatically when it hits PEER_FLOOD
// (src/index.js attemptUnblock): /start to @SpamBot, then "Why was I reported?"
// and "I understand, thanks", then re-read the status.
//
// Read this before trusting the result: @SpamBot only knows about *account-level
// moderation limits* — a human or automated moderation action after user reports.
// It cannot see, and cannot lift, the separate cap Telegram puts on how many
// people you may message who have never talked to you. That cap is what raises
// PEER_FLOOD on a cold send. So "no limits are currently applied" is a true
// answer to a different question, and a clean run here does not mean the next
// cold message will go through.
//
//   node tools/unflood.js          check status and run the appeal flow
//   node tools/unflood.js --check  status only, click nothing
import "dotenv/config";
import { validateEnv, startClient } from "../src/auth.js";
import { attemptUnblock, getStatusBotStatus } from "../src/index.js";

const checkOnly = process.argv.includes("--check");
const { apiId, apiHash, forceSms, authMethod } = validateEnv();
const client = await startClient(apiId, apiHash, forceSms, authMethod);

try {
  const me = await client.getMe();
  console.log(`\naccount: @${me.username}${me.premium ? " (Premium)" : ""}`);

  const before = await getStatusBotStatus(client);
  console.log(`\n@SpamBot says: ${before.statusText}`);
  console.log(`account-level restriction: ${before.hasRestriction ? "YES" : "no"}`);

  if (checkOnly) {
    console.log("\n--check given, stopping here.");
  } else if (!before.hasRestriction) {
    console.log("\nNothing for the appeal flow to lift — no account-level limit is set.");
    console.log("If a cold send still raises PEER_FLOOD, it is the non-contact cap,");
    console.log("which @SpamBot neither sees nor controls. That one clears with time");
    console.log("and with a lower share of one-way conversations, not with a button.");
  } else {
    const ok = await attemptUnblock(client);
    console.log(`\nappeal flow result: ${ok ? "restriction reported as lifted" : "still restricted"}`);
    if (ok) {
      console.log("Treat this as permission to resume slowly, not fully. The sender");
      console.log("still applies POST_FLOOD_COOLDOWN_MS after any PEER_FLOOD.");
    }
  }
} finally {
  await client.disconnect().catch(() => {});
}
