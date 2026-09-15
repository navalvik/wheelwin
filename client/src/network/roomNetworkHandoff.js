/**
 * R24 — Client-side consumption of the R22 cross-runtime room network
 * handoff (Testnet RoomLobby → Mainnet RoomLobby).
 *
 * Architecture:
 * - The R22 server delivers `roomNetworkHandoffReady` ONLY to the verified
 *   Room Owner's authenticated socket. The client never validates ownership;
 *   it only performs minimal shape validation before persisting/launching.
 * - The opaque handoffId is the ONLY value that crosses the runtime
 *   transition. Testnet and Mainnet are different origins, so Web Storage
 *   cannot survive the navigation. The Telegram `startapp` start_param is
 *   the established cross-runtime carrier; sessionStorage covers
 *   same-origin reload/retry only.
 * - start_param is read as TRANSPORT ONLY (it is the value this client
 *   itself placed in the deep link). It is never used as identity. Telegram
 *   identity always comes from the fresh, server-validated initData of the
 *   Mainnet Mini App session (socket handshake auth) — exactly as before.
 * - No Telegram identity, initData, wallet secrets, player credentials,
 *   socket ids or room state are ever stored or forwarded by this module.
 */

const STORAGE_KEY = "wheelwin.roomNetworkHandoff";

const MAINNET_MINI_APP_DEEP_LINK_BASE = "https://t.me/wheel_win_bot?startapp=";

const MAINNET_START_PARAM_PREFIX = "mainnet";

const MAINNET_WEB_URL = "https://wheelwin-main.vercel.app";

/** base64url handoffId shape (R22 store: 24 random bytes → 32 chars). */
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Minimal client-side validation of the R22 Owner-only event payload.
 * The client does NOT validate ownership — the server is authoritative.
 * Returns the normalized handoff record, or null when the payload is not a
 * usable MAINNET continuation (including an already-expired handoff).
 */
export function validateHandoffReadyPayload(payload, nowMs = Date.now()) {

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {

        return null;

    }

    const handoffId = typeof payload.handoffId === "string"
        ? payload.handoffId.trim()
        : "";

    if (!HANDOFF_ID_PATTERN.test(handoffId)) {

        return null;

    }

    if (payload.targetNetwork !== "mainnet") {

        return null;

    }

    const expiresAt = typeof payload.expiresAt === "number"
        && Number.isFinite(payload.expiresAt)
        ? payload.expiresAt
        : null;

    if (!expiresAt || expiresAt <= nowMs) {

        // An expired (or expiry-less) handoff must never be stored or
        // submitted to Mainnet.
        return null;

    }

    return {
        handoffId,
        targetNetwork: "mainnet",
        expiresAt
    };

}

/**
 * Narrowly scoped temporary handoff persistence (same-origin reload/retry
 * only). Stores the MINIMUM fields: handoffId, targetNetwork, expiresAt.
 * Never stores Telegram identity, initData, wallet secrets, player
 * credentials, socket ids or any Testnet room state.
 */
export function storeHandoff(handoff, storage = safeSessionStorage()) {

    if (
        !handoff
        || typeof handoff !== "object"
        || !HANDOFF_ID_PATTERN.test(String(handoff.handoffId ?? ""))
        || handoff.targetNetwork !== "mainnet"
    ) {

        return false;

    }

    try {

        storage.setItem(STORAGE_KEY, JSON.stringify({
            handoffId: handoff.handoffId,
            targetNetwork: handoff.targetNetwork ?? "mainnet",
            expiresAt: handoff.expiresAt ?? null
        }));

        return true;

    } catch {

        // Storage may be unavailable (private mode); the deep-link startapp
        // carrier remains the primary cross-runtime transport.
        return false;

    }

}

export function readHandoff(storage = safeSessionStorage()) {

    try {

        const raw = storage.getItem(STORAGE_KEY);

        if (!raw) {

            return null;

        }

        const parsed = JSON.parse(raw);

        if (
            !parsed
            || typeof parsed !== "object"
            || !HANDOFF_ID_PATTERN.test(String(parsed.handoffId ?? ""))
            || parsed.targetNetwork !== "mainnet"
        ) {

            return null;

        }

        return {
            handoffId: parsed.handoffId,
            targetNetwork: "mainnet",
            expiresAt: typeof parsed.expiresAt === "number"
                ? parsed.expiresAt
                : null
        };

    } catch {

        return null;

    }

}

export function clearHandoff(storage = safeSessionStorage()) {

    try {

        storage.removeItem(STORAGE_KEY);

    } catch {

        // Ignore storage failures — clearing is best-effort.

    }

}

/** True when the handoff carries an expiry that has passed. */
export function isHandoffExpired(handoff, nowMs = Date.now()) {

    return Boolean(
        handoff
            && typeof handoff.expiresAt === "number"
            && handoff.expiresAt <= nowMs
    );

}

/**
 * Mainnet Mini App deep link carrying ONLY the opaque handoffId as the
 * startapp value. Telegram limits startapp to 64 chars of A-Za-z0-9_- :
 * "mainnet" (7) + 32-char handoffId = 39 chars. No Telegram identity,
 * initData or any other field is ever appended.
 */
export function buildMainnetDeepLink(handoffId) {

    const id = String(handoffId ?? "");

    if (!HANDOFF_ID_PATTERN.test(id)) {

        return null;

    }

    return `${MAINNET_MINI_APP_DEEP_LINK_BASE}${MAINNET_START_PARAM_PREFIX}${id}`;

}

/**
 * Parse the startapp start_param back into the opaque handoffId.
 * Transport only — never identity. Values that are not exactly the
 * "mainnet" + handoffId shape (including the legacy plain "mainnet" launch
 * and any forged or foreign payload) yield null, so the Mainnet client
 * behaves as a normal direct-Mainnet session.
 */
export function readStartParamHandoff(startParam) {

    const raw = typeof startParam === "string" ? startParam : "";

    if (!raw.startsWith(MAINNET_START_PARAM_PREFIX)) {

        return null;

    }

    const handoffId = raw.slice(MAINNET_START_PARAM_PREFIX.length);

    if (!HANDOFF_ID_PATTERN.test(handoffId)) {

        return null;

    }

    return handoffId;

}

/**
 * Read the raw startapp start_param from the Telegram Mini App context.
 * ONLY start_param is read — initData/initDataUnsafe identity fields are
 * never parsed, stored or forwarded by this module.
 */
export function readMainnetStartParam(windowLike = globalThis.window) {

    try {

        const startParam =
            windowLike?.Telegram?.WebApp?.initDataUnsafe?.start_param;

        return typeof startParam === "string" ? startParam : null;

    } catch {

        return null;

    }

}

/**
 * Fresh Telegram authentication readiness for the Mainnet socket handshake.
 * The socket itself forwards `window.Telegram.WebApp.initData` (raw,
 * unmodified) exactly as established in socket.js — this is only a
 * client-side readiness signal so a handoff bootstrap is not submitted from
 * a context that cannot be authenticated.
 */
export function hasTelegramInitData(windowLike = globalThis.window) {

    const initData = windowLike?.Telegram?.WebApp?.initData;

    return typeof initData === "string" && initData.length > 0;

}

/**
 * R24 — launch the Mainnet runtime via the EXISTING R18-S109 mechanism:
 * Telegram-native openTelegramLink with the operator-confirmed deep link
 * (fresh Mini App session, fresh server-validated initData); plain-browser
 * fallback otherwise. The deep link carries ONLY the opaque handoffId. No
 * Testnet initData/tgWebAppData is ever forwarded, copied or reconstructed.
 */
export function launchMainnetMiniApp(
    windowLike = globalThis.window,
    handoffId = readHandoff()?.handoffId ?? null
) {

    if (typeof windowLike === "undefined" || windowLike === null) {

        return "none";

    }

    const openTelegramLink = windowLike?.Telegram?.WebApp?.openTelegramLink;

    if (typeof openTelegramLink === "function") {

        const deepLink = buildMainnetDeepLink(handoffId);

        if (deepLink) {

            openTelegramLink(deepLink);

            return "telegram";

        }

    }

    // Plain-browser fallback (same behavior as the R18 mechanism): the
    // Mainnet origin is opened without a handoff — bootstrap is impossible
    // there without fresh Telegram authentication, so no handoff material
    // is placed in the URL.
    try {

        windowLike.location.replace(MAINNET_WEB_URL);

    } catch {

        return "none";

    }

    return "browser";

}

/** Testnet runtime detection (mirrors the established HeaderBar logic). */
export function isTestnetRuntime(windowLike = globalThis.window) {

    if (typeof windowLike === "undefined" || windowLike === null) {

        return false;

    }

    const hostname = String(windowLike.location?.hostname ?? "")
        .toLowerCase();

    return hostname.includes("nine") || hostname.includes("testnet");

}

function safeSessionStorage() {

    try {

        return globalThis.window?.sessionStorage ?? null;

    } catch {

        return null;

    }

}
