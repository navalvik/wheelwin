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

function resolveTelegramLaunchInitData() {

    const location = globalThis.window?.location;

    if (!location) {

        return "";

    }

    const sources = [location.search, location.hash];

    for (const source of sources) {

        if (typeof source !== "string" || !source) {

            continue;

        }

        try {

            const params = new URLSearchParams(
                source.startsWith("#") ? source.slice(1) : source
            );

            const rawData = params.get("tgWebAppData");

            if (rawData) {

                return rawData;

            }

        } catch {

            // Ignore malformed URL state and continue with the SDK path.

        }

    }

    return "";

}

/**
 * Resolve the raw Telegram WebApp initData at handshake time.
 *
 * - Telegram Mini App: returns the raw `window.Telegram.WebApp.initData`
 *   string exactly as received when the SDK exposes it.
 * - Telegram Mini App fallback: returns the `tgWebAppData` launch parameter
 *   from the URL when the Android WebView has not populated the SDK object.
 * - Standard Web: returns an empty string when no Telegram launch data exists.
 *
 * The server owns validation. The client never stores, logs, or transforms
 * this value — it only forwards it inside the Socket.IO handshake auth.
 */
export function resolveTelegramInitData() {

    const rawData = globalThis.window?.Telegram?.WebApp?.initData;

    if (typeof rawData === "string" && rawData) {

        return rawData;

    }

    return resolveTelegramLaunchInitData();

}

function isTelegramMiniAppRuntime() {

    const win = globalThis.window;
    const webApp = win?.Telegram?.WebApp;

    if (webApp) {

        if (typeof win?.TelegramWebviewProxy?.postEvent === "function") {

            return true;

        }

        const platform = typeof webApp.platform === "string"
            ? webApp.platform.toLowerCase()
            : "";

        if (KNOWN_TMA_PLATFORMS.has(platform)) {

            return true;

        }

    }

    return Boolean(resolveTelegramLaunchInitData());

}

function hasTelegramSessionStorageInitParams() {

    try {

        return Boolean(
            globalThis.window?.sessionStorage?.getItem("__telegram__initParams")
        );

    } catch {

        return false;

    }

}

/**
 * Safe Telegram launch diagnostics.
 *
 * This intentionally exposes presence/shape information only. It MUST NOT
 * expose raw initData, user data, hashes, query strings, or any credential.
 * The result is suitable for temporary production troubleshooting of the
 * Testnet -> Mainnet handoff boundary.
 */
export function getTelegramInitDiagnostics() {

    const win = globalThis.window;
    const webApp = win?.Telegram?.WebApp;
    const webView = win?.Telegram?.WebView;
    const webViewInitParams = webView?.initParams;

    const webAppInitDataPresent = typeof webApp?.initData === "string"
        && webApp.initData.length > 0;

    const urlInitDataPresent = Boolean(resolveTelegramLaunchInitData());

    const webViewInitDataPresent = typeof webViewInitParams?.tgWebAppData === "string"
        && webViewInitParams.tgWebAppData.length > 0;

    const webViewInitParamsPresent = Boolean(
        webViewInitParams
        && typeof webViewInitParams === "object"
        && Object.keys(webViewInitParams).length > 0
    );

    const platform = typeof webApp?.platform === "string"
        ? webApp.platform
        : "";

    return {
        runtimeDetected: isTelegramMiniAppRuntime(),
        platform,
        webAppPresent: Boolean(webApp),
        webAppInitDataPresent,
        urlInitDataPresent,
        webViewPresent: Boolean(webView),
        webViewInitParamsPresent,
        webViewInitDataPresent,
        telegramWebviewProxyPresent:
            typeof win?.TelegramWebviewProxy?.postEvent === "function",
        webViewPostEventPresent:
            typeof webView?.postEvent === "function",
        openTelegramLinkPresent:
            typeof webApp?.openTelegramLink === "function",
        sessionStorageInitParamsPresent: hasTelegramSessionStorageInitParams()
    };

}

/**
 * Telegram Android can expose the WebApp object before its raw initData is
 * populated. Wait briefly for the authoritative initData before the first
 * socket connection so CREATE_ROOM does not start with an unauthenticated
 * socket. The Telegram launch-data URL fallback also works when the SDK
 * object is temporarily unavailable.
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
