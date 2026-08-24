import { readdirSync, readFileSync } from "node:fs";

import { dirname, join } from "node:path";

import { fileURLToPath } from "node:url";

const RAW_INIT_DATA =
    "user=%7B%22id%22%3A123456789%7D&auth_date=1756000000&hash=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

// ---------------------------------------------------------------------------
// Scenario setup: Telegram Mini App environment present BEFORE socket creation
// (the real client boot order — window.Telegram exists synchronously).
// ---------------------------------------------------------------------------

globalThis.window = {
    location: { hostname: "localhost", protocol: "http:" },
    Telegram: {
        WebApp: {
            initData: RAW_INIT_DATA,
            initDataUnsafe: {
                user: { id: 999999999 }
            }
        }
    }
};

const { default: socket, resolveTelegramInitData } = await import("./socket.js");

// 1. Telegram environment: exact raw initData inside handshake auth.

assert(
    socket.auth?.telegramInitData === RAW_INIT_DATA,
    "socket.auth.telegramInitData must contain the exact raw initData"
);

// 4. initDataUnsafe must NOT be used.

assert(
    socket.auth?.telegramInitData !== String(999999999),
    "initDataUnsafe.user.id must never be sent as telegramInitData"
);

assert(
    !JSON.stringify(socket.auth ?? {}).includes("initDataUnsafe"),
    "auth payload must not reference initDataUnsafe"
);

// 6. Existing socket options remain unchanged.

const opts = socket.io.opts;

assert(opts.autoConnect === false, "autoConnect must remain false");

assert(opts.reconnection === true, "reconnection must remain true");

assert(
    opts.reconnectionAttempts === Infinity,
    "reconnectionAttempts must remain Infinity"
);

assert(opts.reconnectionDelay === 1000, "reconnectionDelay must remain 1000");

assert(opts.reconnectionDelayMax === 5000, "reconnectionDelayMax must remain 5000");

// 7. Socket remains a singleton.

const { default: socketAgain } = await import("./socket.js");

assert(socketAgain === socket, "socket module must export a singleton instance");

// ---------------------------------------------------------------------------
// 2. Standard Web: window.Telegram absent -> empty auth value, no rejection.
// ---------------------------------------------------------------------------

delete globalThis.window.Telegram;

assert(
    resolveTelegramInitData() === "",
    "missing Telegram WebApp must resolve to empty string"
);

// ---------------------------------------------------------------------------
// 3. Telegram object exists but initData empty -> empty auth value.
// ---------------------------------------------------------------------------

globalThis.window.Telegram = { WebApp: { initData: "" } };

assert(
    resolveTelegramInitData() === "",
    "empty initData must resolve to empty string"
);

// Non-string initData also resolves to empty string (defensive).

globalThis.window.Telegram = { WebApp: { initData: undefined } };

assert(
    resolveTelegramInitData() === "",
    "undefined initData must resolve to empty string"
);

delete globalThis.window.Telegram;

// ---------------------------------------------------------------------------
// 5. Bot token / secrets must NOT appear anywhere in client source code.
// ---------------------------------------------------------------------------

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const forbiddenPatterns = [
    /TELEGRAM_BOT_TOKEN/,
    /HMAC_SECRET/i,
    /bot\d{8,}:[A-Za-z0-9_-]{30,}/
];

function collectSourceFiles(directory) {

    const entries = readdirSync(directory, { withFileTypes: true });

    const files = [];

    for (const entry of entries) {

        const fullPath = join(directory, entry.name);

        if (entry.isDirectory()) {

            files.push(...collectSourceFiles(fullPath));

            continue;

        }

        if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {

            files.push(fullPath);

        }

    }

    return files;

}

for (const filePath of collectSourceFiles(srcDir)) {

    const content = readFileSync(filePath, "utf8");

    for (const pattern of forbiddenPatterns) {

        assert(
            !pattern.test(content),
            `Forbidden secret pattern ${pattern} found in ${filePath}`
        );

    }

}

process.stdout.write("socket.telegramAuth tests passed" + String.fromCharCode(10));
