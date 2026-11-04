const CLIENT_PAGES = new Set([
    "PAGE1_WELCOME",
    "ROOM_LOBBY",
    "PAGE2_PLAYER_SETUP",
    "PAGE_MATRIX",
    "PAGE3_VERIFY_PLAYERS",
    "PAGE4_PAYMENT",
    "PAGE5_GAME",
    "PAGE6_RESULT",
    "ENTRY_MODE",
    "NO_FRIENDS_QUEUE",
    "NO_FRIENDS_OPTIONS"
]);

const STALE_AFTER_MS = 90_000;

function safeUiState(raw) {
    const ui = raw?.uiState;
    if (!ui || typeof ui !== "object") return null;
    return Object.freeze({
        requestedPage: CLIENT_PAGES.has(ui.requestedPage) ? ui.requestedPage : null,
        appliedPage: CLIENT_PAGES.has(ui.appliedPage) ? ui.appliedPage : null,
        mounted: ui.mounted === true,
        visible: ui.visible === true,
        documentVisible: ui.documentVisible === true,
        topmostAtSample: ui.topmostAtSample === true,
        blockingUi: Array.isArray(ui.blockingUi)
            ? ui.blockingUi.filter((value) => typeof value === "string").slice(0, 8)
            : []
    });
}

/**
 * Read-only diagnostics projection of page confirmations. It has no gameplay
 * dependencies and never grants, delays, or rejects an authoritative action.
 */
export class ClientPageConfirmationRegistry {
    constructor({ logger = null, staleAfterMs = STALE_AFTER_MS } = {}) {
        this._logger = logger;
        this._staleAfterMs = staleAfterMs;
        this._players = new Map();
        this._authoritativeByRoom = new Map();
        this._socketKeys = new Map();
    }

    record({ identity, socketId, raw, receivedAt = Date.now() } = {}) {
        if (!identity?.roomId || !identity?.playerId || !socketId) {
            return { ok: false, reason: "IDENTITY_UNAVAILABLE" };
        }
        if (raw?.roomId && raw.roomId !== identity.roomId) {
            return { ok: false, reason: "ROOM_BINDING_MISMATCH" };
        }
        if (raw?.playerId && raw.playerId !== identity.playerId) {
            return { ok: false, reason: "PLAYER_BINDING_MISMATCH" };
        }
        if (raw?.gameId && raw.gameId !== identity.gameId) {
            return { ok: false, reason: "GAME_BINDING_MISMATCH" };
        }
        if (!CLIENT_PAGES.has(raw?.page)
            || !Number.isSafeInteger(raw?.sequenceNumber)
            || raw.sequenceNumber < 1
            || !Number.isFinite(raw?.clientEventAt)) {
            return { ok: false, reason: "INVALID_PAGE_EVENT" };
        }

        const key = `${identity.roomId}:${identity.playerId}`;
        const previous = this._players.get(key);
        const uiState = safeUiState(raw);
        if (previous && raw.sequenceNumber < previous.sequenceNumber) {
            return { ok: false, reason: "STALE_SEQUENCE", latestSequenceNumber: previous.sequenceNumber };
        }
        if (previous && raw.sequenceNumber === previous.sequenceNumber
            && raw.page !== previous.page) {
            return { ok: false, reason: "SEQUENCE_REUSE_MISMATCH", latestSequenceNumber: previous.sequenceNumber };
        }

        const authority = this._authoritativeByRoom.get(identity.roomId) ?? null;
        const row = {
            roomId: identity.roomId,
            gameId: identity.gameId ?? authority?.gameId ?? raw.gameId ?? null,
            playerId: identity.playerId,
            page: raw.page,
            requestedPage: CLIENT_PAGES.has(raw.requestedPage) ? raw.requestedPage : null,
            requestedFromPage: CLIENT_PAGES.has(raw.requestedFromPage)
                ? raw.requestedFromPage
                : null,
            navigationRequestedAt: Number.isFinite(raw.navigationRequestedAt)
                ? raw.navigationRequestedAt
                : null,
            sequenceNumber: raw.sequenceNumber,
            clientEventAt: raw.clientEventAt,
            serverReceivedAt: receivedAt,
            socketId,
            socketConnected: true,
            uiState,
            authoritativePhase: authority?.phase ?? null,
            authoritativePage: authority?.page ?? null,
            mismatchSince: previous?.mismatchSince ?? null,
            mismatchSignature: previous?.mismatchSignature ?? null,
            uiMismatchSignature: previous?.uiMismatchSignature ?? null
        };

        // An identical sequence is a reconnect replay of the latest state.
        // Refresh only its receipt/connection metadata; never roll back page data.
        if (previous && raw.sequenceNumber === previous.sequenceNumber) {
            row.page = previous.page;
            row.clientEventAt = previous.clientEventAt;
            row.uiState = uiState ?? previous.uiState;
        }
        this._players.set(key, row);
        this._socketKeys.set(socketId, key);
        this._updateMismatch(row, receivedAt);
        this._updateUiMismatch(row, receivedAt);
        return { ok: true, accepted: !previous || raw.sequenceNumber > previous.sequenceNumber,
            duplicate: Boolean(previous && raw.sequenceNumber === previous.sequenceNumber),
            sequenceNumber: row.sequenceNumber, receivedAt };
    }

    observeAuthoritativePage({ roomId, gameId = null, page, phase = null, at = Date.now() } = {}) {
        if (!roomId || !CLIENT_PAGES.has(page)) return;
        const authority = { roomId, gameId, page, phase, updatedAt: at };
        this._authoritativeByRoom.set(roomId, authority);
        for (const row of this._players.values()) {
            if (row.roomId !== roomId) continue;
            row.gameId = gameId ?? row.gameId;
            row.authoritativePage = page;
            row.authoritativePhase = phase ?? row.authoritativePhase;
            this._updateMismatch(row, at);
        }
    }

    observeAuthoritativePhase({ roomId, gameId = null, phase, at = Date.now() } = {}) {
        if (!roomId || typeof phase !== "string") return;
        const previous = this._authoritativeByRoom.get(roomId) ?? { roomId, page: null };
        const authority = { ...previous, roomId, gameId: gameId ?? previous.gameId ?? null,
            phase, updatedAt: at };
        this._authoritativeByRoom.set(roomId, authority);
        for (const row of this._players.values()) {
            if (row.roomId !== roomId) continue;
            row.gameId = gameId ?? row.gameId;
            row.authoritativePhase = phase;
            this._updateMismatch(row, at);
        }
    }

    markDisconnected(socketId, at = Date.now()) {
        const key = this._socketKeys.get(socketId);
        if (!key) return;
        const row = this._players.get(key);
        if (!row || row.socketId !== socketId) return;
        row.socketConnected = false;
        row.disconnectedAt = at;
        this._updateMismatch(row, at);
    }

    getTrustedIdentity(socketId) {
        const key = this._socketKeys.get(socketId);
        const row = key ? this._players.get(key) : null;
        if (!row || row.socketId !== socketId) return null;
        return { ok: true, roomId: row.roomId, playerId: row.playerId, gameId: row.gameId };
    }

    getSnapshot(players = [], now = Date.now()) {
        const rows = new Map();
        for (const row of this._players.values()) {
            const ageMs = Math.max(0, now - row.serverReceivedAt);
            rows.set(`${row.roomId}:${row.playerId}`, Object.freeze({
                roomId: row.roomId,
                gameId: row.gameId,
                playerId: row.playerId,
                lastConfirmedPage: row.page,
                requestedPage: row.requestedPage,
                requestedFromPage: row.requestedFromPage,
                navigationRequestedAt: row.navigationRequestedAt,
                clientTransitionAt: row.clientEventAt,
                serverReceivedAt: row.serverReceivedAt,
                socketConnected: row.socketConnected,
                ageMs,
                missingConfirmation: false,
                stale: !row.socketConnected || ageMs > this._staleAfterMs,
                authoritativePhase: row.authoritativePhase,
                authoritativePage: row.authoritativePage,
                pageMatchesServer: row.authoritativePage
                    ? row.authoritativePage === row.page
                    : null,
                uiStateMismatch: Boolean(row.uiMismatchSignature),
                mismatchDurationMs: row.mismatchSince == null
                    ? 0
                    : Math.max(0, now - row.mismatchSince),
                uiState: row.uiState
            }));
        }

        for (const player of players) {
            if (!player?.playerId || !player?.roomId) continue;
            const key = `${player.roomId}:${player.playerId}`;
            if (rows.has(key)) continue;
            const authority = this._authoritativeByRoom.get(player.roomId) ?? null;
            rows.set(key, Object.freeze({
                roomId: player.roomId,
                gameId: player.gameId ?? authority?.gameId ?? null,
                playerId: player.playerId,
                lastConfirmedPage: null,
                requestedPage: null,
                requestedFromPage: null,
                navigationRequestedAt: null,
                clientTransitionAt: null,
                serverReceivedAt: null,
                socketConnected: player.connectionState === "CONNECTED",
                ageMs: null,
                missingConfirmation: true,
                stale: true,
                authoritativePhase: authority?.phase ?? null,
                authoritativePage: authority?.page ?? null,
                pageMatchesServer: null,
                uiStateMismatch: false,
                mismatchDurationMs: 0,
                uiState: null
            }));
        }
        return Object.freeze([...rows.values()]);
    }

    _updateMismatch(row, now) {
        const mismatch = Boolean(row.authoritativePage && row.page
            && row.authoritativePage !== row.page);
        const signature = mismatch
            ? `${row.authoritativePhase ?? "unknown"}:${row.authoritativePage}:${row.page}:${row.socketConnected ? "CONNECTED" : "DISCONNECTED"}`
            : null;
        if (signature === row.mismatchSignature) return;
        if (signature) {
            const continuingMismatch = row.mismatchSignature != null
                && row.mismatchSince != null;
            if (!continuingMismatch) row.mismatchSince = now;
            row.mismatchSignature = signature;
            this._logger?.warn?.("CLIENT_PAGE_MISMATCH", {
                roomId: row.roomId,
                gameId: row.gameId,
                playerId: row.playerId,
                serverAuthoritativePhase: row.authoritativePhase,
                serverPage: row.authoritativePage,
                lastClientConfirmedPage: row.page,
                clientEventAt: row.clientEventAt,
                serverReceivedAt: row.serverReceivedAt,
                connectionStatus: row.socketConnected ? "CONNECTED" : "DISCONNECTED",
                mismatchDurationMs: Math.max(0, now - (row.mismatchSince ?? now))
            });
        } else if (row.mismatchSignature) {
            const durationMs = Math.max(0, now - (row.mismatchSince ?? now));
            this._logger?.info?.("CLIENT_PAGE_MISMATCH_RESOLVED", {
                roomId: row.roomId,
                gameId: row.gameId,
                playerId: row.playerId,
                serverAuthoritativePhase: row.authoritativePhase,
                serverPage: row.authoritativePage,
                lastClientConfirmedPage: row.page,
                mismatchDurationMs: durationMs
            });
            row.mismatchSince = null;
            row.mismatchSignature = null;
        } else {
            row.mismatchSince = null;
            row.mismatchSignature = null;
        }
    }

    _updateUiMismatch(row, now) {
        const ui = row.uiState;
        const mismatch = Boolean(ui && (
            ui.appliedPage !== row.page
            || !ui.mounted
            || (ui.documentVisible && !ui.visible)
        ));
        const signature = mismatch
            ? `${row.page}:${ui.appliedPage ?? "unknown"}:${ui.mounted}:${ui.visible}:${ui.documentVisible}:${ui.topmostAtSample}:${ui.blockingUi.join(",")}`
            : null;
        if (signature === row.uiMismatchSignature) return;
        if (signature) {
            row.uiMismatchSignature = signature;
            this._logger?.warn?.("CLIENT_UI_STATE_MISMATCH", {
                roomId: row.roomId,
                gameId: row.gameId,
                playerId: row.playerId,
                reportedPage: row.page,
                requestedPage: row.requestedPage,
                requestedFromPage: row.requestedFromPage,
                appliedPage: ui.appliedPage,
                mounted: ui.mounted,
                visible: ui.visible,
                documentVisible: ui.documentVisible,
                topmostAtSample: ui.topmostAtSample,
                blockingUi: ui.blockingUi,
                observedAt: now
            });
        } else if (row.uiMismatchSignature) {
            this._logger?.info?.("CLIENT_UI_STATE_MISMATCH_RESOLVED", {
                roomId: row.roomId,
                gameId: row.gameId,
                playerId: row.playerId,
                reportedPage: row.page,
                resolvedAt: now
            });
            row.uiMismatchSignature = null;
        }
    }
}

export const CLIENT_PAGE_CONFIRMATION_PAGES = Object.freeze([...CLIENT_PAGES]);
