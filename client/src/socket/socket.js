import { io } from "socket.io-client";

import { resolveBackendUrl } from "../config/backendUrl.js";

const SOCKET_URL = resolveBackendUrl();

/**
 * Resolve the raw Telegram WebApp initData at socket creation time.
 *
 * - Telegram Mini App: returns the raw `window.Telegram.WebApp.initData`
 *   string exactly as received (never parsed, never modified).
 * - Standard Web: returns an empty string when Telegram WebApp is
 *   unavailable or initData is empty.
 *
 * The server owns validation. The client never stores, logs, or transforms
 * this value — it only forwards it inside the Socket.IO handshake auth.
 */
export function resolveTelegramInitData() {

    const rawData = globalThis.window?.Telegram?.WebApp?.initData;

    return typeof rawData === "string" ? rawData : "";

}

const socket = io(SOCKET_URL, {

    auth: {
        telegramInitData: resolveTelegramInitData()
    },

    autoConnect: false,

    reconnection: true,

    reconnectionAttempts: Infinity,

    reconnectionDelay: 1000,

    reconnectionDelayMax: 5000

});

export default socket;
