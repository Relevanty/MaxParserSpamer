export function getUserIdentifier(user) {
  if (user.username) return user.username;
  return null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeUsername(raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return null;
  }
  return value.startsWith("@") ? value : `@${value}`;
}

export function usernameKey(username) {
  return String(username).trim().toLowerCase();
}

export function csvEscape(value) {
  const stringValue = String(value ?? "");
  if (/[,"\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

export function parseCsvLine(line) {
  const cols = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      cols.push(current); current = "";
    } else {
      current += ch;
    }
  }
  cols.push(current);
  return cols;
}

export function htmlEscape(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
