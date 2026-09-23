import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import input from "input";
import { Api } from "telegram";

import { getErrorMessage, startClient, validateEnv } from "./auth.js";
import { getUserIdentifier } from "./utils.js";
import { parserStats, clearLiveStats, sectionTitle, COLORS, R } from "./animate.js";
import { t } from "./i18n.js";

process.removeAllListeners("warning");
process.on("warning", (warning) => {
    if (warning.name === "TimeoutNegativeWarning") return;
    console.warn(warning.name, warning.message);
});

export async function runParser() {
    const { apiId, apiHash, forceSms, authMethod } = validateEnv();
    const client = await startClient(apiId, apiHash, forceSms, authMethod);
    const me = await client.getMe();

    await sectionTitle(t("parserTitle"));
    console.log(`  ${COLORS.gray}${t("parserAuth")} ${R}${COLORS.green}${me.username || me.firstName || me.id}${R}\n`);

    let entity;
    const prefilled = process.argv[2];

    if (prefilled) {
        console.log(`\n  ${COLORS.cyan}i${R}  ${COLORS.gray}${t("parserFetching", prefilled)}${R}`);
        try {
            entity = await client.getEntity(prefilled);
        } catch (error) {
            throw new Error(t("parserGroupError", getErrorMessage(error)));
        }
    } else {
        const inputMode = await input.select(t("parserSelectSource"), [
            { name: t("parserSourceMyChats"), value: "dialogs" },
            { name: t("parserSourceManual"),  value: "manual"  },
        ]);

        if (inputMode === "dialogs") {
            console.log(`\n  ${COLORS.cyan}i${R}  ${COLORS.gray}${t("parserLoadingDialogs")}${R}`);
            const dialogs = await client.getDialogs({ limit: 200 });
            const chatDialogs = dialogs.filter((d) =>
                d.entity && (d.isGroup || d.isChannel || d.entity.className === "Chat")
            );
            if (chatDialogs.length === 0) {
                throw new Error(t("parserNoDialogs"));
            }
            const chosen = await input.select(t("parserSelectChat"), chatDialogs.map((d) => ({
                name: `${d.title || d.name || String(d.id)}${d.entity.username ? `  @${d.entity.username}` : ""}`,
                value: d.entity,
            })));
            entity = chosen;
        } else {
            const targetEntity = await input.text(t("parserEnterGroup"));
            if (!targetEntity) throw new Error("No group specified.");
            console.log(`\n  ${COLORS.cyan}i${R}  ${COLORS.gray}${t("parserFetching", targetEntity)}${R}`);
            try {
                entity = await client.getEntity(targetEntity);
            } catch (error) {
                throw new Error(t("parserGroupError", getErrorMessage(error)));
            }
        }
    }

    const parseMethod = await input.select(t("parserSelectMethod"), [
        { name: t("parserMethodAll"),      value: "all"      },
        { name: t("parserMethodActive"),   value: "active"   },
        { name: t("parserMethodComments"), value: "comments" },
    ]);

    let defaultFilename = (entity.username ?? String(entity.id)).replace(/[^a-zA-Z0-9_-]/g, "_");
    let outName = await input.text(t("parserEnterFilename", defaultFilename), { default: defaultFilename });
    if (!outName.endsWith(".txt")) outName += ".txt";

    const outPath = path.resolve("lists", outName);
    const statePath = path.resolve("lists", outName.replace(".txt", ".state.json"));
    await fs.mkdir(path.resolve("lists"), { recursive: true });

    const stream = createWriteStream(outPath, { flags: "a", encoding: "utf8" });
    const participants = new Set();
    let resumeState = { offsetId: 0, method: "" };

    try {
        const existingData = await fs.readFile(outPath, "utf8");
        for (const line of existingData.split("\n")) {
            const trimmed = line.trim();
            if (trimmed) participants.add(trimmed);
        }
        if (participants.size > 0) {
            console.log(`  ${COLORS.green}v${R}  ${COLORS.gray}${t("parserLoadedExisting", participants.size)}${R}`);
        }
        const stateData = await fs.readFile(statePath, "utf8");
        const parsedState = JSON.parse(stateData);
        if (parsedState.method === parseMethod && parsedState.offsetId) {
            resumeState = parsedState;
            console.log(`  ${COLORS.green}v${R}  ${COLORS.gray}${t("parserResuming", resumeState.offsetId)}${R}`);
        }
    } catch {}

    const addParticipant = (user) => {
        const id = getUserIdentifier(user);
        if (id && !participants.has(id)) {
            participants.add(id);
            stream.write(id + "\n");
        }
    };

    try {
        if (parseMethod === "all") {
            console.log(t("parserCollectingAll"));
            try {
                let count = 0;
                const startTime = Date.now();
                for await (const participant of client.iterParticipants(entity)) {
                    if (participant.bot) continue;
                    addParticipant(participant);
                    count++;
                    if (Date.now() - startTime > 100) {
                        parserStats({ messagesDone: count, usersFound: participants.size, staleCount: 0, staleLimit: 0 });
                    }
                }
                clearLiveStats();
            } catch (err) {
                console.error(t("parserMembersError", getErrorMessage(err)));
            }
        } else if (parseMethod === "active") {
            const limitStr = await input.text(t("parserHowMany"), { default: "5000" });
            const limit = parseInt(limitStr, 10) || 5000;
            console.log(t("parserScanning", limit));

            try {
                let count = 0;
                const startTime = Date.now();
                for await (const message of client.iterMessages(entity, { limit, offsetId: resumeState.offsetId })) {
                    count++;
                    if (count % 500 === 0) {
                        fs.writeFile(statePath, JSON.stringify({ method: parseMethod, offsetId: message.id })).catch(() => {});
                    }
                    if (Date.now() - startTime > 100) {
                        parserStats({ messagesDone: count, usersFound: participants.size, staleCount: 0, staleLimit: 0 });
                    }
                    const sender = await message.getSender();
                    if (!sender || sender.bot || sender.className !== "User") continue;
                    addParticipant(sender);
                }
                clearLiveStats();
            } catch (err) {
                console.error(t("parserMessagesError", getErrorMessage(err)));
            }
        } else if (parseMethod === "comments") {
            let linkedGroup;
            try {
                const fullChannel = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
                const linkedChatId = fullChannel.fullChat.linkedChatId;
                if (!linkedChatId) {
                    throw new Error(t("parserNoLinked"));
                }
                linkedGroup = await client.getEntity(linkedChatId);
                console.log(t("parserLinkedFound", linkedGroup.username || linkedGroup.title || linkedChatId));
            } catch (err) {
                throw new Error(t("parserLinkedError", getErrorMessage(err)));
            }

            const postsLimitStr = await input.text(t("parserHowManyPosts"), { default: "all" });
            const postsLimit = postsLimitStr.trim().toLowerCase() === "all" ? undefined : parseInt(postsLimitStr, 10);

            const staleLimitStr = await input.text(t("parserStaleStop"), { default: "5000" });
            const staleLimit = parseInt(staleLimitStr, 10) || 5000;

            let minDate = 0;
            if (postsLimit) {
                console.log(t("parserComputingDate", postsLimit));
                const posts = await client.getMessages(entity, { limit: 1, addOffset: postsLimit - 1 });
                if (posts && posts.length > 0) {
                    minDate = posts[0].date;
                    console.log(t("parserLimitingByDate", new Date(minDate * 1000).toLocaleString()));
                }
            }

            console.log(t("parserParsingComments"));
            if (staleLimit > 0) {
                console.log(t("parserAutoStopEnabled", staleLimit));
            }

            let messagesDone = 0;
            let staleCount = 0;
            let lastUpdate = Date.now();

            for await (const msg of client.iterMessages(linkedGroup, { offsetId: resumeState.offsetId })) {
                if (messagesDone % 500 === 0) {
                    fs.writeFile(statePath, JSON.stringify({ method: parseMethod, offsetId: msg.id })).catch(() => {});
                }

                if (minDate > 0 && msg.date < minDate) {
                    clearLiveStats();
                    console.log(t("parserDateLimit"));
                    break;
                }

                messagesDone++;
                const sender = await msg.getSender();

                if (!sender || sender.bot || sender.className !== "User") {
                    if (Date.now() - lastUpdate > 150) {
                        parserStats({ messagesDone, usersFound: participants.size, staleCount, staleLimit });
                        lastUpdate = Date.now();
                    }
                    continue;
                }

                const oldSize = participants.size;
                addParticipant(sender);

                if (participants.size > oldSize) {
                    staleCount = 0;
                } else {
                    staleCount++;
                }

                if (Date.now() - lastUpdate > 150) {
                    parserStats({ messagesDone, usersFound: participants.size, staleCount, staleLimit });
                    lastUpdate = Date.now();
                }

                if (staleLimit > 0 && staleCount >= staleLimit) {
                    clearLiveStats();
                    console.log(t("parserAutoStopped", staleLimit));
                    break;
                }
            }
            clearLiveStats();
            fs.unlink(statePath).catch(() => {});
        }
    } catch (err) {
        console.error(t("parserError", getErrorMessage(err)));
    } finally {
        stream.end();
        await new Promise((resolve) => stream.on("finish", resolve));
    }

    if (participants.size === 0) {
        console.log(t("parserNoMembers"));
        return;
    }

    console.log(t("parserCollected", participants.size));
    console.log(t("parserSavedTo", outPath));
}
