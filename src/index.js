import { Api } from "telegram";

import {
  FLOOD_GUARD,
  LOG_MODE,
  PATHS,
  RATE_LIMITS,
  SAVED_MESSAGES_CONFIG,
  STICKER_CONFIG,
  SCHEDULER_CONFIG,
} from "./config.js";
import { loadListUsers, loadMessageFiles } from "./io.js";
import { loadProgressState, saveProgressState } from "./progress.js";
import { appendReportRow } from "./report.js";
import { loadProcessedUsers, saveProcessedUsers } from "./storage.js";
import { normalizeUsername, sleep, usernameKey } from "./utils.js";
import { getErrorMessage, validateEnv, startClient } from "./auth.js";

function nowStamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

let CURRENT_LOG_MODE = LOG_MODE;

function parseIntervals(str) {
  if (!str || typeof str !== "string") return [];
  return str
    .split("-")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function getStrictSliceIndices(userIndex, intervals, totalMessages) {
  if (!intervals || !intervals.length) {
    const envN = Number(process.env.SAVED_MESSAGES_N);
    const n =
      envN && envN > 0
        ? envN
        : Math.max(1, Number(SAVED_MESSAGES_CONFIG.N) || 1);
    return { start: totalMessages - n, end: totalMessages, count: n };
  }
  let offset = 0;
  let intervalIdx = 0;
  let i = 0;
  while (i < userIndex) {
    offset += intervals[intervalIdx];
    intervalIdx = (intervalIdx + 1) % intervals.length;
    i++;
  }
  const count = intervals[intervalIdx];
  if (offset >= totalMessages) {
    offset = offset % totalMessages;
  }
  let end = totalMessages - offset;
  let start = end - count;
  if (start < 0) {
    start = Math.max(0, totalMessages - count);
    end = totalMessages;
  }
  return { start, end, count };
}

async function loadExistingDialogIds(client) {
  const ids = new Set();
  let offsetDate = 0;
  let offsetId = 0;
  let offsetPeer = new Api.InputPeerEmpty();
  const batchSize = 100;

  for (let page = 0; page < 30; page += 1) {
    const result = await client.invoke(
      new Api.messages.GetDialogs({
        offsetDate,
        offsetId,
        offsetPeer,
        limit: batchSize,
        hash: BigInt(0),
        excludePinned: false,
        folderId: null,
      }),
    );

    if (!result?.dialogs?.length) break;

    for (const dialog of result.dialogs) {
      const peerId = dialog.peer;
      if (peerId?.userId !== undefined && peerId.userId !== null) {
        ids.add(String(peerId.userId));
      }
    }

    if (result.dialogs.length < batchSize) break;

    const lastMsg = result.messages?.[result.messages.length - 1];
    if (!lastMsg) break;
    offsetDate = lastMsg.date;
    offsetId = lastMsg.id;
    const lastDialog = result.dialogs[result.dialogs.length - 1];
    offsetPeer = lastDialog.peer;
  }

  return ids;
}

function findResumeIndexFromProcessed(usersFromLists, processedUsers) {
  for (let index = 0; index < usersFromLists.length; index += 1) {
    const user = normalizeUsername(usersFromLists[index].raw);
    if (!user) continue;
    if (!processedUsers.has(usernameKey(user))) return index;
  }
  return usersFromLists.length;
}

function isPeerFloodError(message) {
  return String(message).toUpperCase().includes("PEER_FLOOD");
}

const SKIPPABLE_ERRORS = [
  "INPUT_USER_DEACTIVATED",
  "USERNAME_NOT_OCCUPIED",
  "USER_BLOCKED",
  "PRIVACY_KEY_INVALID",
  "USER_DEACTIVATED_BAN",
  "CANNOT FIND ANY ENTITY",
  "THE SPECIFIED USER WAS DELETED",
];

function isSkippableError(message) {
  const upper = String(message).toUpperCase();
  return SKIPPABLE_ERRORS.some((e) => upper.includes(e));
}

function extractMessageText(message) {
  if (!message || typeof message !== "object") return "";
  if (typeof message.message === "string" && message.message.trim())
    return message.message.trim();
  if (typeof message.text === "string" && message.text.trim())
    return message.text.trim();
  return "";
}

// ========== ФУНКЦИИ ДЛЯ РАБОТЫ С @SpamBot ==========

async function getSpamBotStatus(client) {
  const commandUnixTime = Math.floor(Date.now() / 1000) - 3;
  await client.sendMessage(FLOOD_GUARD.SPAM_BOT_USERNAME, {
    message: "/start",
  });

  for (let attempt = 0; attempt < FLOOD_GUARD.POLL_ATTEMPTS; attempt += 1) {
    await sleep(
      attempt === 0
        ? FLOOD_GUARD.INITIAL_WAIT_MS
        : FLOOD_GUARD.POLL_INTERVAL_MS,
    );

    const messages = await client.getMessages(FLOOD_GUARD.SPAM_BOT_USERNAME, {
      limit: 10,
    });
    if (!messages || messages.length === 0) continue;

    const freshIncoming = messages.find(
      (m) =>
        !m.out &&
        Number.isFinite(Number(m.date)) &&
        Number(m.date) >= commandUnixTime &&
        extractMessageText(m),
    );
    const bestMessage =
      freshIncoming || messages.find((m) => !m.out && extractMessageText(m));
    if (!bestMessage) continue;

    const statusText = extractMessageText(bestMessage);
    const lower = statusText.toLowerCase();
    const hasRestriction =
      !lower.includes("good news") && !lower.includes("no limits");
    return { hasRestriction, statusText };
  }

  return { hasRestriction: null, statusText: "Нет ответа от @SpamBot" };
}

async function getSpamBotMessageWithButtons(client, minUnixTime = 0) {
  for (let attempt = 0; attempt < FLOOD_GUARD.POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(FLOOD_GUARD.POLL_INTERVAL_MS);

    const messages = await client.getMessages(FLOOD_GUARD.SPAM_BOT_USERNAME, {
      limit: 10,
    });
    if (!messages || messages.length === 0) continue;

    const hasButtons = (m) =>
      !m.out && m.replyMarkup && Array.isArray(m.replyMarkup.rows);
    const fresh = messages.find(
      (m) =>
        hasButtons(m) &&
        Number.isFinite(Number(m.date)) &&
        Number(m.date) >= minUnixTime,
    );
    const result = fresh || messages.find(hasButtons);
    if (result) return result;
  }
  return null;
}

async function clickButtonByText(client, chat, msg, buttonText) {
  if (!msg?.replyMarkup?.rows) return false;
  const peer = await client.getInputEntity(chat);
  const expectedText = buttonText.toLowerCase();
  const availableButtons = [];

  for (const row of msg.replyMarkup.rows) {
    for (const button of row.buttons) {
      const label = typeof button.text === "string" ? button.text.trim() : "";
      if (!label) continue;
      availableButtons.push(label);
      if (!label.toLowerCase().includes(expectedText)) continue;

      const hasCallbackData =
        button.data !== undefined &&
        button.data !== null &&
        (!("length" in button.data) || button.data.length > 0);

      if (hasCallbackData) {
        try {
          await client.invoke(
            new Api.messages.GetBotCallbackAnswer({
              peer,
              msgId: msg.id,
              data: button.data,
            }),
          );
          return true;
        } catch (error) {
          const msg2 = getErrorMessage(error);
          if (!String(msg2).toUpperCase().includes("DATA_INVALID")) throw error;
          console.log(
            `Некорректный callback для кнопки "${label}", пробую отправить текст кнопки.`,
          );
        }
      }

      await client.sendMessage(chat, { message: label });
      return true;
    }
  }

  if (availableButtons.length > 0) {
    console.log(
      `Кнопка "${buttonText}" не найдена. Доступные: ${availableButtons.join(" | ")}`,
    );
  }
  return false;
}

async function attemptUnblock(client) {
  console.log("Пробую снять ограничение через диалог с @SpamBot...");
  const startUnixTime = Math.floor(Date.now() / 1000) - 2;
  await client.sendMessage(FLOOD_GUARD.SPAM_BOT_USERNAME, {
    message: "/start",
  });
  await sleep(FLOOD_GUARD.INITIAL_WAIT_MS);

  let msg = await getSpamBotMessageWithButtons(client, startUnixTime);
  if (!msg) {
    console.log("Нет ответа с кнопками от @SpamBot");
    return false;
  }

  const initialText = extractMessageText(msg).toLowerCase();
  if (initialText.includes("good news") || initialText.includes("no limits")) {
    console.log("На аккаунте уже нет ограничений.");
    return true;
  }

  console.log('Нажимаю "why was I reported?"...');
  if (
    !(await clickButtonByText(
      client,
      FLOOD_GUARD.SPAM_BOT_USERNAME,
      msg,
      "why was I reported",
    ))
  ) {
    console.log('Кнопка "why was I reported?" не найдена.');
    return false;
  }

  await sleep(FLOOD_GUARD.INITIAL_WAIT_MS);
  const secondStepUnixTime = Math.floor(Date.now() / 1000) - 2;
  msg = await getSpamBotMessageWithButtons(client, secondStepUnixTime);
  if (!msg) {
    console.log("Нет ответа после первого клика");
    return false;
  }

  console.log('Нажимаю "i understand, thanks"...');
  if (
    !(await clickButtonByText(
      client,
      FLOOD_GUARD.SPAM_BOT_USERNAME,
      msg,
      "i understand, thanks",
    ))
  ) {
    console.log('Кнопка "i understand, thanks" не найдена.');
    return false;
  }

  await sleep(FLOOD_GUARD.INITIAL_WAIT_MS);
  console.log("Проверяю финальный статус...");
  const finalStatus = await getSpamBotStatus(client);
  console.log(`Финальный статус: ${finalStatus.statusText}`);
  return finalStatus.hasRestriction === false;
}

// ========== КОНЕЦ ФУНКЦИЙ ДЛЯ @SpamBot ==========

async function appendLog(user, status, messageCount = "") {
  await appendReportRow(PATHS.REPORT_CSV, {
    timestamp: nowStamp(),
    user,
    mode: CURRENT_LOG_MODE,
    messageCount,
    status,
  });
}

async function loadStickerDocument(client) {
  const stickerSets = await client.invoke(
    new Api.messages.GetAllStickers({ hash: 0 }),
  );
  if (!stickerSets?.sets?.length) return null;

  const firstSet = stickerSets.sets[0];
  const stickerSet = await client.invoke(
    new Api.messages.GetStickerSet({
      stickerset: new Api.InputStickerSetID({
        id: firstSet.id,
        accessHash: firstSet.accessHash,
      }),
      hash: 0,
    }),
  );

  if (!stickerSet?.documents?.length) return null;
  return stickerSet.documents[0];
}

async function forwardSavedMessages(client, user, savedMessages) {
  for (let index = 0; index < savedMessages.length; index += 1) {
    await client.forwardMessages(user, {
      messages: [savedMessages[index].id],
      fromPeer: "me",
      dropAuthor: false,
    });
    if (index < savedMessages.length - 1)
      await sleep(RATE_LIMITS.INTER_MESSAGE_DELAY_MS);
  }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function computeNextPeakUtcMs() {
  const nowMs = Date.now();
  const MSK_OFFSET = 3 * 60 * 60 * 1000;
  const mskNow = new Date(nowMs + MSK_OFFSET);
  const hours = Array.isArray(SCHEDULER_CONFIG.PEAK_HOURS_MSK)
    ? SCHEDULER_CONFIG.PEAK_HOURS_MSK
    : [SCHEDULER_CONFIG.PEAK_HOUR_MSK];
  const minute = Number(SCHEDULER_CONFIG.PEAK_MINUTE) || 0;
  const candidates = [];

  for (const h of hours) {
    const candidate = new Date(mskNow);
    candidate.setHours(Number(h), minute, 0, 0);
    if (candidate.getTime() <= mskNow.getTime()) {
      candidate.setTime(candidate.getTime() + 24 * 60 * 60 * 1000);
    }
    const jitter = randomInt(
      -SCHEDULER_CONFIG.PEAK_JITTER_MINUTES,
      SCHEDULER_CONFIG.PEAK_JITTER_MINUTES,
    );
    candidate.setTime(candidate.getTime() + jitter * 60 * 1000);
    if (candidate.getTime() <= mskNow.getTime()) {
      candidate.setTime(candidate.getTime() + 24 * 60 * 60 * 1000);
    }
    candidates.push(candidate.getTime());
  }

  return Math.min(...candidates) - MSK_OFFSET;
}

async function forwardSavedMessagesWithGaps(client, user, savedMessages) {
  for (let index = 0; index < savedMessages.length; index += 1) {
    await client.forwardMessages(user, {
      messages: [savedMessages[index].id],
      fromPeer: "me",
      dropAuthor: false,
    });
    if (index < savedMessages.length - 1) {
      await sleep(
        randomInt(
          SCHEDULER_CONFIG.INTER_MESSAGE_GAP_MS_MIN,
          SCHEDULER_CONFIG.INTER_MESSAGE_GAP_MS_MAX,
        ),
      );
    }
  }
}

async function scheduleForwardMessagesViaTelegram(client, user, savedMessages) {
  const baseUtcMs = computeNextPeakUtcMs();
  let cumulative = 0;
  const scheduledTimestamps = [];

  for (let i = 0; i < savedMessages.length; i += 1) {
    if (i > 0) {
      cumulative += randomInt(
        SCHEDULER_CONFIG.INTER_MESSAGE_GAP_MS_MIN,
        SCHEDULER_CONFIG.INTER_MESSAGE_GAP_MS_MAX,
      );
    }
    const scheduledMs = baseUtcMs + cumulative;

    try {
      await client.invoke(
        new Api.messages.ForwardMessages({
          fromPeer: "me",
          id: [savedMessages[i].id],
          toPeer: user,
          dropAuthor: false,
          scheduleDate: Math.floor(scheduledMs / 1000),
        }),
      );
      scheduledTimestamps.push(scheduledMs);
    } catch (err) {
      console.error(
        `Ошибка планирования пересылки для ${user}:`,
        getErrorMessage(err),
      );
    }
  }

  return scheduledTimestamps;
}

function parseUserEntry(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const idHashMatch = value.match(/^(\d+):(-?\d+)$/);
  if (idHashMatch) {
    return new Api.InputPeerUser({
      userId: BigInt(idHashMatch[1]),
      accessHash: BigInt(idHashMatch[2]),
    });
  }
  return value.startsWith("@") ? value : `@${value}`;
}

export async function runSpammer(settings = {}) {
  const { apiId, apiHash, forceSms, authMethod } = validateEnv();
  const usersFromLists = await loadListUsers(PATHS.LISTS_DIR);
  let { nextIndex: startIndex } = await loadProgressState(
    PATHS.PROGRESS_STATE_JSON,
    usersFromLists.length,
  );
  const processedUsers = await loadProcessedUsers(PATHS.PROCESSED_USERS_JSON);
  const usersSeenThisRun = new Set();

  if (startIndex === 0 && processedUsers.size > 0) {
    const derivedStartIndex = findResumeIndexFromProcessed(
      usersFromLists,
      processedUsers,
    );
    if (derivedStartIndex > 0) {
      startIndex = derivedStartIndex;
      await saveProgressState(
        PATHS.PROGRESS_STATE_JSON,
        startIndex,
        usersFromLists.length,
      );
      console.log(
        `Точка продолжения инициализирована из обработанных пользователей: строка ${startIndex + 1}`,
      );
    }
  }

  if (startIndex >= usersFromLists.length) {
    console.log(`Загружено пользователей: ${usersFromLists.length}`);
    console.log(`Уже обработано пользователей: ${processedUsers.size}`);
    console.log("В списках нет необработанных строк. Отправлять нечего.");
    return;
  }

  const client = await startClient(apiId, apiHash, forceSms, authMethod);
  const me = await client.getMe();
  console.log(`Вход выполнен как ${me.username || me.firstName || me.id}`);

  const envMode = (process.env.SEND_MODE || "").trim().toLowerCase();
  const sendMode = envMode || SCHEDULER_CONFIG.MODE || "schedule";
  const isScheduling = String(sendMode).toLowerCase() === "schedule";

  CURRENT_LOG_MODE = isScheduling ? "Scheduled" : "Instant";
  console.log(
    `Send mode: ${isScheduling ? "schedule (server)" : "instant (immediate)"}`,
  );

  const messageSource = settings.messageSource || "maxim";

  let txtFiles = [];
  let cachedSavedMessages = [];
  let intervals = [];

  if (messageSource === "txt") {
    txtFiles = await loadMessageFiles(PATHS.MESSAGES_DIR);
    if (txtFiles.length === 0) {
      throw new Error("No message files found in messages/. Add at least one .txt file.");
    }
    console.log(`Loaded ${txtFiles.length} message file(s) from messages/.`);
  } else if (messageSource === "saved-n") {
    const n = settings.savedN || 3;
    const rawSaved = await client.getMessages("me", { limit: n });
    if (!rawSaved || rawSaved.length === 0) {
      throw new Error("No messages in Saved Messages. Save at least one message first.");
    }
    cachedSavedMessages = [...rawSaved].reverse();
    console.log(`Loaded ${cachedSavedMessages.length} messages from Saved Messages.`);
  } else {
    const envIntervals = parseIntervals(process.env.SAVED_MESSAGES_INTERVALS);
    intervals = envIntervals.length
      ? envIntervals
      : parseIntervals(SAVED_MESSAGES_CONFIG.INTERVALS);
    const maxN = intervals.length
      ? intervals.reduce((a, b) => a + b, 0)
      : Math.max(1, Number(process.env.SAVED_MESSAGES_N) || SAVED_MESSAGES_CONFIG.N);
    const rawSaved = await client.getMessages("me", { limit: maxN });
    if (!rawSaved || rawSaved.length === 0) {
      throw new Error("В «Избранном» нет сообщений. Сохраните хотя бы одно сообщение в Saved Messages.");
    }
    cachedSavedMessages = [...rawSaved].reverse();
    console.log(`Загружено ${cachedSavedMessages.length} сообщений из «Избранного» (макс ${maxN}).`);
  }
  console.log("Загрузка существующих чатов...");

  const existingDialogIds = await loadExistingDialogIds(client);
  console.log(`Найдено активных чатов: ${existingDialogIds.size}.`);
  console.log(`Загружено пользователей: ${usersFromLists.length}`);
  console.log(`Уже обработано пользователей: ${processedUsers.size}`);
  if (startIndex > 0) {
    console.log(`Продолжаем с строки: ${startIndex + 1}`);
  }

  let attemptCounter = 0;

  try {
    for (
      let rowIndex = startIndex;
      rowIndex < usersFromLists.length;
      rowIndex += 1
    ) {
      const row = usersFromLists[rowIndex];
      const nextIndex = rowIndex + 1;
      const userEntry = parseUserEntry(row.raw);

      if (!userEntry) {
        await saveProgressState(
          PATHS.PROGRESS_STATE_JSON,
          nextIndex,
          usersFromLists.length,
        );
        continue;
      }

      const userLabel =
        typeof userEntry === "string" ? userEntry : `id:${userEntry.userId}`;
      const dedupeKey = usernameKey(userLabel);

      if (usersSeenThisRun.has(dedupeKey) || processedUsers.has(dedupeKey)) {
        console.log(`ПРОПУСК дубликата пользователя: ${userLabel}`);
        await appendLog(userLabel, "Skipped: duplicate username");
        await saveProgressState(
          PATHS.PROGRESS_STATE_JSON,
          nextIndex,
          usersFromLists.length,
        );
        continue;
      }

      usersSeenThisRun.add(dedupeKey);
      attemptCounter += 1;
      let stopAfterCurrentUser = false;

      try {
        let entity;
        try {
          entity = await client.getEntity(userEntry);
        } catch (resolveError) {
          const resolveMsg = getErrorMessage(resolveError);
          if (isSkippableError(resolveMsg)) {
            console.log(`ПРОПУСК (недоступен) ${userLabel}: ${resolveMsg}`);
            await appendLog(userLabel, `Skipped: ${resolveMsg}`);
            processedUsers.add(dedupeKey);
            await saveProcessedUsers(
              PATHS.PROCESSED_USERS_JSON,
              processedUsers,
            );
            await saveProgressState(
              PATHS.PROGRESS_STATE_JSON,
              nextIndex,
              usersFromLists.length,
            );
            continue;
          }
          throw resolveError;
        }

        const entityId = String(entity.id);
        if (existingDialogIds.has(entityId)) {
          console.log(`ПРОПУСК (чат уже есть) ${userLabel}`);
          await appendLog(userLabel, "Skipped: existing chat");
          processedUsers.add(dedupeKey);
          await saveProcessedUsers(PATHS.PROCESSED_USERS_JSON, processedUsers);
          await saveProgressState(
            PATHS.PROGRESS_STATE_JSON,
            nextIndex,
            usersFromLists.length,
          );
          continue;
        }

        console.log(`[${attemptCounter}] Sending to ${userLabel} (source: ${messageSource})`);

        if (messageSource === "txt") {
          const file = txtFiles[Math.floor(Math.random() * txtFiles.length)];
          if (isScheduling) {
            const scheduledUnix = Math.floor(computeNextPeakUtcMs() / 1000);
            await client.invoke(new Api.messages.SendMessage({
              peer: entity,
              message: file.text,
              scheduleDate: scheduledUnix,
            }));
            const isoTime = new Date(scheduledUnix * 1000).toISOString();
            console.log(`Scheduled text for ${userLabel} at ${isoTime}`);
            await appendLog(userLabel, `Scheduled: ${isoTime}`, 1);
          } else {
            await client.sendMessage(entity, { message: file.text });
            await appendLog(userLabel, "Success", 1);
          }
          processedUsers.add(dedupeKey);
          await saveProcessedUsers(PATHS.PROCESSED_USERS_JSON, processedUsers);
        } else if (messageSource === "saved-n") {
          if (isScheduling) {
            const scheduledMsList = await scheduleForwardMessagesViaTelegram(client, entity, cachedSavedMessages);
            if (scheduledMsList && scheduledMsList.length > 0) {
              const isoList = scheduledMsList.map((ts) => new Date(ts).toISOString()).join(", ");
              await appendLog(userLabel, `Scheduled: ${isoList}`, cachedSavedMessages.length);
              processedUsers.add(dedupeKey);
              await saveProcessedUsers(PATHS.PROCESSED_USERS_JSON, processedUsers);
            } else {
              console.warn(`Could not schedule messages for ${userLabel}`);
              await appendLog(userLabel, "Error: scheduling failed");
            }
          } else {
            await forwardSavedMessagesWithGaps(client, entity, cachedSavedMessages);
            await appendLog(userLabel, "Success", cachedSavedMessages.length);
            processedUsers.add(dedupeKey);
            await saveProcessedUsers(PATHS.PROCESSED_USERS_JSON, processedUsers);
          }
        } else {
          const { start, end, count } = getStrictSliceIndices(rowIndex - startIndex, intervals, cachedSavedMessages.length);
          let messagesToSend = [];
          if (start < end && end <= cachedSavedMessages.length) {
            messagesToSend = cachedSavedMessages.slice(start, end);
          }
          console.log(`interval ${count}, slice [${start}:${end}]`);

          if (messagesToSend.length === 0) {
            console.warn("Нет сообщений для отправки по текущему интервалу!");
          } else if (isScheduling) {
            const scheduledMsList = await scheduleForwardMessagesViaTelegram(client, entity, messagesToSend);
            if (scheduledMsList && scheduledMsList.length > 0) {
              const human = new Date(scheduledMsList[0]).toLocaleString();
              console.log(`Запланировано ${messagesToSend.length} сообщений для ${userLabel}, ближайшая: ${human}`);
              const isoList = scheduledMsList.map((ts) => new Date(ts).toISOString()).join(", ");
              await appendLog(userLabel, `Scheduled: ${isoList}`, messagesToSend.length);
              processedUsers.add(dedupeKey);
              await saveProcessedUsers(PATHS.PROCESSED_USERS_JSON, processedUsers);
            } else {
              console.warn(`Не удалось запланировать сообщения для ${userLabel}`);
              await appendLog(userLabel, "Error: scheduling failed");
            }
          } else {
            try {
              await forwardSavedMessagesWithGaps(client, entity, messagesToSend);
              await appendLog(userLabel, "Success", messagesToSend.length);
              processedUsers.add(dedupeKey);
              await saveProcessedUsers(PATHS.PROCESSED_USERS_JSON, processedUsers);
            } catch (err) {
              const msg = getErrorMessage(err);
              console.error(`Ошибка при мгновенной пересылке для ${userLabel}: ${msg}`);
              await appendLog(userLabel, `Error: ${msg}`);
            throw err;
          }
        }
        } // end messageSource === "maxim"
      } catch (error) {
        const message = getErrorMessage(error);

        if (isSkippableError(message)) {
          console.log(`ПРОПУСК (недоступен) ${userLabel}: ${message}`);
          await appendLog(userLabel, `Skipped: ${message}`);
          processedUsers.add(dedupeKey);
          await saveProcessedUsers(PATHS.PROCESSED_USERS_JSON, processedUsers);
          await saveProgressState(
            PATHS.PROGRESS_STATE_JSON,
            nextIndex,
            usersFromLists.length,
          );
          continue;
        }

        console.error(`Ошибка для ${userLabel}: ${message}`);
        await appendLog(userLabel, `Error: ${message}`);

        if (isPeerFloodError(message)) {
          console.error("Обнаружен PEER_FLOOD. Пытаюсь снять ограничение...");
          let unblockSuccess = false;

          if (!isScheduling && FLOOD_GUARD.CHECK_SPAM_BOT_STATUS) {
            try {
              unblockSuccess = await attemptUnblock(client);
            } catch (e) {
              console.error(
                "Попытка разблокировки завершилась исключением:",
                e,
              );
            }
          } else if (isScheduling) {
            console.log("Пропускаю проверку @SpamBot в режиме Schedule.");
          }

          if (unblockSuccess) {
            console.log("✅ Ограничение снято, продолжаем обработку.");
            await appendLog(userLabel, "PEER_FLOOD resolved, continuing");
          } else {
            console.error(
              "❌ Разблокировка не удалась. Ждем 40 минут перед продолжением.",
            );
            await sleep(FLOOD_GUARD.BAN_WAIT_MS);
            await appendLog(userLabel, "PEER_FLOOD wait 40min");
          }
        }
      }

      if (stopAfterCurrentUser) {
        await saveProgressState(
          PATHS.PROGRESS_STATE_JSON,
          rowIndex,
          usersFromLists.length,
        );
        console.log(
          `Запуск остановлен на строке ${rowIndex + 1}. При следующем запуске будет повторная попытка.`,
        );
        break;
      }

      await saveProgressState(
        PATHS.PROGRESS_STATE_JSON,
        nextIndex,
        usersFromLists.length,
      );

      if ((rowIndex + 1) % FLOOD_GUARD.CHECK_INTERVAL_USERS === 0) {
        if (!isScheduling && FLOOD_GUARD.CHECK_SPAM_BOT_STATUS) {
          console.log(
            `🔄 Проверка статуса аккаунта через @SpamBot (после строки ${rowIndex + 1})...`,
          );
          try {
            const status = await getSpamBotStatus(client);
            if (status.hasRestriction === true) {
              console.log(
                "⚠️ SpamBot сообщает об ограничениях. Запускаю разблокировку...",
              );
              await attemptUnblock(client);
            } else if (status.hasRestriction === false) {
              console.log("✅ SpamBot сообщает, что ограничений нет.");
            } else {
              console.log("⚠️ Не удалось определить статус через SpamBot.");
            }
          } catch (error) {
            console.error("Ошибка при проверке статуса SpamBot:", error);
          }
        } else if (isScheduling) {
          console.log(
            "Пропуск периодической проверки @SpamBot в режиме Schedule.",
          );
        }
      }

      if (attemptCounter % RATE_LIMITS.USERS_PER_BATCH === 0) {
        console.log(
          `Пакет завершен (${attemptCounter} пользователей). Пауза ${Math.floor(RATE_LIMITS.BATCH_SLEEP_MS / 60000)} минут...`,
        );
        await sleep(RATE_LIMITS.BATCH_SLEEP_MS);
      }

      await sleep(RATE_LIMITS.INTER_USER_DELAY_MS);
    }
  } finally {
    const orig = {
      info: console.info,
      debug: console.debug,
      warn: console.warn,
    };
    try {
      console.info = () => {};
      console.debug = () => {};
      console.warn = () => {};
      await client.disconnect();
    } finally {
      console.info = orig.info;
      console.debug = orig.debug;
      console.warn = orig.warn;
    }
  }
}
