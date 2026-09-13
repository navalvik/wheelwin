import { io } from "socket.io-client";

import { resolveBackendUrl } from "../config/backendUrl.js";

const SOCKET_URL = resolveBackendUrl();

const KNOWN_TMA_PLATFORMS = new Set([
    "android",
    "ios",
    "macos",
    "tdesktop",
    "weba",
    "web",
    "unigram"
]);

/**
 * Resolve the raw Telegram WebApp initData at handshake time.
 *
 * - Telegram Mini App: returns the raw `window.Telegram.WebApp.initData`
 *   string exactly as received (never parsed, never modified).
 * - Standard Web: returns an empty string when Telegram WebApp is unavailable
 *   or the runtime is not an actual Telegram Mini App.
 *
 * The server owns validation. The client never stores, logs, or transforms
 * this value — it only forwards it inside the Socket.IO handshake auth.
 */
export function resolveTelegramInitData() {

    const rawData = globalThis.window?.Telegram?.WebApp?.initData;

    return typeof rawData === "string" ? rawData : "";

}

function isTelegramMiniAppRuntime() {

    const win = globalThis.window;
    const webApp = win?.Telegram?.WebApp;

    if (!webApp) {

        return false;

    }

    if (typeof win?.TelegramWebviewProxy?.postEvent === "function") {

        return true;

    }

    const platform = typeof webApp.platform === "string"
        ? webApp.platform.toLowerCase()
        : "";

    return KNOWN_TMA_PLATFORMS.has(platform);

}

/**
 * Telegram Android can expose the WebApp object before its raw initData is
 * populated. Wait briefly for the authoritative initData before the first
 * socket connection so CREATE_ROOM does not start with an unauthenticated
 * socket. Standard browser access is not delayed.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollIntervalMs]
 * @returns {Promise<string>}
 */
export function waitForTelegramInitData({
    timeoutMs = 5000,
    pollIntervalMs = 50
} = {}) {

    if (!isTelegramMiniAppRuntime()) {

        return Promise.resolve("");

    }

    const immediate = resolveTelegramInitData();

    if (immediate) {

        return Promise.resolve(immediate);

    }

    return new Promise((resolve) => {

        const startedAt = Date.now();

        const poll = () => {

            const current = resolveTelegramInitData();

            if (current) {

                resolve(current);

                return;

            }

            if (Date.now() - startedAt >= timeoutMs) {

                resolve("");

                return;

            }

            window.setTimeout(poll, pollIntervalMs);

        };

        poll();

    });

}

const socket = io(SOCKET_URL, {

    // Socket.IO evaluates this auth callback for each connection attempt,
    // including reconnects. This prevents a stale initData value from being
    // reused after Telegram WebApp initialization/lifecycle changes.
    auth: (callback) => {

        callback({
            telegramInitData: resolveTelegramInitData()
        });

    },

    autoConnect: false,

    reconnection: true,

    reconnectionAttempts: Infinity,

    reconnectionDelay: 1000,

    reconnectionDelayMax: 5000

});

export default socket;
