import input from "input";
import { runSpammer } from "./index.js";
import { runParser } from "./parser.js";
import { runDiscordSpammer } from "./discord.js";
import { runDiscordParser } from "./discord-parser.js";
import { runAnalyticsCollect } from "./analytics-collect.js";
import { runAnalyticsReport } from "./analytics-report.js";
import { runCleanup } from "./cleanup-ids.js";
import { loadSettings, saveSettings } from "./settings.js";

const SOURCE_LABELS = {
    txt: "txt files from messages/",
    "saved-n": "Last N from Saved Messages",
    maxim: "Maxim Method ⚠️  (do not touch)",
};

async function runSettings() {
    const settings = await loadSettings();

    const section = await input.select("Settings:", [
        { name: `Message source  [${SOURCE_LABELS[settings.messageSource]}]`, value: "source" },
        { name: `Send mode       [${settings.sendMode}]`, value: "mode" },
        { name: "← Back", value: "back" },
    ]);

    if (section === "back") return;

    if (section === "source") {
        const source = await input.select("Choose message source:", [
            { name: "txt files from messages/  — send text directly", value: "txt" },
            { name: "Last N from Saved Messages  — forward last N messages", value: "saved-n" },
            { name: "Maxim Method ⚠️  (do not touch unless you are incredibly smart or Oktavian himself)", value: "maxim" },
        ]);

        settings.messageSource = source;

        if (source === "saved-n") {
            const nStr = await input.text(`How many Saved Messages to forward? [${settings.savedN}]: `, { default: String(settings.savedN) });
            settings.savedN = parseInt(nStr, 10) || settings.savedN;
        }
    }

    if (section === "mode") {
        settings.sendMode = await input.select("Send mode:", [
            { name: "Schedule — send via Telegram scheduler at peak Moscow hours", value: "schedule" },
            { name: "Instant  — send immediately", value: "instant" },
        ]);
    }

    await saveSettings(settings);
    console.log("Settings saved.");
}

async function runToolkit() {
    const tool = await input.select("Toolkit:", [
        { name: "Parser — Telegram (extract users from group/channel)", value: "parser" },
        { name: "Parser — Discord (fetch member IDs from server)", value: "discord-parser" },
        { name: "Spammer — Discord (DM all server members)", value: "discord" },
        { name: "Analytics — Collect conversations from Telegram", value: "analytics-collect" },
        { name: "Analytics — Generate report (CSV + HTML)", value: "analytics-report" },
        { name: "Cleanup — Remove userId:accessHash entries from lists", value: "cleanup" },
        { name: "← Back", value: "back" },
    ]);

    if (tool === "back") return;

    if (tool === "parser") {
        console.log("\n--- Starting Parser ---\n");
        await runParser();
    } else if (tool === "discord-parser") {
        console.log("\n--- Starting Discord Parser ---\n");
        await runDiscordParser();
    } else if (tool === "discord") {
        console.log("\n--- Starting Discord Spammer ---\n");
        await runDiscordSpammer();
    } else if (tool === "analytics-collect") {
        console.log("\n--- Collecting conversations ---\n");
        await runAnalyticsCollect();
    } else if (tool === "analytics-report") {
        console.log("\n--- Generating analytics report ---\n");
        await runAnalyticsReport();
    } else if (tool === "cleanup") {
        console.log("\n--- Cleaning up ID entries from lists ---\n");
        await runCleanup();
    }
}

async function startSpammer(skipPrompts = false) {
    const settings = await loadSettings();

    if (!skipPrompts) {
        const presetMode = (process.env.SEND_MODE || "").trim().toLowerCase();
        settings.sendMode = presetMode || await input.select("Send mode:", [
            { name: "Schedule — send via Telegram scheduler at peak Moscow hours", value: "schedule" },
            { name: "Instant  — send immediately", value: "instant" },
        ]);
        await saveSettings(settings);
    }

    process.env.SEND_MODE = settings.sendMode;
    console.log(`\nSend mode: ${settings.sendMode}`);
    console.log(`Message source: ${SOURCE_LABELS[settings.messageSource]}\n`);

    await runSpammer(settings);
}

async function main() {
    console.log("==========================================");
    console.log("   Relevanty Spammer & Parser Utility   ");
    console.log("==========================================");

    const settings = await loadSettings();
    const choice = await input.select("Choose an action:", [
        { name: `Just Start  [${SOURCE_LABELS[settings.messageSource]} · ${settings.sendMode}]`, value: "go" },
        { name: "Start Spammer — Telegram", value: "spammer" },
        { name: "Toolkit", value: "toolkit" },
        { name: "Settings", value: "settings" },
        { name: "Exit", value: "exit" },
    ]);

    try {
        if (choice === "go") {
            await startSpammer(true);
        } else if (choice === "spammer") {
            await startSpammer(false);
        } else if (choice === "toolkit") {
            await runToolkit();
        } else if (choice === "settings") {
            await runSettings();
        } else {
            console.log("Exiting...");
            process.exit(0);
        }
    } catch (error) {
        console.error("\n[Error]:\n", error);
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
