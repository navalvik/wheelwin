/**
 * R6.11C — TonConnect client forensic capture store.
 *
 * Diagnostics only. Persists handshake timeline / errors / wallet events into
 * `window.__TONCONNECT_AUTOPSY__` for Developer Console export.
 * Does not alter TonConnect flow, server logic, or game state.
 */

const AUTOPSY_KEY = "__TONCONNECT_AUTOPSY__";

const ERROR_PROPERTY_CANDIDATES = Object.freeze([
    "name",
    "message",
    "code",
    "cause",
    "stack",
    "type",
    "status",
    "reason",
    "wallet",
    "provider",
    "bridge",
    "url",
    "universalLink",
    "requestId",
    "eventId",
    "method",
    "payload",
    "response",
    "data",
    "details",
    "errorCode",
    "errorMessage",
    "info",
    "originalError"
]);

const FAILURE_STEPS = new Set([
    "ON_STATUS_CHANGE_ERROR",
    "MODAL_CLOSED_WITHOUT_WALLET",
    "CONNECTOR_CONNECT_SYNC_THROW",
    "CONNECTOR_CONNECT_PROMISE_REJECT",
    "OPEN_MODAL_EXCEPTION",
    "CONNECT_BLOCKED",
    "REPORT_ABORTED",
    "DISCONNECT_EXCEPTION",
    "CALLBACK_EXCEPTION",
    "UNHANDLED_REJECTION",
    "WINDOW_ONERROR"
]);

function createEmptyAutopsy(sessionId = null) {

    const startedAt = new Date().toISOString();

    return {
        sessionId: sessionId
            ?? `tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        startedAt,
        lastSuccessfulStep: null,
        failureStep: null,
        timeline: [],
        sdkErrors: [],
        walletEvents: [],
        browserErrors: [],
        rawObjects: []
    };

}

function getWindowStore() {

    if (typeof window === "undefined") {

        return null;

    }

    return window;

}

/**
 * Safe JSON stringify for forensic dumps (circular / Error / bigint / fn).
 */
export function safeJsonStringifyForAutopsy(value) {

    const seen = new WeakSet();

    try {

        return JSON.stringify(
            value,
            (key, current) => {

                if (typeof current === "bigint") {

                    return String(current);

                }

                if (typeof current === "object" && current !== null) {

                    if (seen.has(current)) {

                        return "[Circular]";

                    }

                    seen.add(current);

                    if (current instanceof Error) {

                        const names = Object.getOwnPropertyNames(current);
                        const mapped = {};

                        for (const name of names) {

                            mapped[name] = current[name];

                        }

                        return mapped;

                    }

                }

                if (typeof current === "function") {

                    return `[Function ${current.name || "anonymous"}]`;

                }

                return current;

            },
            2
        );

    } catch (stringifyError) {

        return `[JSON.stringify failed: ${
            stringifyError?.message ?? String(stringifyError)
        }]`;

    }

}

/**
 * Serialize any thrown / rejection value for sdkErrors[].
 * Shape: { name, message, code, stack, constructor, keys, raw }
 */
export function captureErrorForensic(error) {

    if (error == null) {

        return {
            name: null,
            message: String(error),
            code: null,
            stack: null,
            constructor: null,
            keys: [],
            raw: error
        };

    }

    let keys = [];
    let constructorName = null;
    let rawSnapshot = null;

    if (typeof error === "object" || typeof error === "function") {

        try {

            keys = Object.getOwnPropertyNames(error);

        } catch {

            try {

                keys = Object.keys(error);

            } catch {

                keys = [];

            }

        }

        constructorName = error?.constructor?.name ?? null;

        try {

            rawSnapshot = JSON.parse(safeJsonStringifyForAutopsy(error));

        } catch {

            rawSnapshot = {
                stringified: String(error),
                keys
            };

        }

    } else {

        rawSnapshot = error;

    }

    return {
        name: error?.name ?? null,
        message: error?.message ?? String(error),
        code: error?.code ?? error?.errorCode ?? null,
        stack: typeof error?.stack === "string" ? error.stack : null,
        constructor: constructorName,
        keys,
        raw: rawSnapshot
    };

}

/**
 * Wallet connection summary for success / error walletEvents[].
 */
export function summarizeWalletConnection(wallet) {

    if (!wallet) {

        return {
            walletName: null,
            appName: null,
            device: null,
            platform: null,
            accountPresent: false,
            chain: null,
            publicKey: null,
            address: null,
            provider: null
        };

    }

    return {
        walletName: wallet.name ?? wallet.device?.appName ?? null,
        appName: wallet.device?.appName ?? wallet.appName ?? null,
        device: wallet.device
            ? {
                platform: wallet.device.platform ?? null,
                appName: wallet.device.appName ?? null,
                appVersion: wallet.device.appVersion ?? null,
                maxProtocolVersion: wallet.device.maxProtocolVersion ?? null
            }
            : null,
        platform: wallet.device?.platform ?? null,
        accountPresent: Boolean(wallet.account?.address),
        chain: wallet.account?.chain ?? null,
        publicKey: wallet.account?.publicKey ?? null,
        address: wallet.account?.address ?? null,
        provider: wallet.provider ?? null
    };

}

export function isTonConnectFailureStep(step) {

    if (!step || typeof step !== "string") {

        return false;

    }

    if (FAILURE_STEPS.has(step)) {

        return true;

    }

    return /ERROR|EXCEPTION|REJECT|FAIL/i.test(step);

}

export function classifyTonConnectErrorOrigin(error, contextLabel = "") {

    const label = String(contextLabel || "");
    const stack = typeof error?.stack === "string" ? error.stack : "";
    const message = String(error?.message ?? error ?? "");
    const name = String(error?.name ?? "");
    const haystack = `${label}\n${name}\n${message}\n${stack}`.toLowerCase();

    if (
        /callback_exception|custom callback|page4payment callback/i.test(label)
    ) {

        return "Generated inside custom callback";

    }

    if (/onstatuschange/i.test(label) || /onstatuschange/i.test(haystack)) {

        return "Generated inside onStatusChange()";

    }

    if (
        /connector\.connect/i.test(label)
        || /connector\.connect/i.test(haystack)
    ) {

        return "Generated inside connector.connect()";

    }

    if (
        /@tonconnect\/ui|tonconnectui|ton-connect-ui|tonconnect-ui/i.test(haystack)
        || /tonconnectui/i.test(label)
        || /openmodal/i.test(label)
    ) {

        return "Generated by TonConnectUI";

    }

    if (
        /@tonconnect\/sdk|ton_connect_sdk|tonconnectsdk|ton-connect/i.test(haystack)
        || /userrejectserror|tonconnecterror|bridge.*error/i.test(haystack)
    ) {

        return "Generated by TonConnect SDK";

    }

    if (
        /page4payment|handleconnectwallet|reportconnectedwallet/i.test(haystack)
        || /page4/i.test(label)
    ) {

        return "Generated inside Page4Payment";

    }

    if (
        /wallet|gram|telegram-wallet|user.?reject|rejected by user/i.test(haystack)
        || error?.wallet != null
        || error?.provider != null
    ) {

        return "Generated by wallet";

    }

    if (
        /script error|resizeobserver|networkerror|typeerror|referenceerror/i.test(
            haystack
        )
        || /window\.onerror|unhandledrejection|browser/i.test(label)
    ) {

        return "Generated by browser";

    }

    return "Origin could not be determined.";

}

function summarizePayload(payload) {

    if (payload == null) {

        return null;

    }

    if (typeof payload !== "object") {

        const text = String(payload);

        return text.length > 240 ? `${text.slice(0, 240)}…` : text;

    }

    try {

        const json = safeJsonStringifyForAutopsy(payload);
        const parsed = JSON.parse(json);

        if (typeof parsed === "object" && parsed !== null) {

            const keys = Object.keys(parsed).slice(0, 24);
            const summary = {};

            for (const key of keys) {

                const value = parsed[key];

                if (
                    value != null
                    && typeof value === "object"
                    && !Array.isArray(value)
                ) {

                    summary[key] = `{${Object.keys(value).slice(0, 8).join(",")}}`;

                } else if (typeof value === "string" && value.length > 120) {

                    summary[key] = `${value.slice(0, 120)}…`;

                } else {

                    summary[key] = value;

                }

            }

            return summary;

        }

        return parsed;

    } catch {

        return { note: "payloadSummary unavailable" };

    }

}

function mapStepToStage(step) {

    const s = String(step || "");

    if (/OPEN_MODAL|CONNECT_BUTTON|CONNECT_BLOCKED/i.test(s)) {

        return "openModal";

    }

    if (/QR|UNIVERSAL_LINK|CONNECTOR_CONNECT/i.test(s)) {

        return "qrOrLink";

    }

    if (/MODAL_/i.test(s)) {

        return "modal";

    }

    if (/ON_STATUS_CHANGE|SDK_EVENT|STATUS/i.test(s)) {

        return "onStatusChange";

    }

    if (/UNHANDLED|WINDOW_ONERROR|BROWSER/i.test(s)) {

        return "browser";

    }

    if (/REPORT|SOCKET|WALLET_CONNECT/i.test(s)) {

        return "report";

    }

    if (/DISCONNECT/i.test(s)) {

        return "disconnect";

    }

    return "handshake";

}

/**
 * Ensure `window.__TONCONNECT_AUTOPSY__` exists and return it.
 */
export function ensureTonConnectAutopsy(meta = {}) {

    const win = getWindowStore();

    if (!win) {

        return createEmptyAutopsy(meta.sessionId ?? null);

    }

    if (!win[AUTOPSY_KEY] || typeof win[AUTOPSY_KEY] !== "object") {

        win[AUTOPSY_KEY] = createEmptyAutopsy(meta.sessionId ?? null);

    }

    if (meta.roomId != null) {

        win[AUTOPSY_KEY].roomId = meta.roomId;

    }

    if (meta.playerId != null) {

        win[AUTOPSY_KEY].playerId = meta.playerId;

    }

    return win[AUTOPSY_KEY];

}

/**
 * Start a new forensic session (one connect attempt). Keeps prior data in
 * `previousSessions` so export can include history if needed.
 */
export function beginTonConnectAutopsySession(meta = {}) {

    const win = getWindowStore();
    const previous = win?.[AUTOPSY_KEY] ?? null;
    const next = createEmptyAutopsy(meta.sessionId ?? null);

    if (meta.roomId != null) {

        next.roomId = meta.roomId;

    }

    if (meta.playerId != null) {

        next.playerId = meta.playerId;

    }

    if (meta.attemptId != null) {

        next.attemptId = meta.attemptId;

    }

    if (previous && Array.isArray(previous.timeline) && previous.timeline.length > 0) {

        next.previousSessions = Array.isArray(previous.previousSessions)
            ? [...previous.previousSessions, {
                sessionId: previous.sessionId,
                startedAt: previous.startedAt,
                lastSuccessfulStep: previous.lastSuccessfulStep,
                failureStep: previous.failureStep,
                timelineCount: previous.timeline.length,
                sdkErrorCount: previous.sdkErrors?.length ?? 0,
                browserErrorCount: previous.browserErrors?.length ?? 0
            }].slice(-8)
            : [{
                sessionId: previous.sessionId,
                startedAt: previous.startedAt,
                lastSuccessfulStep: previous.lastSuccessfulStep,
                failureStep: previous.failureStep,
                timelineCount: previous.timeline.length,
                sdkErrorCount: previous.sdkErrors?.length ?? 0,
                browserErrorCount: previous.browserErrors?.length ?? 0
            }];

    }

    if (win) {

        win[AUTOPSY_KEY] = next;

    }

    return next;

}

export function getTonConnectAutopsy() {

    const win = getWindowStore();

    if (!win?.[AUTOPSY_KEY]) {

        return null;

    }

    return win[AUTOPSY_KEY];

}

export function pushAutopsyTimeline({
    event,
    stage = null,
    payloadSummary = null,
    step = null
} = {}) {

    const store = ensureTonConnectAutopsy();
    const resolvedEvent = event ?? step ?? "unknown";
    const resolvedStage = stage ?? mapStepToStage(resolvedEvent);

    const entry = {
        timestamp: new Date().toISOString(),
        event: resolvedEvent,
        stage: resolvedStage,
        payloadSummary: summarizePayload(payloadSummary)
    };

    store.timeline.push(entry);

    if (isTonConnectFailureStep(resolvedEvent)) {

        if (!store.failureStep) {

            store.failureStep = resolvedEvent;

        }

    } else {

        store.lastSuccessfulStep = resolvedEvent;

    }

    return entry;

}

export function pushAutopsySdkError(error, context = {}) {

    const store = ensureTonConnectAutopsy();
    const forensic = captureErrorForensic(error);

    const entry = {
        timestamp: new Date().toISOString(),
        label: context.label ?? null,
        origin: context.origin
            ?? classifyTonConnectErrorOrigin(error, context.label ?? ""),
        ...forensic,
        context: summarizePayload(context)
    };

    store.sdkErrors.push(entry);

    pushAutopsyRawObject({
        kind: "sdkError",
        label: context.label ?? null,
        value: forensic.raw
    });

    return entry;

}

export function pushAutopsyWalletEvent({
    status = "unknown",
    wallet = null,
    error = null,
    detail = null
} = {}) {

    const store = ensureTonConnectAutopsy();

    const entry = {
        timestamp: new Date().toISOString(),
        status,
        wallet: summarizeWalletConnection(wallet),
        error: error != null ? captureErrorForensic(error) : null,
        detail: summarizePayload(detail)
    };

    store.walletEvents.push(entry);

    return entry;

}

/**
 * Persist browser onerror / unhandledrejection into autopsy store.
 * Coordinates with R6.11B temporary handlers.
 */
export function pushAutopsyBrowserError({
    message = null,
    source = null,
    stack = null,
    reason = null,
    lineno = null,
    colno = null,
    kind = "unknown"
} = {}) {

    const store = ensureTonConnectAutopsy();

    const entry = {
        timestamp: new Date().toISOString(),
        kind,
        message: message != null ? String(message) : null,
        source: source != null ? String(source) : null,
        stack: stack != null ? String(stack) : null,
        reason: reason != null
            ? (
                typeof reason === "object"
                    ? summarizePayload(reason)
                    : String(reason)
            )
            : null,
        lineno: lineno ?? null,
        colno: colno ?? null
    };

    store.browserErrors.push(entry);

    return entry;

}

export function pushAutopsyRawObject({ kind = "raw", label = null, value = null } = {}) {

    const store = ensureTonConnectAutopsy();

    let snapshot;

    try {

        snapshot = JSON.parse(safeJsonStringifyForAutopsy(value));

    } catch {

        snapshot = { stringified: String(value) };

    }

    const entry = {
        timestamp: new Date().toISOString(),
        kind,
        label,
        value: snapshot
    };

    store.rawObjects.push(entry);

    // Cap growth so a long session stays exportable.
    if (store.rawObjects.length > 80) {

        store.rawObjects.splice(0, store.rawObjects.length - 80);

    }

    return entry;

}

export function setAutopsyFailureStep(step) {

    const store = ensureTonConnectAutopsy();

    if (step && !store.failureStep) {

        store.failureStep = step;

    }

    return store;

}

export function syncAutopsyFromReport(report = {}) {

    const store = ensureTonConnectAutopsy();

    if (report.lastSuccessfulStep != null) {

        store.lastSuccessfulStep = report.lastSuccessfulStep;

    }

    if (report.failureStep != null) {

        store.failureStep = report.failureStep;

    }

    if (report.rawObject != null) {

        pushAutopsyRawObject({
            kind: "autopsyReport",
            label: report.failureStep ?? report.reason ?? "report",
            value: {
                lastSuccessfulStep: report.lastSuccessfulStep ?? null,
                failureStep: report.failureStep ?? null,
                origin: report.origin ?? null,
                mostProbableFailurePoint: report.mostProbableFailurePoint ?? null,
                chronology: report.chronology ?? null
            }
        });

    }

    return store;

}

/**
 * Placeholder when no client capture has run yet (Developer Console export).
 */
export function getTonConnectAutopsyOrPlaceholder() {

    const existing = getTonConnectAutopsy();

    if (existing) {

        return existing;

    }

    return {
        sessionId: null,
        startedAt: null,
        lastSuccessfulStep: null,
        failureStep: null,
        timeline: [],
        sdkErrors: [],
        walletEvents: [],
        browserErrors: [],
        rawObjects: [],
        note: "No TonConnect autopsy capture in this browser tab yet. Open Page4 and attempt a wallet connection to populate window.__TONCONNECT_AUTOPSY__."
    };

}

export function downloadTonConnectAutopsyJson() {

    if (typeof document === "undefined") {

        return false;

    }

    const payload = getTonConnectAutopsyOrPlaceholder();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const session = payload.sessionId
        ? String(payload.sessionId).slice(0, 24)
        : "none";
    const filename = `tonconnect_autopsy_${session}_${stamp}.json`;

    const envelope = {
        exportedAt: new Date().toISOString(),
        source: "window.__TONCONNECT_AUTOPSY__",
        autopsy: payload
    };

    const blob = new Blob(
        [JSON.stringify(envelope, null, 2)],
        { type: "application/json" }
    );

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);

    return true;

}

export {
    AUTOPSY_KEY,
    ERROR_PROPERTY_CANDIDATES,
    FAILURE_STEPS
};
