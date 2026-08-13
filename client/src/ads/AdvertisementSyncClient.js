/**
 * R14.5 — AdvertisementSyncClient
 * Receives server-authoritative advertisement snapshots only.
 * Does NOT select, rotate, or time advertisements independently.
 */

import { APP_PAGES } from "../game/sessionRecovery/recoveryFlow";
import { buildAdvertisementClickPath } from "./openAdvertisementDestination";

export const ADVERTISEMENT_MESSAGE_CHANNEL = "advertisement:message";

export const ADVERTISEMENT_SOCKET_EVENTS = Object.freeze({
    ADVERTISEMENT_CHANGED: "ADVERTISEMENT_CHANGED",
    ADVERTISEMENT_SYNC_REQUEST: "ADVERTISEMENT_SYNC_REQUEST",
    ADVERTISEMENT_SYNC_RESPONSE: "ADVERTISEMENT_SYNC_RESPONSE"
});

export const ADVERTISEMENT_MESSAGE_TYPES = Object.freeze({
    CURRENT_AD: "CURRENT_AD",
    CURRENT_AD_CHANGED: "CURRENT_AD_CHANGED",
    ADVERTISEMENT_CHANGED: "ADVERTISEMENT_CHANGED",
    ADVERTISEMENT_SYNC_REQUEST: "ADVERTISEMENT_SYNC_REQUEST",
    ADVERTISEMENT_SYNC_RESPONSE: "ADVERTISEMENT_SYNC_RESPONSE"
});

/** Pages that may show external (paid) advertisements. */
export const EXTERNAL_ADVERTISEMENT_PAGES = Object.freeze([
    APP_PAGES.WELCOME,
    APP_PAGES.LOBBY,
    APP_PAGES.RESULT
]);

/** Pages that must always show the WheelWin brand banner. */
export const BRAND_ONLY_ADVERTISEMENT_PAGES = Object.freeze([
    APP_PAGES.PLAYER_SETUP,
    APP_PAGES.MATRIX,
    APP_PAGES.VERIFY,
    APP_PAGES.PAYMENT,
    APP_PAGES.GAMEPLAY
]);

export const WHEELWIN_FALLBACK_BANNER_SRC = "/banner.jpg";

export const ADVERTISEMENT_ASSET_URL_PREFIX = "/advertisements/assets";

export function isExternalAdvertisementPage(page) {

    return EXTERNAL_ADVERTISEMENT_PAGES.includes(page);

}

export function isBrandOnlyAdvertisementPage(page) {

    return BRAND_ONLY_ADVERTISEMENT_PAGES.includes(page);

}

export function buildAdvertisementAssetUrl(filename) {

    if (typeof filename !== "string" || !filename.trim()) {

        return null;

    }

    const name = filename.trim();

    if (
        name.includes("..")
        || name.includes("/")
        || name.includes("\\")
        || name.includes("\0")
    ) {

        return null;

    }

    return `${ADVERTISEMENT_ASSET_URL_PREFIX}/${encodeURIComponent(name)}`;

}

/**
 * Remaining ms from server startedAt + duration (no client rotation timer).
 */
export function calculateRemainingMsFromSnapshot(snapshot, nowMs = Date.now()) {

    if (!snapshot) {

        return 0;

    }

    if (Number.isFinite(Number(snapshot.remainingMs))
        && snapshot.startedAt == null) {

        return Math.max(0, Number(snapshot.remainingMs));

    }

    const startedAt = Number(snapshot.startedAt);
    const duration = Number(snapshot.duration);

    if (!Number.isFinite(startedAt) || !Number.isFinite(duration)) {

        return Number.isFinite(Number(snapshot.remainingMs))
            ? Math.max(0, Number(snapshot.remainingMs))
            : 0;

    }

    return Math.max(0, startedAt + (duration * 1000) - Number(nowMs));

}

/**
 * Pure render model — never picks the "next" advertisement.
 */
export function resolveAdvertisementRenderModel({
    page,
    snapshot = null,
    imageFailed = false
} = {}) {

    const allowExternal = isExternalAdvertisementPage(page);
    const hasAd = Boolean(
        snapshot?.advertisementId
        && snapshot?.filename
        && !imageFailed
    );

    if (!allowExternal || !hasAd) {

        return Object.freeze({
            mode: "fallback",
            src: WHEELWIN_FALLBACK_BANNER_SRC,
            alt: "WheelWin Banner",
            destinationUrl: null,
            clickable: false,
            objectFit: "contain",
            advertisementId: null,
            filename: null,
            remainingMs: 0
        });

    }

    const src = buildAdvertisementAssetUrl(snapshot.filename)
        ?? WHEELWIN_FALLBACK_BANNER_SRC;

    // R14.6 — never expose advertiser destinationUrl to the client click path.
    const destinationUrl = buildAdvertisementClickPath(snapshot.advertisementId);

    return Object.freeze({
        mode: src === WHEELWIN_FALLBACK_BANNER_SRC ? "fallback" : "external",
        src,
        alt: snapshot.advertiserName
            ? String(snapshot.advertiserName)
            : "Advertisement",
        destinationUrl,
        clickable: Boolean(destinationUrl),
        objectFit: "contain",
        advertisementId: snapshot.advertisementId,
        filename: snapshot.filename,
        remainingMs: calculateRemainingMsFromSnapshot(snapshot)
    });

}

function extractSnapshot(message) {

    if (!message || typeof message !== "object") {

        return null;

    }

    // Envelope: { type, payload, sentAt }
    if (message.payload && typeof message.payload === "object") {

        if (message.payload.snapshot
            && typeof message.payload.snapshot === "object") {

            return message.payload.snapshot;

        }

        return message.payload;

    }

    // Bare snapshot
    if (message.advertisementId != null || message.filename != null) {

        return message;

    }

    return null;

}

function isAdvertisementEnvelope(message) {

    const type = message?.type;

    return type === ADVERTISEMENT_MESSAGE_TYPES.ADVERTISEMENT_CHANGED
        || type === ADVERTISEMENT_MESSAGE_TYPES.CURRENT_AD
        || type === ADVERTISEMENT_MESSAGE_TYPES.CURRENT_AD_CHANGED
        || type === ADVERTISEMENT_MESSAGE_TYPES.ADVERTISEMENT_SYNC_RESPONSE;

}

export class AdvertisementSyncClient {

    constructor() {

        this._socket = null;
        this._bound = false;
        this._snapshot = null;
        this._listeners = new Set();
        this._handleMessage = this._handleMessage.bind(this);
        this._handleConnect = this._handleConnect.bind(this);

    }

    getSnapshot() {

        return this._snapshot;

    }

    /**
     * Subscribe to snapshot updates. Returns unsubscribe.
     */
    subscribe(listener) {

        if (typeof listener !== "function") {

            return () => {};

        }

        this._listeners.add(listener);

        return () => {

            this._listeners.delete(listener);

        };

    }

    /**
     * Idempotent attach to the shared Socket.IO client (no new connection).
     */
    ensureAttached(socket) {

        if (!socket) {

            return this;

        }

        if (this._bound && this._socket === socket) {

            return this;

        }

        this.detach();

        this._socket = socket;
        this._bound = true;

        socket.on(ADVERTISEMENT_MESSAGE_CHANNEL, this._handleMessage);
        socket.on(
            ADVERTISEMENT_SOCKET_EVENTS.ADVERTISEMENT_CHANGED,
            this._handleMessage
        );
        socket.on(
            ADVERTISEMENT_SOCKET_EVENTS.ADVERTISEMENT_SYNC_RESPONSE,
            this._handleMessage
        );
        socket.on("connect", this._handleConnect);

        if (socket.connected) {

            this.requestSync();

        }

        return this;

    }

    detach() {

        if (!this._socket || !this._bound) {

            this._socket = null;
            this._bound = false;

            return;

        }

        this._socket.off(ADVERTISEMENT_MESSAGE_CHANNEL, this._handleMessage);
        this._socket.off(
            ADVERTISEMENT_SOCKET_EVENTS.ADVERTISEMENT_CHANGED,
            this._handleMessage
        );
        this._socket.off(
            ADVERTISEMENT_SOCKET_EVENTS.ADVERTISEMENT_SYNC_RESPONSE,
            this._handleMessage
        );
        this._socket.off("connect", this._handleConnect);

        this._socket = null;
        this._bound = false;

    }

    requestSync() {

        if (!this._socket?.connected) {

            return false;

        }

        try {

            this._socket.emit(
                ADVERTISEMENT_SOCKET_EVENTS.ADVERTISEMENT_SYNC_REQUEST
            );
            this._socket.emit(ADVERTISEMENT_MESSAGE_CHANNEL, {
                type: ADVERTISEMENT_MESSAGE_TYPES.ADVERTISEMENT_SYNC_REQUEST,
                payload: null,
                sentAt: Date.now()
            });

            return true;

        } catch {

            return false;

        }

    }

    /**
     * Apply a server snapshot (tests / manual inject). Never selects next ad.
     */
    applyServerSnapshot(snapshot) {

        this._snapshot = snapshot && typeof snapshot === "object"
            ? snapshot
            : null;
        this._notify();

        return this._snapshot;

    }

    clearSnapshot() {

        this._snapshot = null;
        this._notify();

    }

    _handleConnect() {

        this.requestSync();

    }

    _handleMessage(message) {

        try {

            if (message?.type && !isAdvertisementEnvelope(message)) {

                return;

            }

            const snapshot = extractSnapshot(message);

            // Empty / null ad is a valid authoritative state → fallback on UI.
            if (snapshot == null) {

                return;

            }

            if (!snapshot.advertisementId && !snapshot.filename) {

                this._snapshot = null;
                this._notify();

                return;

            }

            this._snapshot = snapshot;
            this._notify();

        } catch {

            // Advertising failures must never break the app.

        }

    }

    _notify() {

        for (const listener of this._listeners) {

            try {

                listener(this._snapshot);

            } catch {

                // Ignore listener errors.

            }

        }

    }

}

let sharedClient = null;

export function getAdvertisementSyncClient() {

    if (!sharedClient) {

        sharedClient = new AdvertisementSyncClient();

    }

    return sharedClient;

}

/** Test helper */
export function resetAdvertisementSyncClientForTests() {

    if (sharedClient) {

        sharedClient.detach();
        sharedClient.clearSnapshot();

    }

    sharedClient = null;

}
