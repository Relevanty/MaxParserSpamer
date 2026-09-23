import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { PATHS, DISCORD_CONFIG } from "./config.js";

const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";

export async function runDiscordParser() {
  const token = process.env.DISCORD_USER_TOKEN?.trim();
  if (!token) {
    console.error("[Discord Parser] DISCORD_USER_TOKEN is not set in .env");
    process.exit(1);
  }

  const guildId = (process.env.DISCORD_GUILD_ID || DISCORD_CONFIG.GUILD_ID || "").trim();
  if (!guildId) {
    console.error("[Discord Parser] DISCORD_GUILD_ID is not set in .env or config.js");
    process.exit(1);
  }

  console.log(`[Discord Parser] Connecting to gateway for guild ${guildId}...`);

  const members = await new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY);
    let heartbeatInterval = null;
    let sequence = null;
    let settleTimer = null;
    let memberCount = 0;
    let allTextChannels = [];   // all text channels to try
    let channelIndex = 0;       // which channel we're currently subscribing to
    let nextRangeStart = 0;
    const collected = new Map();

    function send(payload) {
      ws.send(JSON.stringify(payload));
    }

    function subscribeRange(channelId, start) {
      send({
        op: 14,
        d: {
          guild_id: guildId,
          channels: { [channelId]: [[start, start + 99]] },
        },
      });
    }

    function tryNextChannel() {
      channelIndex++;
      if (channelIndex >= allTextChannels.length) {
        console.log(`[Discord Parser] Exhausted all channels — resolving with ${collected.size}`);
        clearInterval(heartbeatInterval);
        clearTimeout(settleTimer);
        ws.close(1000);
        resolve([...collected.keys()]);
        return;
      }
      nextRangeStart = 0;
      const ch = allTextChannels[channelIndex];
      console.log(`[Discord Parser] Trying channel ${ch.id} (${ch.name ?? "unknown"})...`);
      subscribeRange(ch.id, 0);
      resetSettle();
    }

    function resetSettle() {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (collected.size >= memberCount && memberCount > 0) {
          clearInterval(heartbeatInterval);
          ws.close(1000);
          resolve([...collected.keys()]);
        } else {
          console.log(`[Discord Parser] ${collected.size}/${memberCount} — no new members, trying next channel...`);
          tryNextChannel();
        }
      }, 3000);
    }

    ws.addEventListener("open", () => console.log("[Discord Parser] Connected"));

    ws.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      const { op, t, d, s } = payload;
      if (s) sequence = s;

      if (op === 9) {
        clearInterval(heartbeatInterval);
        clearTimeout(settleTimer);
        ws.close();
        reject(new Error("Invalid Session — token rejected"));
        return;
      }

      if (op === 10) {
        heartbeatInterval = setInterval(() => send({ op: 1, d: sequence }), d.heartbeat_interval);

        send({
          op: 2,
          d: {
            token,
            capabilities: 16381,
            properties: {
              os: "Windows",
              browser: "Chrome",
              device: "",
              system_locale: "en-US",
              browser_user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              browser_version: "124.0.0.0",
              os_version: "10",
              referrer: "",
              referring_domain: "",
              release_channel: "stable",
              client_build_number: 9999,
              client_event_source: null,
            },
            presence: { status: "online", activities: [], afk: false, since: 0 },
            compress: false,
          },
        });
      }

      if (t === "READY") {
        console.log("[Discord Parser] Authenticated");
        const guild = (d.guilds ?? []).find((g) => g.id === guildId);

        // Fast path: full member list in READY (small servers)
        if (guild?.members?.length) {
          const ids = guild.members.filter((m) => !m.user?.bot).map((m) => m.user.id);
          console.log(`[Discord Parser] Got ${ids.length} members from READY`);
          clearInterval(heartbeatInterval);
          clearTimeout(settleTimer);
          ws.close(1000);
          resolve(ids);
          return;
        }

        // Collect all text channels sorted by position, try each one
        allTextChannels = (guild?.channels ?? [])
          .filter((c) => c.type === 0)
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

        if (!allTextChannels.length) {
          reject(new Error("No text channels found in guild"));
          return;
        }

        console.log(`[Discord Parser] Found ${allTextChannels.length} text channels to try`);
        subscribeRange(allTextChannels[0].id, 0);
        resetSettle();
      }

      if (t === "GUILD_MEMBER_LIST_UPDATE" && d.guild_id === guildId) {
        if (d.member_count) memberCount = d.member_count;

        const prevSize = collected.size;
        for (const op of d.ops ?? []) {
          for (const item of op.items ?? []) {
            const m = item.member;
            if (m && !m.user?.bot) collected.set(m.user.id, m.user.username);
          }
        }

        console.log(`[Discord Parser] ${collected.size}/${memberCount} members collected`);

        if (collected.size >= memberCount) {
          clearTimeout(settleTimer);
          clearInterval(heartbeatInterval);
          ws.close(1000);
          resolve([...collected.keys()]);
          return;
        }

        if (collected.size > prevSize) {
          // Got new members from this channel — request next range
          nextRangeStart += 100;
          subscribeRange(allTextChannels[channelIndex].id, nextRangeStart);
        }

        resetSettle();
      }
    });

    ws.addEventListener("close", (event) => {
      clearInterval(heartbeatInterval);
      clearTimeout(settleTimer);
      if (event.code !== 1000) {
        reject(new Error(`Gateway closed: ${event.code} ${event.reason}`));
      }
    });

    ws.addEventListener("error", (err) => {
      clearInterval(heartbeatInterval);
      clearTimeout(settleTimer);
      reject(new Error(`WebSocket error: ${err.message}`));
    });

    setTimeout(() => {
      clearInterval(heartbeatInterval);
      clearTimeout(settleTimer);
      ws.close();
      if (collected.size > 0) {
        console.log(`[Discord Parser] Hard timeout — saving ${collected.size} members`);
        resolve([...collected.keys()]);
      } else {
        reject(new Error("Timed out with no members collected"));
      }
    }, 60000);
  });

  if (!members.length) {
    console.log("[Discord Parser] No members returned");
    return;
  }

  await mkdir(path.dirname(PATHS.DISCORD_USERS_LIST), { recursive: true });
  await writeFile(
    PATHS.DISCORD_USERS_LIST,
    ["# Auto-parsed Discord user IDs. Lines starting with # are ignored.", ...members].join("\n") + "\n",
    "utf8"
  );

  console.log(`[Discord Parser] Saved ${members.length} user IDs to ${PATHS.DISCORD_USERS_LIST}`);
}
