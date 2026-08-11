/**
 * R12.5G — Sanitize untrusted client Page6 diagnostic payloads (server).
 * Observation metadata only. Never used for gameplay decisions.
 */

export const PAGE6_CLIENT_DIAG_VERSION = "R12.5G";

export const PAGE6_CLIENT_DIAG_SOURCE = "client";

const SENSITIVE_KEYS = new Set([
    "wallet",
    "mnemonic",
    "privateKey",
    "token",
    "accessToken",
    "refreshToken",
    "qr",
    "qrCode",
    "boc",
    "secret"
]);

export function sanitizeIncomingPage6ClientDiag(raw = {}, {
    socketId = null,
    boundRoomId = null,
    boundPlayerId = null,
    boundGameId = null
} = {}) {

    const fields = sanitizeLooseFields(raw);

    return {
        diagnosticSource: PAGE6_CLIENT_DIAG_SOURCE,
        diagnosticVersion: PAGE6_CLIENT_DIAG_VERSION,
        event: typeof raw?.event === "string" ? raw.event : null,
        roomId: pickId(raw?.roomId, boundRoomId),
        gameId: pickId(raw?.gameId, boundGameId),
        playerId: pickId(raw?.playerId, boundPlayerId),
        socketId: socketId ?? (typeof raw?.socketId === "string" ? raw.socketId : null),
        clientType: raw?.clientType === "web" || raw?.clientType === "telegram"
            ? raw.clientType
            : "unknown",
        currentPage: fields.currentPage ?? null,
        currentPageType: fields.currentPageType ?? null,
        timestamp: Number.isFinite(raw?.timestamp) ? raw.timestamp : Date.now(),
        socketConnected: raw?.socketConnected === true
            ? true
            : (raw?.socketConnected === false ? false : null),
        visibilityState: typeof raw?.visibilityState === "string"
            ? raw.visibilityState
            : null,
        page6DomPresent: normalizeBoolOrNull(raw?.page6DomPresent),
        page6DomVisible: normalizeBoolOrNull(raw?.page6DomVisible),
        page6HeadlineText: clipString(raw?.page6HeadlineText, 200),
        headerMessageText: clipString(raw?.headerMessageText, 200),
        infoBarPresent: normalizeBoolOrNull(raw?.infoBarPresent),
        infoBarText: clipString(raw?.infoBarText, 400),
        infoBarTimerLabelText: clipString(raw?.infoBarTimerLabelText, 80),
        infoBarTimerValueText: clipString(raw?.infoBarTimerValueText, 40),
        footerMode: clipString(raw?.footerMode, 80),
        timerLabel: clipString(
            raw?.timerLabel ?? raw?.selectedLabel,
            80
        ),
        timerValue: clipString(
            raw?.timerValue ?? raw?.selectedValue,
            40
        ),
        resultSessionExpiresAt: Number.isFinite(raw?.resultSessionExpiresAt)
            ? raw.resultSessionExpiresAt
            : null,
        remainingResultSessionSeconds: Number.isFinite(raw?.remainingResultSessionSeconds)
            ? raw.remainingResultSessionSeconds
            : null,
        combination: clipString(raw?.combination, 80),
        page6Mounted: normalizeBoolOrNull(raw?.page6Mounted),
        openPage6: normalizeBoolOrNull(raw?.openPage6),
        recoveryDecision: raw?.recoveryDecision ?? null,
        navigationTarget: raw?.navigationTarget ?? null,
        source: clipString(raw?.source, 120),
        reason: clipString(raw?.reason, 120)
    };

}

function sanitizeLooseFields(fields = {}) {

    const out = {};

    for (const [key, value] of Object.entries(fields ?? {})) {

        if (value === undefined || SENSITIVE_KEYS.has(key)) {

            continue;

        }

        if (typeof value === "number" && !Number.isFinite(value)) {

            out[key] = null;

            continue;

        }

        out[key] = value;

    }

    return out;

}

function pickId(primary, fallback) {

    if (typeof primary === "string" || typeof primary === "number") {

        return primary;

    }

    if (typeof fallback === "string" || typeof fallback === "number") {

        return fallback;

    }

    return null;

}

function normalizeBoolOrNull(value) {

    if (value === true) {

        return true;

    }

    if (value === false) {

        return false;

    }

    return null;

}

function clipString(value, max) {

    if (typeof value !== "string") {

        return null;

    }

    return value.slice(0, max);

}
