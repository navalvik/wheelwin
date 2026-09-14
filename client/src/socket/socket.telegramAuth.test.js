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
    location: { hostname: "localhost", protocol: "http:", search: "", hash: "" },
    sessionStorage: {
        getItem: () => null
    },
    Telegram: {
        WebApp: {
            platform: "android",
            initData: RAW_INIT_DATA,
            initDataUnsafe: {
                user: { id: 999999999 }
            }
        }
    }
};

const {
    default: socket,
    getTelegramInitDiagnostics,
    resolveTelegramInitData,
    waitForTelegramInitData
} = await import("./socket.js");

// 1. Telegram environment: auth callback must contain the exact raw initData.

let handshakeAuth = null;

socket.auth((auth) => {

    handshakeAuth = auth;

});

assert(
    handshakeAuth?.telegramInitData === RAW_INIT_DATA,
    "socket auth callback must contain the exact raw initData"
);

// 2. initDataUnsafe must NOT be used.

assert(
    handshakeAuth?.telegramInitData !== String(999999999),
    "initDataUnsafe.user.id must never be sent as telegramInitData"
);

assert(
    !JSON.stringify(handshakeAuth ?? {}).includes("initDataUnsafe"),
    "auth payload must not reference initDataUnsafe"
);

// 3. Socket options remain unchanged.

const opts = socket.io.opts;

assert(opts.autoConnect === false, "autoConnect must remain false");

assert(opts.reconnection === true, "reconnection must remain true");

assert(
    opts.reconnectionAttempts === Infinity,
    "reconnectionAttempts must remain Infinity"
);

assert(opts.reconnectionDelay === 1000, "reconnectionDelay must remain 1000");

assert(opts.reconnectionDelayMax === 5000, "reconnectionDelayMax must remain 5000");

// 4. Socket remains a singleton.

const { default: socketAgain } = await import("./socket.js");

assert(socketAgain === socket, "socket module must export a singleton instance");

// 5. Safe diagnostics report presence only and never expose raw initData.

const populatedDiagnostics = getTelegramInitDiagnostics();

assert(populatedDiagnostics.runtimeDetected === true, "Telegram runtime must be detected");
assert(populatedDiagnostics.platform === "android", "Telegram platform must be reported");
assert(populatedDiagnostics.webAppInitDataPresent === true, "WebApp initData presence must be reported");
assert(populatedDiagnostics.urlInitDataPresent === false, "URL initData must be absent in this scenario");
assert(!JSON.stringify(populatedDiagnostics).includes(RAW_INIT_DATA), "diagnostics must never contain raw initData");

// 6. Android-style delayed initData must be picked up before timeout.

globalThis.window.Telegram = {
    WebApp: {
        platform: "android",
        initData: ""
    }
};

globalThis.window.location.hash = "";

globalThis.window.Telegram.WebView = {
    initParams: {}
};

const delayedInitDataPromise = waitForTelegramInitData({
    timeoutMs: 300,
    pollIntervalMs: 10
});

setTimeout(() => {

    globalThis.window.Telegram.WebApp.initData = RAW_INIT_DATA;

}, 30);

assert(
    await delayedInitDataPromise === RAW_INIT_DATA,
    "waitForTelegramInitData must resolve delayed Telegram initData"
);

// 7. Telegram launch-data URL fallback must authenticate even if the SDK
// object is missing or has not populated initData yet.

delete globalThis.window.Telegram;

globalThis.window.location.hash = `#tgWebAppData=${encodeURIComponent(RAW_INIT_DATA)}`;

globalThis.window.sessionStorage.getItem = () => null;

assert(
    resolveTelegramInitData() === RAW_INIT_DATA,
    "tgWebAppData URL fallback must resolve the raw initData"
);

let fallbackHandshakeAuth = null;

socket.auth((auth) => {

    fallbackHandshakeAuth = auth;

});

assert(
    fallbackHandshakeAuth?.telegramInitData === RAW_INIT_DATA,
    "socket auth callback must use tgWebAppData URL fallback"
);

assert(
    await waitForTelegramInitData({ timeoutMs: 50, pollIntervalMs: 10 }) === RAW_INIT_DATA,
    "Telegram URL fallback must be accepted by the initial wait"
);

// 8. Standard Web: Telegram launch signals absent -> no artificial delay.

globalThis.window.location.hash = "";
globalThis.window.location.search = "";

delete globalThis.window.Telegram;

globalThis.window.sessionStorage.getItem = () => null;

assert(
    resolveTelegramInitData() === "",
    "missing Telegram WebApp and launch data must resolve to empty string"
);

assert(
    await waitForTelegramInitData({ timeoutMs: 50, pollIntervalMs: 10 }) === "",
    "standard Web must not wait for Telegram initData"
);

// 9. Telegram object exists but initData empty -> resolver remains empty.

globalThis.window.Telegram = { WebApp: { platform: "android", initData: "" } };

globalThis.window.Telegram.WebView = {
    initParams: {}
};

globalThis.window.TelegramWebviewProxy = {
    postEvent: () => {}
};

globalThis.window.sessionStorage.getItem = () => "{}";

assert(
    resolveTelegramInitData() === "",
    "empty initData must resolve to empty string"
);

const emptyDiagnostics = getTelegramInitDiagnostics();

assert(emptyDiagnostics.runtimeDetected === true, "Telegram runtime must remain detectable when initData is empty");
assert(emptyDiagnostics.webAppPresent === true, "empty-initData diagnostics must report WebApp presence");
assert(emptyDiagnostics.webAppInitDataPresent === false, "empty-initData diagnostics must report missing WebApp initData");
assert(emptyDiagnostics.webViewPresent === true, "empty-initData diagnostics must report WebView presence");
assert(emptyDiagnostics.webViewInitParamsPresent === false, "empty-initData diagnostics must report empty WebView initParams");
assert(emptyDiagnostics.telegramWebviewProxyPresent === true, "diagnostics must report TelegramWebviewProxy presence");
assert(emptyDiagnostics.sessionStorageInitParamsPresent === true, "diagnostics must report stored Telegram initParams");
assert(!JSON.stringify(emptyDiagnostics).includes("{}"), "diagnostics must remain presence-only");

// Non-string initData also resolves to empty string (defensive).

globalThis.window.Telegram = {
    WebApp: { platform: "android", initData: undefined }
};

assert(
    resolveTelegramInitData() === "",
    "undefined initData must resolve to empty string"
);

delete globalThis.window.Telegram;
delete globalThis.window.TelegramWebviewProxy;

globalThis.window.location.hash = "";

globalThis.window.sessionStorage.getItem = () => null;

// 10. Bot token / secrets must NOT appear anywhere in client source code.

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
