import fs from "node:fs/promises";
import path from "node:path";
import input from "input";
import { Api } from "telegram";

import { getErrorMessage, startClient, validateEnv } from "./auth.js";
import { getUserIdentifier } from "./utils.js";

export async function runParser() {
    const { apiId, apiHash, forceSms, authMethod } = validateEnv();
    const client = await startClient(apiId, apiHash, forceSms, authMethod);
    const me = await client.getMe();
    console.log(`Вход выполнен как ${me.username || me.firstName || me.id}`);

    let targetEntity = process.argv[2];
    if (!targetEntity) {
        targetEntity = await input.text("Введите username, ссылку или ID группы/канала для парсинга: ");
    }
    if (!targetEntity) {
        throw new Error("Группа не указана.");
    }

    console.log(`Получаем информацию о ${targetEntity}...`);
    let entity;
    try {
        entity = await client.getEntity(targetEntity);
    } catch (error) {
        throw new Error(`Ошибка при получении группы: ${getErrorMessage(error)}`);
    }

    const parseMethod = await input.select("Выберите метод сбора участников:", [
        { name: "Собрать всех участников (iterParticipants)", value: "all" },
        { name: "Собрать активных из истории сообщений (iterMessages)", value: "active" },
        { name: "Собрать комментаторов из постов канала", value: "comments" },
    ]);

    const participants = new Set();

    if (parseMethod === "all") {
        console.log("Начинаем сбор всех участников...");
        try {
            for await (const participant of client.iterParticipants(entity)) {
                if (participant.bot) continue;
                const id = getUserIdentifier(participant);
                if (id) participants.add(id);
            }
        } catch (err) {
            console.error(`Ошибка при обходе участников: ${getErrorMessage(err)}`);
        }
    } else if (parseMethod === "active") {
        const limitStr = await input.text("Сколько последних сообщений проверить? (по умолчанию 5000): ", { default: "5000" });
        const limit = parseInt(limitStr, 10) || 5000;
        console.log(`Сканируем последние ${limit} сообщений...`);

        try {
            let count = 0;
            for await (const message of client.iterMessages(entity, { limit })) {
                count++;
                if (count % 1000 === 0) {
                    console.log(`Проверено ${count} сообщений... Найдено пользователей: ${participants.size}`);
                }
                const sender = await message.getSender();
                if (!sender || sender.bot || sender.className !== "User") continue;
                const id = getUserIdentifier(sender);
                if (id) participants.add(id);
            }
        } catch (err) {
            console.error(`Ошибка при чтении сообщений: ${getErrorMessage(err)}`);
        }
    } else if (parseMethod === "comments") {
        let linkedGroup;
        try {
            const fullChannel = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
            const linkedChatId = fullChannel.fullChat.linkedChatId;
            if (!linkedChatId) {
                throw new Error("У этого канала нет привязанной дискуссионной группы. Комментарии недоступны.");
            }
            linkedGroup = await client.getEntity(linkedChatId);
            console.log(`Дискуссионная группа: ${linkedGroup.username || linkedGroup.title || linkedChatId}`);
        } catch (err) {
            throw new Error(`Ошибка при получении дискуссионной группы: ${getErrorMessage(err)}`);
        }

        const postsLimitStr = await input.text("Сколько последних постов канала проверить? (по умолчанию 100): ", { default: "100" });
        const postsLimit = parseInt(postsLimitStr, 10) || 100;

        console.log(`Парсим комментарии из последних ${postsLimit} постов...`);
        let postsDone = 0;

        for await (const post of client.iterMessages(entity, { limit: postsLimit })) {
            postsDone++;
            if (postsDone % 10 === 0) {
                console.log(`Обработано ${postsDone}/${postsLimit} постов... Найдено пользователей: ${participants.size}`);
            }

            let offsetId = 0;
            while (true) {
                let result;
                try {
                    result = await client.invoke(
                        new Api.messages.GetReplies({
                            peer: entity,
                            msgId: post.id,
                            offsetId,
                            offsetDate: 0,
                            addOffset: 0,
                            limit: 100,
                            maxId: 0,
                            minId: 0,
                            hash: BigInt(0),
                        })
                    );
                } catch {
                    break;
                }

                if (!result.messages?.length) break;

                const usersMap = new Map((result.users ?? []).map((u) => [String(u.id), u]));

                for (const msg of result.messages) {
                    if (msg.fromId?.className !== "PeerUser") continue;
                    const user = usersMap.get(String(msg.fromId.userId));
                    if (!user || user.bot) continue;
                    const id = getUserIdentifier(user);
                    if (id) participants.add(id);
                }

                if (result.messages.length < 100) break;
                offsetId = result.messages[result.messages.length - 1].id;
            }
        }
    }

    if (participants.size === 0) {
        console.log("Участники не найдены.");
        return;
    }

    console.log(`Собрано ${participants.size} уникальных пользователей.`);

    let defaultFilename = (entity.username ?? String(entity.id)).replace(/[^a-zA-Z0-9_-]/g, "_");
    let outName = await input.text(`Введите имя файла для сохранения [${defaultFilename}]: `, { default: defaultFilename });
    if (!outName.endsWith(".txt")) outName += ".txt";

    const outPath = path.resolve("lists", outName);
    await fs.mkdir(path.resolve("lists"), { recursive: true });
    await fs.writeFile(outPath, Array.from(participants).join("\n") + "\n", "utf8");

    console.log(`Сохранено в ${outPath}`);
}
