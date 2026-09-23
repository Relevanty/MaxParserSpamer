import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { PATHS } from "./config.js";
import { parseCsvLine } from "./utils.js";
import { saveProgressState } from "./progress.js";

const RETRY_LIST_PATH = path.resolve("lists", "0-retry.txt");

function isSuccess(status) {
  return status === "Success" || status.startsWith("Scheduled:");
}

function isSkipped(status) {
  return status.startsWith("Skipped:");
}

async function parseFailedUsers(csvPath) {
  let raw;
  try {
    raw = await readFile(csvPath, "utf8");
  } catch {
    console.error(`report.csv not found at ${csvPath}`);
    process.exit(1);
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());

  // Track per-user: did they ever succeed? did they ever fail?
  const succeeded = new Set();
  const failed = new Set();
  const order = [];

  for (const line of lines) {
    const cols = parseCsvLine(line);
    if (cols.length < 5) continue;

    const user = cols[1].trim();
    // Status is the last column, not a fixed index: rows written before the
    // Template column have 5 fields and later ones have 6. Reading cols[4]
    // picked up the template on every newer row, so successful sends looked
    // like failures and landed back in the retry list to be messaged twice.
    const status = cols[cols.length - 1].trim();

    // Skip the header. REPORT_HEADER writes "User"/"Status" capitalised, so a
    // case-sensitive compare let the header through as a failed recipient and
    // "User" ended up in the retry list as someone to message.
    if (!user || user.toLowerCase() === "user") continue;

    if (isSuccess(status)) {
      succeeded.add(user);
    } else if (!isSkipped(status)) {
      // Error: ..., PEER_FLOOD resolved, PEER_FLOOD wait 40min, etc.
      if (!failed.has(user)) {
        order.push(user);
        failed.add(user);
      }
    }
  }

  // Users who failed and were never successfully sent to
  return order.filter((u) => !succeeded.has(u));
}

async function main() {
  const failedUsers = await parseFailedUsers(PATHS.REPORT_CSV);

  if (failedUsers.length === 0) {
    console.log("No failed users found in report.csv.");
    return;
  }

  await mkdir(path.dirname(RETRY_LIST_PATH), { recursive: true });
  await writeFile(RETRY_LIST_PATH, failedUsers.join("\n") + "\n", "utf8");

  // Reset progress so findResumeIndexFromProcessed can place us correctly
  await saveProgressState(PATHS.PROGRESS_STATE_JSON, 0, 0);

  console.log(`Wrote ${failedUsers.length} users to lists/0-retry.txt`);
  console.log("Progress reset to 0. Run npm start to retry them.");
}

main().catch((err) => { console.error(err); process.exit(1); });
