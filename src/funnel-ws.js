// Live funnel tracker — WebSocket server + dashboard.
//
// The funnel is three questions deep, so the thing you actually want to see is
// where each person stopped: how many got Q1, how many said да twice and then
// went quiet, who earned an invite. A CSV after the fact cannot tell you that
// while a run is live.
//
// This holds the board in memory, pushes every event to every connected browser
// over a WebSocket, and replays a snapshot on connect so a tab opened late is
// not blank. It is read-only: nothing a browser sends can make the sender write
// to Telegram.
import { createServer } from "node:http";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { WebSocketServer } from "ws";
import { QUESTIONS } from "./funnel.js";

const PORT = Number(process.env.RELEVANTY_FUNNEL_PORT ?? 8787);
// Loopback only. server.listen(port) with no host binds 0.0.0.0 *and* ::, which
// put every lead's handle and messages on the LAN — readable by anyone on the
// same wifi. Set RELEVANTY_FUNNEL_HOST to widen it deliberately, never by
// default.
const HOST = String(process.env.RELEVANTY_FUNNEL_HOST ?? "127.0.0.1");
const EVENT_LOG = path.resolve("reports", "funnel-events.jsonl");
const MAX_FEED = 300;

// A per-run token in the URL. Loopback binding alone does not make the port
// private: WebSockets are exempt from the same-origin policy, so any page open
// in the browser can dial ws://localhost:8787 and stream the feed. The token,
// the Origin check and the Host check below each close a different door.
const TOKEN = randomBytes(16).toString("hex");

const COOKIE = "rlv_funnel";
// A tab, a spare tab, and headroom. More than this on loopback is a runaway
// script, not a person.
const MAX_CLIENTS = 8;

function cookieOk(req) {
  const raw = String(req.headers.cookie ?? "");
  const hit = raw.split(";").map(c => c.trim()).find(c => c.startsWith(COOKIE + "="));
  return hit ? tokenOk(hit.slice(COOKIE.length + 1)) : false;
}

function tokenOk(given) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Reject a Host header pointing at anything but loopback. Without this a
// hostile site can rebind its own DNS name to 127.0.0.1 and reach the port with
// its own origin attached.
function hostOk(req) {
  const host = String(req.headers.host ?? "").toLowerCase();
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

// Same-origin only. A browser always sends Origin on a WebSocket handshake, so
// a missing one means a non-browser client (curl, a script) — allowed, since it
// still needs the token.
function originOk(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const okHost = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      || u.hostname === "::1";
    return okHost && u.port === String(port);
  } catch { return false; }
}

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Map<string, object>} handle → latest row */
const board = new Map();
/** @type {object[]} newest last, capped at MAX_FEED */
const feed = [];
/** @type {Set<import("ws").WebSocket>} */
const clients = new Set();
let server = null;
let wss = null;

function snapshot() {
  const rows = [...board.values()];
  const counts = { q1: 0, q2: 0, q3: 0, invited: 0, closed: 0, waiting: 0, answered: 0, handoff: 0, scored: 0, convictionSum: 0 };
  for (const r of rows) {
    if (r.step === "invite") counts.invited++;
    else if (r.step === "farewell") counts.closed++;
    else if (r.step === "wait") counts.waiting++;
    else if (r.step === "scenario") counts.answered++;
    else if (r.step === "handoff" || r.step === "human") counts.handoff++;
    const v = (typeof r.score === "number") ? r.score : (typeof r.conviction === "number" ? r.conviction : null);
    if (v != null) { counts.scored++; counts.convictionSum += v; }
    if (r.stage >= 1) counts.q1++;
    if (r.stage >= 2) counts.q2++;
    if (r.stage >= 3) counts.q3++;
  }
  counts.avgConviction = counts.scored ? Math.round((counts.convictionSum / counts.scored) * 10) / 10 : null;
  return {
    type: "snapshot",
    at: new Date().toISOString(),
    questions: QUESTIONS,
    counts,
    rows: rows.sort((a, b) => String(b.at).localeCompare(String(a.at))),
    feed: feed.slice(-MAX_FEED),
  };
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try { ws.send(msg); } catch { /* dropped client; close handler cleans up */ }
    }
  }
}

/**
 * Record one funnel event and push it to every dashboard.
 * Safe to call when no server is running — it still writes the JSONL log, so
 * a headless run keeps a full trace.
 *
 * @param {object} ev
 * @param {string} ev.handle
 * @param {string} ev.step     ask | invite | farewell | wait | done | skip | error
 * @param {number} [ev.stage]  which question they are on (0-3)
 * @param {string} [ev.answer] yes | no | other
 * @param {string} [ev.reason]
 * @param {string} [ev.inbound]
 * @param {string} [ev.outbound]
 * @param {boolean} [ev.sent]  false on a dry run
 */
export async function trackEvent(ev) {
  const row = { at: new Date().toISOString(), ...ev };
  board.set(row.handle, { ...board.get(row.handle), ...row });
  feed.push(row);
  if (feed.length > MAX_FEED) feed.splice(0, feed.length - MAX_FEED);

  broadcast({ type: "event", row, counts: snapshot().counts });

  try {
    await mkdir(path.dirname(EVENT_LOG), { recursive: true });
    await appendFile(EVENT_LOG, JSON.stringify(row) + "\n", "utf8");
  } catch { /* never let logging break a run */ }
}

/** Seed the board from the event log so a restarted dashboard is not empty. */
export async function loadHistory() {
  try {
    const raw = await readFile(EVENT_LOG, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.handle) board.set(row.handle, { ...board.get(row.handle), ...row });
      } catch { /* skip a torn line */ }
    }
  } catch { /* no log yet */ }
}

// ── Server ────────────────────────────────────────────────────────────────────

export async function startTracker({ port = PORT, host = HOST, open = false } = {}) {
  await loadHistory();

  const deny = (res, code, msg) => {
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(msg);
  };

  server = createServer((req, res) => {
    // No caching, no referrer, no framing — the page holds other people's
    // messages and should not leak through a cache or an iframe.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ws: http:");

    if (!hostOk(req)) return deny(res, 421, "Not loopback.\n");

    const url = new URL(req.url ?? "/", "http://localhost");
    const viaQuery = tokenOk(url.searchParams.get("t"));
    if (!viaQuery && !cookieOk(req)) {
      return deny(res, 403, "Missing or bad token. Open the URL printed by the runner.\n");
    }

    // Hand the token off to a cookie and bounce to a clean URL, so it stops
    // riding in query strings, where it lands in history, screenshots and any
    // proxy log. SameSite=Strict means a cross-site request — a WebSocket
    // handshake from another origin included — never carries it.
    if (viaQuery && url.pathname === "/") {
      res.setHeader("Set-Cookie",
        COOKIE + "=" + TOKEN + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400");
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    if (url.pathname === "/api/snapshot") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(snapshot()));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(DASHBOARD);
  });

  wss = new WebSocketServer({
    server,
    // The board only pushes; a client never needs to send anything, so cap the
    // inbound frame instead of letting a local process feed us unbounded memory.
    maxPayload: 1024,
    verifyClient: ({ req }, cb) => {
      if (!hostOk(req)) return cb(false, 421, "Not loopback");
      if (!originOk(req, port)) return cb(false, 403, "Bad origin");
      if (clients.size >= MAX_CLIENTS) return cb(false, 503, "Too many clients");
      const t = new URL(req.url ?? "/", "http://localhost").searchParams.get("t");
      if (!tokenOk(t) && !cookieOk(req)) return cb(false, 403, "Bad token");
      cb(true);
    },
  });
  wss.on("connection", (ws) => {
    clients.add(ws);
    try { ws.send(JSON.stringify(snapshot())); } catch { /* ignore */ }
    // Browsers drop an idle socket; a ping keeps proxies from closing it.
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (ws.isAlive === false) { ws.terminate(); clients.delete(ws); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30_000);
  heartbeat.unref();

  await new Promise((resolve, reject) => {
    server.listen(port, host, resolve);
    server.once("error", reject);
  });

  const url = `http://localhost:${port}/?t=${TOKEN}`;
  console.log(`  Funnel tracker → ${url}`);
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    console.log(`  ⚠ bound to ${host} — the board is reachable off this machine.`);
  }
  if (open) {
    // spawn with an argv, never exec with an interpolated string: the URL carries
    // a token and must not be re-parsed by a shell. On Windows the URL also has
    // to follow an empty "" title argument, or cmd's start treats the URL itself
    // as the window title and opens nothing.
    const { spawn } = await import("node:child_process");
    const [cmd, args] = process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  }
  return { url, port };
}

export async function stopTracker() {
  for (const ws of clients) { try { ws.close(); } catch { /* ignore */ } }
  clients.clear();
  await new Promise((resolve) => (wss ? wss.close(resolve) : resolve()));
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  wss = null;
  server = null;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

const DASHBOARD = `<!doctype html>
<html lang="ru"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relevanty — воронка</title>
<style>
  :root{--bg:#0d1117;--card:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;
        --yes:#3fb950;--no:#f85149;--wait:#d29922;--inv:#58a6ff}
  *{box-sizing:border-box}
  body{margin:0;padding:24px;background:var(--bg);color:var(--fg);
       font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif}
  h1{font-size:17px;margin:0 0 4px;font-weight:600}
  .sub{color:var(--dim);font-size:12px;margin-bottom:20px}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;
       background:var(--no)}
  .dot.on{background:var(--yes)}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
  .card b{display:block;font-size:24px;font-weight:600;line-height:1.2}
  .card span{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  .wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
  table{border-collapse:collapse;width:100%;min-width:660px}
  th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em;font-weight:500}
  tr:last-child td{border-bottom:none}
  .pill{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;border:1px solid}
  .yes{color:var(--yes);border-color:var(--yes)}
  .no{color:var(--no);border-color:var(--no)}
  .other{color:var(--wait);border-color:var(--wait)}
  .invite{color:var(--inv);border-color:var(--inv)}
  .q{font-variant-numeric:tabular-nums;color:var(--dim)}
  .msg{color:var(--dim);max-width:40ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dry{font-size:10px;color:var(--wait);border:1px solid var(--wait);border-radius:4px;padding:0 4px}
  a{color:var(--inv);text-decoration:none}
  @media (max-width:520px){body{padding:14px}}
</style></head><body>
<h1>Воронка — три вопроса</h1>
<div class="sub"><span class="dot" id="dot"></span><span id="status">подключаюсь…</span></div>
<div class="cards" id="cards"></div>
<div class="wrap"><table>
  <thead><tr><th>Кто</th><th>Этап</th><th>Уверенность</th><th>Ответ</th><th>Последнее сообщение</th><th>Наш шаг</th><th>Когда</th></tr></thead>
  <tbody id="rows"></tbody>
</table></div>
<script>
(function(){
  var rows = [], counts = {};
  var esc = function(s){ return String(s==null?"":s).replace(/[&<>"]/g, function(c){
    return ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"})[c]; }); };

  function label(r){
    if (r.step === "invite") return '<span class="pill invite">инвайт</span>';
    if (r.step === "farewell") return '<span class="pill no">закрыт</span>';
    if (r.step === "ask") return '<span class="pill yes">вопрос '+(r.stage||"")+'</span>';
    if (r.step === "wait") return '<span class="pill other">ждём</span>';
    if (r.step === "scenario") return '<span class="pill">ответ: '+esc(r.branch||"")+'</span>';
    if (r.step === "handoff") return '<span class="pill invite">передать человеку</span>';
    if (r.step === "human") return '<span class="pill no">нужен человек</span>';
    return '<span class="pill other">'+esc(r.step)+'</span>';
  }
  function conviction(r){
    var v = (r.score != null) ? r.score : r.conviction;
    if (v == null) return '<span class="q">—</span>';
    var cls = v >= 7 ? "yes" : v >= 5 ? "" : v >= 3 ? "other" : "no";
    var bar = "█".repeat(Math.max(1, Math.round(v / 2)));
    return '<span class="pill ' + cls + '">' + v + '/10</span> <span class="q">' + bar + '</span>';
  }
  function answer(r){
    if (!r.answer) return "";
    var cls = r.answer === "yes" ? "yes" : r.answer === "no" ? "no" : "other";
    return '<span class="pill '+cls+'">'+esc(r.answer)+'</span> <span class="q">'+esc(r.reason||"")+'</span>';
  }
  function render(){
    var c = counts || {};
    document.getElementById("cards").innerHTML = [
      ["получили вопрос 1", c.q1||0], ["дошли до 2", c.q2||0], ["дошли до 3", c.q3||0],
      ["инвайты", c.invited||0], ["закрыто", c.closed||0], ["ждём ответа", c.waiting||0],
      ["ответов по скрипту", c.answered||0], ["нужен человек", c.handoff||0],
      ["ср. уверенность", (c.avgConviction==null?"—":c.avgConviction+"/10")]
    ].map(function(p){ return '<div class="card"><b>'+p[1]+'</b><span>'+p[0]+'</span></div>'; }).join("");

    document.getElementById("rows").innerHTML = rows.map(function(r){
      var who = String(r.handle||"");
      var link = who.charAt(0) === "@"
        ? '<a href="https://t.me/'+esc(who.slice(1))+'" target="_blank" rel="noopener">'+esc(who)+'</a>'
        : esc(who);
      return "<tr><td>"+link+(r.sent === false ? ' <span class="dry">dry</span>' : "")+"</td>"
        + "<td class='q'>"+(r.stage||0)+"/3</td>"
        + "<td>"+conviction(r)+"</td>"
        + "<td>"+answer(r)+"</td>"
        + '<td class="msg" title="'+esc(r.inbound||"")+'">'+esc(r.inbound||"")+"</td>"
        + "<td>"+label(r)+"</td>"
        + '<td class="q">'+esc(String(r.at||"").slice(11,19))+"</td></tr>";
    }).join("") || '<tr><td colspan="7" class="q">пока пусто</td></tr>';
  }
  function upsert(row){
    var i = rows.findIndex(function(r){ return r.handle === row.handle; });
    if (i >= 0) rows[i] = Object.assign({}, rows[i], row); else rows.unshift(row);
    rows.sort(function(a,b){ return String(b.at).localeCompare(String(a.at)); });
  }
  function connect(){
    // Same token the page was opened with — the handshake is rejected without it.
    // The bootstrap redirect left the token in an HttpOnly cookie, which the
    // handshake sends on its own; the query fallback covers a URL still carrying
    // the token.
    var t = new URLSearchParams(location.search).get("t");
    var ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://")
      + location.host + (t ? "/?t=" + encodeURIComponent(t) : "/"));
    ws.onopen = function(){
      document.getElementById("dot").className = "dot on";
      document.getElementById("status").textContent = "в эфире";
    };
    ws.onmessage = function(e){
      var m = JSON.parse(e.data);
      if (m.type === "snapshot"){ rows = m.rows || []; counts = m.counts || {}; }
      else if (m.type === "event"){ upsert(m.row); counts = m.counts || counts; }
      render();
    };
    ws.onclose = function(){
      document.getElementById("dot").className = "dot";
      document.getElementById("status").textContent = "соединение потеряно — переподключаюсь…";
      setTimeout(connect, 2000);
    };
    ws.onerror = function(){ try { ws.close(); } catch(_){} };
  }
  render();
  connect();
})();
</script>
</body></html>`;
