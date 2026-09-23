// Profile-photo flood. Given a seed Pinterest URL, harvest real pin images from
// Pinterest (server-rendered pages embed many i.pinimg.com URLs) and crawl the
// related-pin graph breadth-first for more, then upload each as the account's
// Telegram profile photo (non-destructive: Telegram keeps prior photos in the
// account's photo history, the last uploaded becomes the current avatar).
//
// All images come from Pinterest — there is no synthetic fallback. If Pinterest
// yields fewer than requested (blocked/thin board), we upload what we found and
// report the shortfall honestly.
import fs from "node:fs";
import path from "node:path";

import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";

import { startClient, validateEnv } from "./auth.js";
import { sleep } from "./utils.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Optional Pinterest login, supplied as a browser session cookie (never a
// password). Logged-out Pinterest server-renders nothing for /search/ and caps
// related pins, so search seeds and thin pins need auth. Board and /pin/ seeds
// work fine without it. Source order: PINTEREST_COOKIE env → storage/pinterest.json
// ({ "cookie": "..." } or { "csrftoken": "...", "sess": "..." }). Cached once per
// process; the tool is started fresh per run so a refreshed cookie is picked up.
let _pinCookie;
export function pinterestCookie() {
  if (_pinCookie !== undefined) return _pinCookie;
  const env = (process.env.PINTEREST_COOKIE || "").trim();
  if (env) return (_pinCookie = env);
  try {
    const j = JSON.parse(fs.readFileSync(path.resolve("storage", "pinterest.json"), "utf8"));
    if (j.cookie) return (_pinCookie = String(j.cookie).trim());
    if (j.csrftoken && j.sess) return (_pinCookie = `csrftoken=${j.csrftoken}; _pinterest_sess=${j.sess}`);
  } catch {
    /* no cookie configured — logged-out mode */
  }
  return (_pinCookie = "");
}

// ── HTML extraction (pure — unit-testable without network) ────────────────────
export function extractOgImage(html) {
  const m =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

export function extractPinIds(html) {
  const ids = new Set();
  const re = /\/pin\/(\d+)\//g;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return [...ids];
}

// Full-grid expansion sources referenced by a page, most on-theme first. A bare
// /pin/ page server-renders only ~3 preview images and its "related pins" are
// capped/empty when logged out — a dead end. But every pin names the board it
// lives on, and board pages SSR dozens of thematically-coherent pins even logged
// out. So we expand through the pin's own board first (same theme as the seed),
// then Pinterest /ideas/ topic feeds (related interests), then any other
// user/board paths — each a whole grid, not a single image or random rec.
export function extractExpansionUrls(html) {
  const urls = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw) return;
    const path = raw.replace(/\\\//g, "/").replace(/^https?:\/\/[a-z]+\.pinterest\.com/i, "");
    if (!/^\/[^/]+\/[^/]+\/?$|^\/ideas\//.test(path) || seen.has(path)) return;
    seen.add(path);
    urls.push("https://www.pinterest.com" + path);
  };
  // The pin's own board — the single most on-theme source. Take it first.
  const board = html.match(/"board"\s*:\s*\{[^{}]*?"url"\s*:\s*"(\\?\/[^"']+?\\?\/)"/);
  if (board) push(board[1]);
  // Pinterest topic / idea feeds referenced on the page (related interests).
  for (const mm of html.matchAll(/"(\\?\/ideas\/[^"']+?\/\d+\\?\/)"/g)) push(mm[1]);
  // Any remaining /<user>/<board>/ paths, as a last resort for more of the theme.
  for (const mm of html.matchAll(/"url"\s*:\s*"(\\?\/[A-Za-z0-9_][\w-]*\\?\/[\w-]+\\?\/)"/g)) push(mm[1]);
  return urls;
}

// Every real pin image embedded in a Pinterest page. Pinterest SSRs a JSON blob
// full of i.pinimg.com URLs (often escaped as \/); we normalize the escaping,
// keep only true pin images (path = <size>/hh/hh/hh/<hash>.<ext>), upgrade each
// to the widely-available 736x variant, and dedupe by image path so the same
// picture at different sizes counts once.
//
// Content pins are served from width-only size buckets (236x, 474x, 736x, 1200x,
// …) or `originals`. Everything else that shares the same path shape — author
// avatars (…_RS, 60x60, 136x136), board covers (200x150) and share cards
// (600x315) — uses a fixed WxH bucket. We accept only the width-only/`originals`
// buckets, so chrome can't leak in as a profile photo even on pin-detail or
// search pages where an avatar's hash never co-occurs with a real pin size.
export function extractPinImages(html) {
  const text = String(html)
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
  const raw = text.match(/https:\/\/i\.pinimg\.com\/[^"'\s)\\]+?\.(?:jpg|jpeg|png)/gi) || [];
  const byPath = new Map();
  for (const url of raw) {
    const m = url.match(/i\.pinimg\.com\/([^/]+)\/((?:[0-9a-f]{2}\/){2,4}[0-9a-f]{6,}\.(?:jpg|jpeg|png))/i);
    if (!m) continue;
    const size = m[1].toLowerCase();
    const pathKey = m[2].toLowerCase();
    if (size !== "originals" && !/^\d+x$/.test(size)) continue;
    if (!byPath.has(pathKey)) byPath.set(pathKey, `https://i.pinimg.com/736x/${pathKey}`);
  }
  return [...byPath.values()];
}

// ── Network helpers ───────────────────────────────────────────────────────────
// i.pinimg.com hotlink-protects some assets, so every request carries a
// pinterest.com Referer and an image Accept header — without them the CDN
// intermittently answers 403.
async function fetchText(url) {
  const cookie = pinterestCookie();
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.pinterest.com/",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Not every pin has a 736x rendition — small or oddly-shaped uploads exist only
// at `originals` or a smaller thumb, so a hard-coded 736x URL 403/404s and the
// pin is lost. Given any i.pinimg URL, try a chain of size buckets (best sane
// resolution first, `originals` last as the always-present source) and return
// the first that actually delivers image bytes.
const DL_SIZES = ["736x", "1200x", "564x", "474x", "236x", "originals"];

function sizeCandidates(url) {
  const m = url.match(/(https:\/\/i\.pinimg\.com\/)[^/]+\/(.+)$/i);
  if (!m) return [url];
  const seen = new Set();
  const urls = [];
  for (const size of DL_SIZES) {
    const u = `${m[1]}${size}/${m[2]}`;
    if (!seen.has(u)) { seen.add(u); urls.push(u); }
  }
  return urls;
}

async function downloadImage(url) {
  let lastErr = "no candidates";
  for (const candidate of sizeCandidates(url)) {
    try {
      const res = await fetch(candidate, {
        headers: {
          "User-Agent": UA,
          Referer: "https://www.pinterest.com/",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
      });
      if (!res.ok) { lastErr = `HTTP ${res.status}`; continue; }
      const type = res.headers.get("content-type") || "";
      if (!type.startsWith("image/")) { lastErr = `not an image (${type || "unknown"})`; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) { lastErr = "empty image"; continue; }
      return { buf, ext: type.includes("png") ? "png" : "jpg" };
    } catch (err) {
      lastErr = err?.message || String(err);
    }
  }
  throw new Error(lastErr);
}

// ── Authenticated feed pagination ("scroll") ──────────────────────────────────
// Logged-in Pinterest server-renders only a thin first page (a board shows ~13
// pins, a pin shows ~1) and streams the rest through its feed resource API as you
// scroll, one bookmark-cursor page at a time. To reach counts beyond that first
// page we drive that same API directly: call the matching resource with the last
// bookmark, collect its pins, follow the returned bookmark, and repeat until we
// have `count` images or the feed ends. Needs a session cookie (pinterestCookie).
function csrfFromCookie(cookie) {
  return (cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
}

async function pinResource(name, options, sourceUrl) {
  const cookie = pinterestCookie();
  const data = encodeURIComponent(JSON.stringify({ options, context: {} }));
  const url =
    `https://www.pinterest.com/resource/${name}/get/` +
    `?source_url=${encodeURIComponent(sourceUrl)}&data=${data}&_=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/javascript, */*, q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRFToken": csrfFromCookie(cookie),
      "X-Pinterest-AppState": "active",
      "X-Pinterest-PWS-Handler": "www/[username]/[slug].js",
      Referer: "https://www.pinterest.com" + sourceUrl,
      Cookie: cookie,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// The board id is embedded in the board/pin page as node_id = base64("Board:<id>").
function decodeBoardId(html) {
  for (const m of html.matchAll(/"node_id"\s*:\s*"([A-Za-z0-9+/=]+)"/g)) {
    try {
      const dec = Buffer.from(m[1], "base64").toString("utf8");
      const mm = dec.match(/^Board:(\d+)$/);
      if (mm) return mm[1];
    } catch { /* not base64 */ }
  }
  const b = html.match(/"board"\s*:\s*\{[^{}]*?"id"\s*:\s*"(\d+)"/);
  return b ? b[1] : null;
}

// Resolve a seed URL to the feed resource that pages it. Search pages by query;
// boards and pins page through the board's own grid (on-theme with the seed).
async function resolveFeed(seedUrl) {
  let u;
  try { u = new URL(seedUrl); } catch { return null; }
  const p = u.pathname;

  if (/^\/search\//.test(p)) {
    const query = u.searchParams.get("q") || "";
    if (!query) return null;
    return {
      name: "BaseSearchResource",
      sourceUrl: `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`,
      options: {
        applied_unified_filters: null, appliedProductFilters: "---", article: null,
        auto_correction_disabled: false, corpus: null, customized_rerank_type: null,
        filters: null, query, redux_normalize_feed: true, rs: "typed", scope: "pins",
        source_id: null, source_module_id: null, page_size: 25,
      },
    };
  }

  // Board or pin: fetch the page (authed) to get the board id + canonical board url.
  let html;
  try { html = await fetchText(seedUrl); } catch { return null; }
  const boardId = decodeBoardId(html);
  let boardUrl = (extractExpansionUrls(html)[0] || "").replace(/^https?:\/\/[a-z]+\.pinterest\.com/i, "");
  const boardMatch = p.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (!boardUrl && boardMatch && !["pin", "search", "ideas"].includes(boardMatch[1])) {
    boardUrl = p.endsWith("/") ? p : p + "/";
  }
  if (!boardId || !boardUrl) return null;
  return {
    name: "BoardFeedResource",
    sourceUrl: boardUrl,
    options: {
      board_id: boardId, board_url: boardUrl, field_set_key: "react_grid_pin",
      filter_section_pins: true, sort: "default", layout: "default",
      page_size: 25, redux_normalize_feed: true,
    },
  };
}

// ── Pinterest crawl ───────────────────────────────────────────────────────────
// Gather up to `count` distinct pin images for a seed. When a session cookie is
// present we page the feed resource API ("scroll") until we hit the count; that
// covers search seeds and lets boards/pins go well past their thin first page.
// With no cookie (or if the API path comes up short) we fall back to harvesting
// the server-rendered HTML page and expanding through its board/topic links —
// which still works logged-out for board and pin seeds.
export async function crawlPinterest(seedUrl, count, onLog = () => {}) {
  const images = [];
  const seenImg = new Set();
  const seenPage = new Set();
  const gridQueue = []; // board / topic pages — many images each (fetched first)
  const pinQueue = []; // individual /pin/ pages — a few images each (fallback)

  const take = (found) => {
    for (const img of found) {
      if (images.length >= count) break;
      if (!seenImg.has(img)) {
        seenImg.add(img);
        images.push(img);
      }
    }
  };

  // 1) Authenticated, paginated feed — keeps pulling pages until count is reached.
  if (pinterestCookie()) {
    try {
      const feed = await resolveFeed(seedUrl);
      if (feed) {
        let bookmark = null;
        let page = 0;
        const maxFeedPages = Math.min(Math.ceil(count / 10) + 4, 30);
        while (images.length < count && page < maxFeedPages) {
          const text = await pinResource(
            feed.name,
            { ...feed.options, bookmarks: bookmark ? [bookmark] : [] },
            feed.sourceUrl,
          );
          take(extractPinImages(text));
          page += 1;
          onLog(`found ${images.length}/${count}`);
          let next = null;
          try { next = JSON.parse(text)?.resource_response?.bookmark ?? null; } catch { /* keep null */ }
          if (!next || next === "-end-") break;
          bookmark = next;
          await sleep(350);
        }
      }
    } catch (err) {
      onLog(`feed api unavailable (${err.message}) — falling back to page crawl`);
    }
  }
  if (images.length >= count) return images.slice(0, count);

  // 2) HTML page harvest + board/topic expansion (works logged-out too).
  const harvest = (html) => {
    let found = extractPinImages(html);
    if (found.length === 0) {
      const og = extractOgImage(html);
      if (og) found = [og];
    }
    take(found);
    if (images.length < count) {
      for (const url of extractExpansionUrls(html)) if (!seenPage.has(url)) gridQueue.push(url);
      for (const id of extractPinIds(html)) {
        const url = `https://www.pinterest.com/pin/${id}/`;
        if (!seenPage.has(url)) pinQueue.push(url);
      }
    }
    onLog(`found ${images.length}/${count}`);
  };

  try {
    seenPage.add(seedUrl);
    harvest(await fetchText(seedUrl));
  } catch (err) {
    onLog(`seed fetch failed: ${err.message}`);
  }

  const maxPages = Math.min(count * 4, 120);
  let pages = 0;
  while ((gridQueue.length || pinQueue.length) && images.length < count && pages < maxPages) {
    const url = gridQueue.shift() || pinQueue.shift(); // whole grids before single pins
    if (seenPage.has(url)) continue;
    seenPage.add(url);
    pages += 1;
    try {
      harvest(await fetchText(url));
    } catch (err) {
      onLog(`page failed: ${err.message}`);
    }
    await sleep(350); // be polite / reduce block risk
  }

  return images.slice(0, count);
}

// ── Client connection ─────────────────────────────────────────────────────────
// Connect as a specific account, through its own proxy, so any profile-photo
// change comes from the same IP the account normally uses. The caller's active
// SESSION_STRING / SOCKS_PROXY env vars are restored right after connect — the
// returned client keeps its own session/transport afterwards. Shared by every
// per-account profile-photo action.
async function connectAs({ session, proxy }) {
  const { apiId, apiHash, forceSms, authMethod } = validateEnv();
  const prevSession = process.env.SESSION_STRING;
  const prevProxy = process.env.SOCKS_PROXY;
  if (session) process.env.SESSION_STRING = session;
  if (proxy) process.env.SOCKS_PROXY = proxy;
  try {
    return await startClient(apiId, apiHash, forceSms, authMethod);
  } finally {
    process.env.SESSION_STRING = prevSession;
    if (prevProxy === undefined) delete process.env.SOCKS_PROXY;
    else process.env.SOCKS_PROXY = prevProxy;
  }
}

// ── Main entry ────────────────────────────────────────────────────────────────
// Starts a client for `session` (restoring the caller's active session right
// after connect, like the parser account-picker), gathers images, and uploads
// them one by one. Returns the number of photos actually set.
export async function floodProfilePhotos({ session, proxy, seedUrl, count, onProgress = () => {} }) {
  const client = await connectAs({ session, proxy });

  try {
    onProgress({ type: "log", message: "harvesting images from Pinterest…" });
    const urls = await crawlPinterest(seedUrl, count, (m) => onProgress({ type: "log", message: m }));

    if (urls.length === 0) {
      throw new Error("Pinterest returned no images (blocked, empty, or bad link). Try a different board/pin URL.");
    }
    if (urls.length < count) {
      onProgress({ type: "log", message: `Pinterest yielded ${urls.length}/${count} images — uploading those.` });
    }

    let uploaded = 0;
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      let attempt = 0;
      while (attempt < 2) {
        try {
          const { buf, ext } = await downloadImage(url);
          const toUpload = new CustomFile(`pfp_${uploaded + 1}.${ext}`, buf.length, "", buf);
          const file = await client.uploadFile({ file: toUpload, workers: 1 });
          await client.invoke(new Api.photos.UploadProfilePhoto({ file }));
          uploaded += 1;
          onProgress({ type: "uploaded", index: uploaded, total: urls.length });
          await sleep(1500); // spacing to avoid tripping Telegram's rate limits
          break;
        } catch (err) {
          const msg = err?.errorMessage || err?.message || String(err);
          const flood = /FLOOD_WAIT_(\d+)/.exec(msg);
          if (flood && attempt === 0) {
            const secs = Number(flood[1]) + 1;
            onProgress({ type: "log", message: `FLOOD_WAIT — waiting ${secs}s` });
            await sleep(secs * 1000);
            attempt += 1;
            continue;
          }
          onProgress({ type: "error", message: msg });
          break;
        }
      }
    }
    return uploaded;
  } finally {
    await client.disconnect().catch(() => {});
  }
}

// Remove every profile photo on the account. Telegram exposes a profile's photos
// as a paginated history (photos.getUserPhotos); we page through it, delete each
// batch with photos.deletePhotos, and repeat until none remain. This wipes the
// whole history including the current avatar, leaving the account with no profile
// photo. deletePhotos returns the ids it actually removed — if a batch deletes
// nothing we stop rather than loop forever. Returns the number of photos removed.
export async function clearProfilePhotos({ session, proxy, onProgress = () => {} }) {
  const client = await connectAs({ session, proxy });
  try {
    let removed = 0;
    while (true) {
      const res = await client.invoke(
        new Api.photos.GetUserPhotos({ userId: "me", offset: 0, maxId: 0, limit: 100 }),
      );
      const photos = res?.photos || [];
      if (photos.length === 0) break;

      const inputs = photos.map(
        (p) => new Api.InputPhoto({ id: p.id, accessHash: p.accessHash, fileReference: p.fileReference }),
      );

      let deleted;
      try {
        deleted = await client.invoke(new Api.photos.DeletePhotos({ id: inputs }));
      } catch (err) {
        const msg = err?.errorMessage || err?.message || String(err);
        const flood = /FLOOD_WAIT_(\d+)/.exec(msg);
        if (flood) {
          const secs = Number(flood[1]) + 1;
          onProgress({ type: "log", message: `FLOOD_WAIT — waiting ${secs}s` });
          await sleep(secs * 1000);
          continue; // retry the same batch
        }
        throw err;
      }

      const n = Array.isArray(deleted) ? deleted.length : inputs.length;
      if (n === 0) break; // nothing in this batch was deletable — avoid an infinite loop
      removed += n;
      onProgress({ type: "removed", count: removed });
      await sleep(800); // spacing to stay under Telegram's rate limits
    }
    return removed;
  } finally {
    await client.disconnect().catch(() => {});
  }
}
