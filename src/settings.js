import fs from "node:fs/promises";
import path from "node:path";

const SETTINGS_PATH = path.resolve("storage", "settings.json");

const DEFAULTS = {
    sendMode: "schedule",
    messageSource: "maxim",
    savedN: 3,
    maximIntervals: "2-1-2",
    maximN: 1,
    specificFile: null,
    specificList: null,
    language: "en",
    textMessages: [],
    maximAppendText: "",
};

export async function loadSettings() {
    try {
        const content = await fs.readFile(SETTINGS_PATH, "utf8");
        return { ...DEFAULTS, ...JSON.parse(content) };
    } catch {
        return { ...DEFAULTS };
    }
}

export async function saveSettings(settings) {
    await fs.mkdir(path.resolve("storage"), { recursive: true });
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}
