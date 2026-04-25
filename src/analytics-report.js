import { readFile, writeFile } from "node:fs/promises";
import { PATHS } from "./config.js";
import { parseCsvLine, csvEscape, htmlEscape } from "./utils.js";

class ReportParser {
  async parse(csvPath) {
    const content = await readFile(csvPath, "utf8");
    const lines = content.trim().split(/\r?\n/);
    const header = parseCsvLine(lines[0] ?? "").map(s => s.trim().toLowerCase());
    const hasMessageCount = header.includes("messagecount");
    const statusIdx = hasMessageCount ? 4 : 3;

    const rows = [];
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      rows.push({
        timestamp: cols[0]?.trim() ?? "",
        user: cols[1]?.trim().toLowerCase() ?? "",
        mode: cols[2]?.trim() ?? "",
        messageCount: hasMessageCount ? (cols[3]?.trim() ?? "") : "",
        status: cols[statusIdx]?.trim() ?? "",
      });
    }
    return rows;
  }
}

class ReportBuilder {
  #rows;
  #conversations;

  constructor(rows, conversations) {
    this.#rows = rows;
    this.#conversations = conversations;
  }

  build() {
    const sent = this.#rows.filter(
      r => r.status === "Success" || r.status.startsWith("Scheduled:"),
    );

    const groups = {};
    for (const row of sent) {
      const key = row.messageCount || "unknown";
      (groups[key] ??= []).push(row);
    }

    const groupStats = Object.fromEntries(
      Object.entries(groups).map(([key, rows]) => [key, this.#statsForGroup(rows)]),
    );

    const allConvs = Object.values(this.#conversations).filter(c => !c.error);
    const overall = {
      totalSent: sent.length,
      replied: allConvs.filter(c => c.repliesCount > 0).length,
      successHard: allConvs.filter(c => c.outcome === "success_hard").length,
      successSoft: allConvs.filter(c => c.outcome === "success_soft").length,
      interested: allConvs.filter(c => c.outcome === "interested").length,
      noReply: allConvs.filter(c => c.outcome === "no_reply").length,
      agreedToCall: allConvs.filter(c => c.agreedToCall).length,
      externalLinks: allConvs.filter(c => c.hasExternalLink).length,
      connectedCalls: allConvs.filter(c => c.hasConnectedCall).length,
      topReplies: this.#topReplies(allConvs),
    };

    return { overall, groupStats };
  }

  #statsForGroup(rows) {
    const convs = rows
      .map(r => this.#conversations[r.user])
      .filter(c => c && !c.error);

    return {
      sent: rows.length,
      withConvData: convs.length,
      replied: convs.filter(c => c.repliesCount > 0).length,
      successHard: convs.filter(c => c.outcome === "success_hard").length,
      successSoft: convs.filter(c => c.outcome === "success_soft").length,
      interested: convs.filter(c => c.outcome === "interested").length,
      agreedToCall: convs.filter(c => c.agreedToCall).length,
      topReplies: this.#topReplies(convs),
    };
  }

  #topReplies(convs, n = 10) {
    const freq = {};
    for (const conv of convs) {
      for (const reply of conv.replies ?? []) {
        const key = reply.trim().toLowerCase();
        if (key) freq[key] = (freq[key] ?? 0) + 1;
      }
    }
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([text, count]) => ({ text, count }));
  }
}

class ReportWriter {
  async writeCsv(data, csvPath) {
    const header = "Group,Sent,WithConvData,Replied,ReplyRate,SuccessHard,SuccessSoft,TotalSuccess,SuccessRate,Interested,AgreedToCall\n";
    const rows = Object.entries(data.groupStats)
      .sort(([a], [b]) => this.#sortKey(a) - this.#sortKey(b))
      .map(([group, s]) => {
        const totalSuccess = s.successHard + s.successSoft;
        const replyRate = s.sent > 0 ? `${((s.replied / s.sent) * 100).toFixed(1)}%` : "0%";
        const successRate = s.sent > 0 ? `${((totalSuccess / s.sent) * 100).toFixed(1)}%` : "0%";
        return [group, s.sent, s.withConvData, s.replied, replyRate, s.successHard, s.successSoft, totalSuccess, successRate, s.interested, s.agreedToCall]
          .map(csvEscape).join(",");
      });
    await writeFile(csvPath, header + rows.join("\n") + "\n", "utf8");
  }

  async writeHtml(data, htmlPath) {
    const { overall, groupStats } = data;
    const pct = (n, d) => d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—";
    const totalSuccess = overall.successHard + overall.successSoft;

    const sortedGroups = Object.entries(groupStats)
      .sort(([a], [b]) => this.#sortKey(a) - this.#sortKey(b));

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Analytics Report — ${new Date().toLocaleDateString()}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:980px;margin:40px auto;padding:0 20px;color:#1a1a1a}
  h1{font-size:1.5rem;margin-bottom:4px}
  .date{color:#888;font-size:.85rem;margin-bottom:32px}
  h2{font-size:.85rem;font-weight:700;margin-top:36px;margin-bottom:10px;color:#555;text-transform:uppercase;letter-spacing:.06em}
  table{border-collapse:collapse;width:100%;margin-bottom:20px}
  th,td{padding:8px 12px;border:1px solid #e5e5e5;text-align:left;font-size:.875rem}
  th{background:#f8f8f8;font-weight:600}
  tr:hover td{background:#fafafa}
  ol{margin:0 0 24px;padding-left:20px}
  ol li{padding:3px 0;font-size:.875rem}
  .muted{color:#999}
  .pill{display:inline-block;font-size:.75rem;padding:1px 7px;border-radius:99px;margin-left:4px;vertical-align:middle}
  .pill-green{background:#dcfce7;color:#15803d}
  .pill-yellow{background:#fef9c3;color:#92400e}
  .pill-blue{background:#dbeafe;color:#1d4ed8}
  .funnel{display:flex;gap:16px;margin-bottom:28px;flex-wrap:wrap}
  .funnel-step{flex:1;min-width:120px;border:1px solid #e5e5e5;border-radius:8px;padding:14px 16px}
  .funnel-step .val{font-size:1.6rem;font-weight:700;line-height:1.1}
  .funnel-step .label{font-size:.78rem;color:#666;margin-top:4px}
  .funnel-step .sub{font-size:.8rem;color:#999;margin-top:2px}
</style>
</head>
<body>
<h1>Campaign Analytics Report</h1>
<div class="date">Generated ${new Date().toLocaleString()}</div>

<h2>Overall Funnel</h2>
<div class="funnel">
  <div class="funnel-step">
    <div class="val">${overall.totalSent.toLocaleString()}</div>
    <div class="label">Total sent</div>
  </div>
  <div class="funnel-step">
    <div class="val">${overall.replied.toLocaleString()}</div>
    <div class="label">Replied</div>
    <div class="sub">${pct(overall.replied, overall.totalSent)} of sent</div>
  </div>
  <div class="funnel-step">
    <div class="val">${totalSuccess.toLocaleString()}</div>
    <div class="label">Total success</div>
    <div class="sub">${pct(totalSuccess, overall.totalSent)} of sent</div>
  </div>
  <div class="funnel-step">
    <div class="val">${overall.successHard}</div>
    <div class="label">Hard success <span class="pill pill-green">call / link</span></div>
    <div class="sub">${pct(overall.successHard, overall.totalSent)} of sent</div>
  </div>
  <div class="funnel-step">
    <div class="val">${overall.successSoft}</div>
    <div class="label">Soft success <span class="pill pill-yellow">referred</span></div>
    <div class="sub">${pct(overall.successSoft, overall.totalSent)} of sent</div>
  </div>
</div>

<h2>Additional Signals</h2>
<table>
<tr><th>Signal</th><th>Count</th><th>% of sent</th></tr>
<tr><td>Agreed to / scheduled a call</td><td>${overall.agreedToCall}</td><td>${pct(overall.agreedToCall, overall.totalSent)}</td></tr>
<tr><td>External link in conversation (Zoom / Telemost)</td><td>${overall.externalLinks}</td><td>${pct(overall.externalLinks, overall.totalSent)}</td></tr>
<tr><td>Connected Telegram call</td><td>${overall.connectedCalls}</td><td>${pct(overall.connectedCalls, overall.totalSent)}</td></tr>
<tr><td>Just interested (replied, no signal)</td><td>${overall.interested}</td><td>${pct(overall.interested, overall.totalSent)}</td></tr>
<tr><td>No reply</td><td>${overall.noReply}</td><td>${pct(overall.noReply, overall.totalSent)}</td></tr>
</table>

${overall.topReplies.length > 0 ? `
<h2>Top Replies — All Conversations</h2>
<ol>
${overall.topReplies.map(r => `<li>${htmlEscape(r.text)} <span class="muted">(${r.count}×)</span></li>`).join("\n")}
</ol>` : ""}

<h2>By Batch Size (Follow-up Messages)</h2>
<table>
<tr>
  <th>Batch</th><th>Sent</th><th>Conv. data</th>
  <th>Replied</th><th>Reply rate</th>
  <th>Hard success</th><th>Soft success</th><th>Total success</th><th>Success rate</th>
  <th>Interested</th><th>Agreed to call</th>
</tr>
${sortedGroups.map(([group, s]) => {
  const total = s.successHard + s.successSoft;
  return `
<tr>
  <td>${group === "unknown" ? '<span class="muted">unknown (historical)</span>' : `${group} msg`}</td>
  <td>${s.sent}</td><td>${s.withConvData}</td>
  <td>${s.replied}</td><td>${pct(s.replied, s.sent)}</td>
  <td>${s.successHard}</td><td>${s.successSoft}</td><td>${total}</td><td>${pct(total, s.sent)}</td>
  <td>${s.interested}</td><td>${s.agreedToCall}</td>
</tr>`;
}).join("\n")}
</table>

${sortedGroups.map(([group, s]) => s.topReplies.length === 0 ? "" : `
<h2>Top Replies — ${group === "unknown" ? "Unknown / Historical" : `${group}-message batch`}</h2>
<ol>
${s.topReplies.map(r => `<li>${htmlEscape(r.text)} <span class="muted">(${r.count}×)</span></li>`).join("\n")}
</ol>`).join("")}

</body>
</html>`;

    await writeFile(htmlPath, html, "utf8");
  }

  #sortKey(group) {
    if (group === "unknown") return Infinity;
    return Number(group) || 0;
  }
}

export async function runAnalyticsReport() {
  const parser = new ReportParser();
  const rows = await parser.parse(PATHS.REPORT_CSV);
  console.log(`Loaded ${rows.length} report rows.`);

  let conversations = {};
  try {
    const raw = await readFile(PATHS.CONVERSATIONS_JSON, "utf8");
    conversations = JSON.parse(raw);
    console.log(`Loaded ${Object.keys(conversations).length} conversation records.`);
  } catch {
    console.warn("conversations.json not found — run the collector first for full data.");
  }

  const builder = new ReportBuilder(rows, conversations);
  const data = builder.build();

  const writer = new ReportWriter();
  await writer.writeCsv(data, PATHS.ANALYTICS_CSV);
  await writer.writeHtml(data, PATHS.ANALYTICS_HTML);

  console.log(`CSV  → ${PATHS.ANALYTICS_CSV}`);
  console.log(`HTML → ${PATHS.ANALYTICS_HTML}`);
}

if (process.argv[1] && process.argv[1].endsWith("analytics-report.js")) {
  runAnalyticsReport().catch(err => { console.error(err); process.exit(1); });
}
