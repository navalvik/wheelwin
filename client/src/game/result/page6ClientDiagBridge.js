/**
 * R12.5G — Client Page6 / InfoBar diagnostic bridge helpers (pure).
 * Observation only. Does not navigate or mutate gameplay state.
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

const DOM_SNAPSHOT_EVENTS = new Set([
    "PAGE6_RENDER_STATE",
    "PAGE6_UNMOUNT",
    "INFOBAR_STATE",
    "INFOBAR_FOOTER",
    "STATE_SPLIT_DETECTED",
    "PAGE_STATE_SOURCE"
]);

/**
 * Safe client runtime classification.
 * Telegram Mini App injects window.Telegram.WebApp.
 */
export function resolvePage6ClientType(globalObject = globalThis) {

    try {

        if (globalObject?.Telegram?.WebApp) {

            return "telegram";

        }

        if (typeof globalObject?.window !== "undefined" || globalObject?.document) {

            return "web";

        }

    } catch {

        return "unknown";

    }

    return "unknown";

}

export function shouldAttachPage6DomSnapshot(eventName) {

    return DOM_SNAPSHOT_EVENTS.has(String(eventName ?? ""));

}

/**
 * Observation-only DOM snapshot for Page6 / InfoBar correlation.
 * Returns null fields when document/selectors are unavailable.
 */
export function capturePage6DomSnapshot(documentRef = null) {

    const doc = documentRef
        ?? (typeof document !== "undefined" ? document : null);

    if (!doc || typeof doc.querySelector !== "function") {

        return {
            page6DomPresent: null,
            page6DomVisible: null,
            page6HeadlineText: null,
            headerMessageText: null,
            infoBarPresent: null,
            infoBarText: null,
            infoBarTimerLabelText: null,
            infoBarTimerValueText: null
        };

    }

    const page6 = doc.querySelector(".page6");

    const headline = doc.querySelector(".page6__headline");

    const headerCenter = doc.querySelector(".headerBar .center");

    const infoBar = doc.querySelector(".infoBar");

    const timerSection = infoBar
        ? infoBar.querySelector(".infoBarSection:last-child")
        : null;

    const timerLabel = timerSection
        ? timerSection.querySelector(".infoBarTitle")
        : null;

    const timerValue = timerSection
        ? timerSection.querySelector(".infoBarValue")
        : null;

    return {
        page6DomPresent: Boolean(page6),
        page6DomVisible: page6
            ? isElementVisible(page6)
            : false,
        page6HeadlineText: textOrNull(headline),
        headerMessageText: textOrNull(headerCenter),
        infoBarPresent: Boolean(infoBar),
        infoBarText: textOrNull(infoBar),
        infoBarTimerLabelText: textOrNull(timerLabel),
        infoBarTimerValueText: textOrNull(timerValue)
    };

}

function isElementVisible(element) {

    try {

        const style = typeof globalThis.getComputedStyle === "function"
            ? globalThis.getComputedStyle(element)
            : null;

        if (style) {

            if (style.display === "none" || style.visibility === "hidden") {

                return false;

            }

            if (Number(style.opacity) === 0) {

                return false;

            }

        }

        const rect = element.getBoundingClientRect?.();

        if (rect) {

            return rect.width > 0 && rect.height > 0;

        }

    } catch {

        return null;

    }

    return true;

}

function textOrNull(element) {

    if (!element) {

        return null;

    }

    const text = String(element.textContent ?? "").replace(/\s+/g, " ").trim();

    return text.length > 0 ? text : null;

}

/**
 * Build a sanitized, non-authoritative client diagnostic envelope.
 */
export function buildPage6ClientDiagPayload({
    event,
    fields = {},
    roomId = null,
    gameId = null,
    playerId = null,
    socketId = null,
    clientType = "unknown",
    socketConnected = null,
    visibilityState = null,
    includeDomSnapshot = false,
    documentRef = null,
    now = Date.now()
} = {}) {

    const sanitizedFields = sanitizeClientDiagFields(fields);

    const payload = {
        diagnosticSource: PAGE6_CLIENT_DIAG_SOURCE,
        diagnosticVersion: PAGE6_CLIENT_DIAG_VERSION,
        event: event ?? null,
        roomId: roomId ?? sanitizedFields.roomId ?? null,
        gameId: gameId ?? sanitizedFields.gameId ?? null,
        playerId: playerId ?? sanitizedFields.playerId ?? null,
        socketId: socketId ?? null,
        clientType: clientType ?? "unknown",
        currentPage: sanitizedFields.currentPage ?? null,
        currentPageType: sanitizedFields.currentPageType
            ?? (sanitizedFields.currentPage == null
                ? null
                : typeof sanitizedFields.currentPage),
        timestamp: Number.isFinite(sanitizedFields.ts)
            ? sanitizedFields.ts
            : now,
        socketConnected: socketConnected === true
            ? true
            : (socketConnected === false ? false : null),
        visibilityState: visibilityState ?? null,
        ...sanitizedFields
    };

    // Identity fields win over field spread duplicates.
    payload.diagnosticSource = PAGE6_CLIENT_DIAG_SOURCE;

    payload.diagnosticVersion = PAGE6_CLIENT_DIAG_VERSION;

    payload.event = event ?? null;

    payload.roomId = roomId ?? sanitizedFields.roomId ?? null;

    payload.gameId = gameId ?? sanitizedFields.gameId ?? null;

    payload.playerId = playerId ?? sanitizedFields.playerId ?? null;

    payload.socketId = socketId ?? null;

    payload.clientType = clientType ?? "unknown";

    if (includeDomSnapshot) {

        Object.assign(payload, capturePage6DomSnapshot(documentRef));

    }

    return payload;

}

export function sanitizeClientDiagFields(fields = {}) {

    const out = {};

    for (const [key, value] of Object.entries(fields ?? {})) {

        if (value === undefined) {

            continue;

        }

        if (SENSITIVE_KEYS.has(key)) {

            continue;

        }

        if (typeof value === "number" && !Number.isFinite(value)) {

            out[key] = null;

            continue;

        }

        if (typeof value === "object" && value !== null) {

            // Keep only plain JSON-safe scalars/arrays of scalars.
            try {

                out[key] = JSON.parse(JSON.stringify(value));

            } catch {

                out[key] = null;

            }

            continue;

        }

        out[key] = value;

    }

    return out;

}

/**
 * Server-side sanitize of untrusted client diagnostic payloads.
 */
export function sanitizeIncomingPage6ClientDiag(raw = {}, {
    socketId = null,
    boundRoomId = null,
    boundPlayerId = null,
    boundGameId = null
} = {}) {

    const fields = sanitizeClientDiagFields(raw);

    return {
        diagnosticSource: PAGE6_CLIENT_DIAG_SOURCE,
        diagnosticVersion: PAGE6_CLIENT_DIAG_VERSION,
        event: typeof raw?.event === "string" ? raw.event : null,
        roomId: typeof raw?.roomId === "string" || typeof raw?.roomId === "number"
            ? raw.roomId
            : (boundRoomId ?? null),
        gameId: typeof raw?.gameId === "string" || typeof raw?.gameId === "number"
            ? raw.gameId
            : (boundGameId ?? null),
        playerId: typeof raw?.playerId === "string" || typeof raw?.playerId === "number"
            ? raw.playerId
            : (boundPlayerId ?? null),
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
        page6HeadlineText: typeof raw?.page6HeadlineText === "string"
            ? raw.page6HeadlineText.slice(0, 200)
            : null,
        headerMessageText: typeof raw?.headerMessageText === "string"
            ? raw.headerMessageText.slice(0, 200)
            : null,
        infoBarPresent: normalizeBoolOrNull(raw?.infoBarPresent),
        infoBarText: typeof raw?.infoBarText === "string"
            ? raw.infoBarText.slice(0, 400)
            : null,
        infoBarTimerLabelText: typeof raw?.infoBarTimerLabelText === "string"
            ? raw.infoBarTimerLabelText.slice(0, 80)
            : null,
        infoBarTimerValueText: typeof raw?.infoBarTimerValueText === "string"
            ? raw.infoBarTimerValueText.slice(0, 40)
            : null,
        footerMode: typeof raw?.footerMode === "string" ? raw.footerMode : null,
        timerLabel: typeof raw?.timerLabel === "string"
            ? raw.timerLabel
            : (typeof raw?.selectedLabel === "string" ? raw.selectedLabel : null),
        timerValue: typeof raw?.timerValue === "string"
            ? raw.timerValue
            : (typeof raw?.selectedValue === "string" ? raw.selectedValue : null),
        resultSessionExpiresAt: Number.isFinite(raw?.resultSessionExpiresAt)
            ? raw.resultSessionExpiresAt
            : null,
        remainingResultSessionSeconds: Number.isFinite(raw?.remainingResultSessionSeconds)
            ? raw.remainingResultSessionSeconds
            : null,
        combination: typeof raw?.combination === "string" ? raw.combination : null,
        page6Mounted: normalizeBoolOrNull(raw?.page6Mounted),
        openPage6: normalizeBoolOrNull(raw?.openPage6),
        recoveryDecision: raw?.recoveryDecision ?? null,
        navigationTarget: raw?.navigationTarget ?? null,
        source: typeof raw?.source === "string" ? raw.source : null,
        reason: typeof raw?.reason === "string" ? raw.reason : null
    };

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
