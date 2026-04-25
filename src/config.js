import path from "node:path";

export const PATHS = {
  LISTS_DIR: path.resolve("lists"),
  MESSAGES_DIR: path.resolve("messages"),
  REPORT_CSV: path.resolve("report.csv"),
  PROCESSED_USERS_JSON: path.resolve("storage", "processed-users.json"),
  PROGRESS_STATE_JSON: path.resolve("storage", "progress-state.json"),
  SCHEDULED_QUEUE_JSON: path.resolve("storage", "scheduled-queue.json"),
  DISCORD_PROCESSED_USERS_JSON: path.resolve("storage", "discord-processed-users.json"),
  DISCORD_USERS_LIST: path.resolve("lists", "discord-users.txt"),
  CONVERSATIONS_JSON: path.resolve("storage", "conversations.json"),
  ANALYTICS_CSV: path.resolve("analytics-report.csv"),
  ANALYTICS_HTML: path.resolve("analytics-report.html"),
};

export const DISCORD_CONFIG = {
  // Guild (server) ID — can also be set via DISCORD_GUILD_ID in .env
  GUILD_ID: "",
  // File in messages/ dir to send
  MESSAGE_FILE: "1.txt",
  // Delay between each DM in milliseconds (keep >= 1500 to avoid rate limits)
  INTER_USER_DELAY_MS: 2000,
  // Maximum number of people to DM in one run
  MAX_RECIPIENTS: 5,
};

export const MESSAGE_CONFIG = {
    SEND_INTRO_TEXT: false,
    SEND_TEXT_FILES: true,
    RANDOMIZE_SINGLE_TEXT: true,
    // Add files here when you create more variants.
    // Example: ["1.txt", "2.txt", "3.txt"].
    // TEXT_FILE_NAMES: ["1.txt", "2.txt", "3.txt", "4.txt", "5.txt"],
    TEXT_FILE_NAMES: ["test.txt"],
    INTRO_TEXT: `Здаров. Чего не на встрече? Для вас же стараемся )`,
};

export const SAVED_MESSAGES_CONFIG = {
  // You may specify a fixed count (N) or a dash-separated list of counts
  // (intervals). When intervals are provided, the script will choose one of the
  // values **at random** for each recipient. To further vary the payload,
  // messages are picked from a random offset rather than always the very last
  // ones, so repeating the same interval often still results in different
  // content. Examples:
  //   N: 3             // always send last 3 messages
  //   INTERVALS: "1-3-2-1" // pick 1, 3, 2 or 1 messages randomly each time
  //
  // If both N and INTERVALS are present, INTERVALS takes precedence.
  // You can override at runtime with environment variables:
  //   SAVED_MESSAGES_N or SAVED_MESSAGES_INTERVALS.
  N: 1,
  INTERVALS: "2-1-2",
};

export const STICKER_CONFIG = {
  ENABLED: false, // sticker is now handled via Saved Messages forwarding
};

export const RATE_LIMITS = {
  INTER_MESSAGE_DELAY_MS: 3000,
  INTER_USER_DELAY_MS: 60000,
  USERS_PER_BATCH: 20,
  BATCH_SLEEP_MS: 30 * 60 * 1000,
};

export const FLOOD_GUARD = {
    CHECK_SPAM_BOT_STATUS: true,
    SPAM_BOT_USERNAME: "@SpamBot",
    INITIAL_WAIT_MS: 2500,
    POLL_INTERVAL_MS: 1500,
    POLL_ATTEMPTS: 4,
    CHECK_INTERVAL_USERS: 5, // <-- добавьте эту строку
    BAN_WAIT_MS: 40 * 60 * 1000, // 40 minutes in milliseconds
};

export const LOG_MODE = "Instant";

export const SCHEDULER_CONFIG = {
  // Peak Moscow hours (24h) to schedule messages for (MSK, UTC+3).
  // Provide an array of hours in local MSK time. Example: [18,20,22]
  // Default peaks: morning, midday, evening (MSK)
  PEAK_HOURS_MSK: [9, 13, 20],
  PEAK_MINUTE: 0,
  // Add random jitter in minutes (+/- this value) to avoid exact-same-time bursts
  PEAK_JITTER_MINUTES: 30,
  // When a sequence contains multiple messages, wait a random gap between each
  // message in milliseconds (min and max)
  INTER_MESSAGE_GAP_MS_MIN: 30 * 1000, // 30s
  INTER_MESSAGE_GAP_MS_MAX: 90 * 1000, // 90s
  // Mode: 'instant' or 'schedule'. Can be overridden with env SEND_MODE.
  MODE: "schedule",
};
