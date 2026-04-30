import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function loadProcessedUsers(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const cleaned = raw.trim();
    if (!cleaned) {
      return new Set();
    }
    const parsed = JSON.parse(cleaned);
    if (!parsed || !Array.isArray(parsed.processed)) {
      return new Set();
    }
    return new Set(parsed.processed.map((x) => String(x).toLowerCase()));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) {
      return new Set();
    }
    throw error;
  }
}

export async function saveProcessedUsers(filePath, processedUsersSet) {
  await mkdir(dirname(filePath), { recursive: true });
  const payload = {
    processed: Array.from(processedUsersSet).sort(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function loadAccounts(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (error) {
    return [];
  }
}

export async function saveAccounts(filePath, accounts) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(accounts, null, 2)}\n`, "utf8");
}
