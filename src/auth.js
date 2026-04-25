import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import input from "input";
import qrcodeTerminal from "qrcode-terminal";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const TELEGRAM_APPS_URL = "https://my.telegram.org/auth?to=apps";

export function getErrorMessage(error) {
    if (typeof error?.errorMessage === "string" && error.errorMessage.trim()) {
        return error.errorMessage.trim();
    }
    if (typeof error?.message === "string" && error.message.trim()) {
        return error.message.trim();
    }
    return String(error);
}

export function openTelegramAppsPage() {
    try {
        if (process.platform === "win32") {
            spawn("cmd", ["/c", "start", "", TELEGRAM_APPS_URL], { detached: true, stdio: "ignore" }).unref();
            return;
        }
        if (process.platform === "darwin") {
            spawn("open", [TELEGRAM_APPS_URL], { detached: true, stdio: "ignore" }).unref();
            return;
        }
        spawn("xdg-open", [TELEGRAM_APPS_URL], { detached: true, stdio: "ignore" }).unref();
    } catch (error) {
        console.warn(`Не удалось автоматически открыть браузер: ${getErrorMessage(error)}`);
        console.log(`Откройте ссылку вручную: ${TELEGRAM_APPS_URL}`);
    }
}

export function escapeEnvValue(value) {
    return String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");
}

export async function upsertEnvValue(filePath, key, value) {
    let content = "";
    try {
        content = await fs.readFile(filePath, "utf8");
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }

    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = content ? content.split(/\r?\n/) : [];
    const serialized = `${key}="${escapeEnvValue(value)}"`;
    let found = false;

    const updatedLines = lines.map((line) => {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (match?.[1] === key) {
            found = true;
            return serialized;
        }
        return line;
    });

    if (!found) {
        if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] !== "") {
            updatedLines.push("");
        }
        updatedLines.push(serialized);
    }

    let nextContent = updatedLines.join(eol);
    if (!nextContent.endsWith(eol)) nextContent += eol;
    await fs.writeFile(filePath, nextContent, "utf8");
}

export function validateEnv() {
    const apiId = Number(process.env.API_ID);
    const apiHash = process.env.API_HASH;
    const forceSms = String(process.env.FORCE_SMS ?? "false").toLowerCase() === "true";
    const authMethodRaw = String(process.env.AUTH_METHOD ?? "qr").trim().toLowerCase();
    const authMethod = authMethodRaw === "phone" ? "phone" : "qr";

    if (!process.env.API_ID || Number.isNaN(apiId) || apiId <= 0 || !apiHash) {
        openTelegramAppsPage();
        throw new Error(
            "В .env не заполнены API_ID/API_HASH. Открыл браузер: https://my.telegram.org/auth?to=apps. " +
            "Создайте Telegram App credentials и вставьте их в .env."
        );
    }

    return { apiId, apiHash, forceSms, authMethod };
}

export async function startClientWithPhoneAuth(client, forceSms) {
    let phoneNumberValue = "";
    const authParams = {
        phoneNumber: async () => {
            if (!phoneNumberValue) {
                phoneNumberValue = (await input.text("Номер телефона: ")).trim();
            }
            console.log(
                `Предпочтительный способ получения кода: ${authParams.forceSMS ? "SMS (forceSMS=true)" : "в приложении Telegram (forceSMS=false)"}`
            );
            return phoneNumberValue;
        },
        password: async () => input.text("Пароль 2FA (если включен): "),
        phoneCode: async (isCodeViaApp) => {
            const prompt = isCodeViaApp
                ? "Код Telegram (из чата Telegram в приложении): "
                : "Код Telegram (из SMS): ";
            console.log("Введите /resend для нового кода, /sms для SMS-режима или /app для кода в приложении.");
            const value = (await input.text(prompt)).trim();
            const command = value.toLowerCase();

            if (command === "/resend") {
                const err = new Error("Restart auth and resend code");
                err.errorMessage = "RESTART_AUTH";
                throw err;
            }
            if (command === "/sms") {
                authParams.forceSMS = true;
                const err = new Error("Restart auth with SMS");
                err.errorMessage = "RESTART_AUTH";
                throw err;
            }
            if (command === "/app") {
                authParams.forceSMS = false;
                const err = new Error("Restart auth with in-app code");
                err.errorMessage = "RESTART_AUTH";
                throw err;
            }

            return value;
        },
        forceSMS: forceSms,
        onError: (error) => console.error("Ошибка авторизации Telegram:", error),
    };
    await client.start(authParams);
}

export async function startClientWithQrAuth(client, apiId, apiHash) {
    console.log("Включен режим авторизации по QR.");
    console.log("Откройте Telegram на телефоне: Настройки -> Устройства -> Подключить устройство.");
    console.log("Затем отсканируйте QR-код ниже.");

    await client.signInUserWithQrCode(
        { apiId, apiHash },
        {
            qrCode: async ({ token, expires }) => {
                const loginUrl = `tg://login?token=${token.toString("base64url")}`;
                const expiresAt = new Date(Number(expires) * 1000);
                console.log(`\nНовый QR-код сгенерирован. Действует до ${expiresAt.toLocaleString()}`);
                qrcodeTerminal.generate(loginUrl, { small: true });
            },
            password: async (hint) =>
                input.text(hint ? `Пароль 2FA (подсказка: ${hint}): ` : "Пароль 2FA (если включен): "),
            onError: async (error) => {
                console.error("Ошибка QR-авторизации Telegram:", error);
                return false;
            },
        }
    );
}

export async function startClient(apiId, apiHash, forceSms, authMethod) {
    const sessionString = process.env.SESSION_STRING ?? "";
    const stringSession = new StringSession(sessionString);
    const envPath = path.resolve(".env");

    const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

    const originalConsole = { info: console.info, debug: console.debug, warn: console.warn };
    try {
        console.info = () => {};
        console.debug = () => {};
        console.warn = () => {};
        await client.connect();
    } finally {
        console.info = originalConsole.info;
        console.debug = originalConsole.debug;
        console.warn = originalConsole.warn;
    }

    if (!(await client.checkAuthorization())) {
        if (authMethod === "phone") {
            if (forceSms) {
                console.warn(
                    "FORCE_SMS=true: Telegram может не отправлять SMS-код для сторонних клиентов. " +
                    "Если код не приходит, установите FORCE_SMS=false."
                );
            }
            await startClientWithPhoneAuth(client, forceSms);
        } else {
            await startClientWithQrAuth(client, apiId, apiHash);
        }
    }

    const savedSessionString = client.session.save();
    if (!sessionString || savedSessionString !== sessionString) {
        await upsertEnvValue(envPath, "SESSION_STRING", savedSessionString);
        console.log("SESSION_STRING сохранен в .env");
    }
    if (!sessionString) {
        console.log("SESSION_STRING для .env:");
        console.log(savedSessionString);
    }

    return client;
}
