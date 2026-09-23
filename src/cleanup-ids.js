import fs from "node:fs/promises";
import path from "node:path";
import input from "input";

const LISTS_DIR = path.resolve("lists");

async function cleanFile(file, keepIds) {
    const filePath = path.join(LISTS_DIR, file);
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    const cleaned = lines.filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        const isId = /^-?\d+:-?\d+$/.test(trimmed);
        return keepIds || !isId;
    });

    await fs.writeFile(filePath, cleaned.join("\n") + "\n", "utf8");

    const removed = lines.filter((l) => l.trim()).length - cleaned.length;
    console.log(`${file}: removed ${removed} entries, kept ${cleaned.length}`);
}

export async function runCleanup() {
    const files = await fs.readdir(LISTS_DIR);
    const txtFiles = files.filter((f) => f.endsWith(".txt"));

    if (txtFiles.length === 0) {
        console.log("No .txt files found in lists/.");
        return;
    }

    const selected = await input.checkboxes(
        "Select files to clean (Space to toggle, Enter to confirm):",
        txtFiles.map((f) => ({ name: f, value: f }))
    );

    if (selected.length === 0) {
        console.log("No files selected.");
        return;
    }

    const keepIds = await input.confirm("Include userId:accessHash entries in output?", { default: false });

    await Promise.all(selected.map((file) => cleanFile(file, keepIds)));
}
