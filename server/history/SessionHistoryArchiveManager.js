/**
 * R7.0 — Immutable Session Lifecycle History archive.
 *
 * Observe-only: listens to EventBus terminal signals and writes one JSON
 * record per room when ROOM_DESTROYED fires. Never mutates gameplay state.
 */

import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync
} from "node:fs";
import { join } from "node:path";

import { EVENT_TYPES } from "../events/EventTypes.js";

export const LIFECYCLE_RESULTS = Object.freeze({
    GAME_COMPLETED: "GAME_COMPLETED",
    SETUP_EXPIRED: "SETUP_EXPIRED",
    VERIFY_ABORTED: "VERIFY_ABORTED",
    VERIFY_TIMEOUT: "VERIFY_TIMEOUT",
    PAYMENT_TIMEOUT: "PAYMENT_TIMEOUT",
    PAYMENT_FAILED: "PAYMENT_FAILED",
    TONCONNECT_TIMEOUT: "TONCONNECT_TIMEOUT",
    TONCONNECT_FAILED: "TONCONNECT_FAILED",
    ROOM_DESTROYED: "ROOM_DESTROYED",
    RECOVERY_FAILED: "RECOVERY_FAILED",
    SERVER_ABORT: "SERVER_ABORT",
    CLIENT_ABORT: "CLIENT_ABORT",
    ADMIN_ABORT: "ADMIN_ABORT",
    UNKNOWN_FAILURE: "UNKNOWN_FAILURE"
});

export const FAILURE_OWNERS = Object.freeze({
    SERVER: "SERVER",
    CLIENT: "CLIENT",
    PAYMENT: "PAYMENT",
    TONCONNECT: "TONCONNECT",
    BLOCKCHAIN: "BLOCKCHAIN",
    TIMEOUT: "TIMEOUT",
    USER: "USER",
    ADMIN: "ADMIN",
    UNKNOWN: "UNKNOWN"
});

const MAX_TIMELINE = 200;
const MAX_LOG_LINES = 200;

function pad(value, size = 2) {

    return String(value).padStart(size, "0");

}

function formatFilenameTimestamp(ms = Date.now()) {

    const date = new Date(ms);

    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`
        + `-${pad(date.getUTCDate())}`
        + `_${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}`
        + `-${pad(date.getUTCSeconds())}`;

}

function safeSegment(value) {

    return String(value ?? "unknown").replace(/[^\w.-]+/g, "_");

}

function resolveLifecycleResult({ reason, flags, gameId }) {

    const normalized = String(reason ?? "").toLowerCase();

    if (
        flags.sessionFinished
        && (
            normalized.includes("session_ended")
            || normalized.includes("finish")
            || normalized.includes("page6")
            || normalized === "completed"
            || normalized === ""
        )
        && gameId
    ) {

        return LIFECYCLE_RESULTS.GAME_COMPLETED;

    }

    if (normalized.includes("setup_expired") || flags.setupExpired) {

        return LIFECYCLE_RESULTS.SETUP_EXPIRED;

    }

    if (normalized.includes("verify") && normalized.includes("timeout")) {

        return LIFECYCLE_RESULTS.VERIFY_TIMEOUT;

    }

    if (normalized.includes("verify")) {

        return LIFECYCLE_RESULTS.VERIFY_ABORTED;

    }

    if (normalized.includes("payment_timeout") || normalized.includes("payment timeout")) {

        return LIFECYCLE_RESULTS.PAYMENT_TIMEOUT;

    }

    if (normalized.includes("payment") || flags.paymentFailed) {

        return LIFECYCLE_RESULTS.PAYMENT_FAILED;

    }

    if (normalized.includes("tonconnect") && normalized.includes("timeout")) {

        return LIFECYCLE_RESULTS.TONCONNECT_TIMEOUT;

    }

    if (normalized.includes("tonconnect") || normalized.includes("wallet_connect")) {

        return LIFECYCLE_RESULTS.TONCONNECT_FAILED;

    }

    if (normalized.includes("recovery")) {

        return LIFECYCLE_RESULTS.RECOVERY_FAILED;

    }

    if (normalized.includes("admin")) {

        return LIFECYCLE_RESULTS.ADMIN_ABORT;

    }

    if (
        normalized.includes("creator_left")
        || normalized.includes("client")
        || normalized.includes("disconnect")
    ) {

        return LIFECYCLE_RESULTS.CLIENT_ABORT;

    }

    if (
        normalized.includes("server")
        || normalized.includes("shutdown")
        || normalized.includes("game_start_failed")
    ) {

        return LIFECYCLE_RESULTS.SERVER_ABORT;

    }

    if (flags.sessionFinished && gameId) {

        return LIFECYCLE_RESULTS.GAME_COMPLETED;

    }

    return LIFECYCLE_RESULTS.ROOM_DESTROYED;

}

function resolveFailureOwner(lifecycleResult, reason) {

    switch (lifecycleResult) {

        case LIFECYCLE_RESULTS.GAME_COMPLETED:
            return FAILURE_OWNERS.USER;

        case LIFECYCLE_RESULTS.SETUP_EXPIRED:
        case LIFECYCLE_RESULTS.VERIFY_TIMEOUT:
        case LIFECYCLE_RESULTS.PAYMENT_TIMEOUT:
        case LIFECYCLE_RESULTS.TONCONNECT_TIMEOUT:
            return FAILURE_OWNERS.TIMEOUT;

        case LIFECYCLE_RESULTS.PAYMENT_FAILED:
            return FAILURE_OWNERS.PAYMENT;

        case LIFECYCLE_RESULTS.TONCONNECT_FAILED:
            return FAILURE_OWNERS.TONCONNECT;

        case LIFECYCLE_RESULTS.RECOVERY_FAILED:
            return FAILURE_OWNERS.SERVER;

        case LIFECYCLE_RESULTS.ADMIN_ABORT:
            return FAILURE_OWNERS.ADMIN;

        case LIFECYCLE_RESULTS.CLIENT_ABORT:
            return FAILURE_OWNERS.CLIENT;

        case LIFECYCLE_RESULTS.SERVER_ABORT:
            return FAILURE_OWNERS.SERVER;

        case LIFECYCLE_RESULTS.VERIFY_ABORTED:
            return FAILURE_OWNERS.USER;

        default:
            return String(reason ?? "").toLowerCase().includes("blockchain")
                ? FAILURE_OWNERS.BLOCKCHAIN
                : FAILURE_OWNERS.UNKNOWN;

    }

}

function resolveFinalStage(lifecycleResult, flags) {

    if (lifecycleResult === LIFECYCLE_RESULTS.GAME_COMPLETED) {

        return "RESULT";

    }

    if (flags.gameStarted) {

        return "GAME";

    }

    if (flags.paymentEntered) {

        return "PAYMENT";

    }

    if (flags.tonConnectSeen) {

        return "TONCONNECT";

    }

    if (flags.verifyCompleted) {

        return "VERIFY";

    }

    if (flags.setupStarted) {

        return "SETUP";

    }

    return "ROOM";

}

export class SessionHistoryArchiveManager {

    static _instance = null;

    constructor() {

        this._initialized = false;
        this._directory = null;
        this._eventBus = null;
        this._projectionService = null;
        this._roomLobbyBridge = null;
        this._playerManager = null;
        this._loggingManager = null;
        this._pending = new Map();
        this._archived = new Set();
        this._handlers = [];
        this._unsubscribeLogging = null;
        this._indexCache = null;

    }

    static getInstance() {

        if (!SessionHistoryArchiveManager._instance) {

            SessionHistoryArchiveManager._instance = new SessionHistoryArchiveManager();

        }

        return SessionHistoryArchiveManager._instance;

    }

    static resetForTests() {

        if (SessionHistoryArchiveManager._instance) {

            SessionHistoryArchiveManager._instance.shutdown();

        }

        SessionHistoryArchiveManager._instance = null;

    }

    initialize({
        eventBus,
        projectionService = null,
        roomLobbyBridge = null,
        playerManager = null,
        loggingManager = null,
        directory = null
    } = {}) {

        if (this._initialized) {

            return;

        }

        if (!eventBus) {

            throw new Error("SessionHistoryArchiveManager requires eventBus");

        }

        this._eventBus = eventBus;
        this._projectionService = projectionService;
        this._roomLobbyBridge = roomLobbyBridge;
        this._playerManager = playerManager;
        this._loggingManager = loggingManager;
        this._directory = directory
            ?? join(process.cwd(), "data", "session-history");

        mkdirSync(this._directory, { recursive: true });

        this._subscribe(EVENT_TYPES.ROOM_CREATED, (envelope) => {

            this._openPending(envelope.payload);

        });

        this._subscribe(EVENT_TYPES.PLAYER_JOINED, (envelope) => {

            this._onPlayerJoined(envelope.payload);

        });

        this._subscribe(EVENT_TYPES.SETUP_SESSION_STARTED, (envelope) => {

            this._flag(envelope.payload?.roomId, "setupStarted", true);
            this._pushTimeline(envelope.payload?.roomId, "SETUP", "Setup session started");

        });

        this._subscribe(EVENT_TYPES.SETUP_SESSION_COMPLETED, (envelope) => {

            this._flag(envelope.payload?.roomId, "setupCompleted", true);
            this._pushTimeline(envelope.payload?.roomId, "SETUP", "Setup session completed");

        });

        this._subscribe(EVENT_TYPES.SETUP_SESSION_EXPIRED, (envelope) => {

            const roomId = envelope.payload?.roomId;

            this._flag(roomId, "setupExpired", true);
            this._setTerminalHint(roomId, "setup_expired", envelope.payload);
            this._pushTimeline(roomId, "SETUP", "Setup session expired");

        });

        this._subscribe(EVENT_TYPES.PAYMENT_CONNECTION_READY, (envelope) => {

            this._flag(envelope.payload?.roomId, "tonConnectSeen", true);
            this._flag(envelope.payload?.roomId, "paymentEntered", true);
            this._pushTimeline(
                envelope.payload?.roomId,
                "TONCONNECT",
                "PAYMENT_CONNECTION_READY"
            );

        });

        this._subscribe(EVENT_TYPES.PAYMENT_SESSION_FAILED, (envelope) => {

            const roomId = envelope.payload?.roomId;
            const reason = envelope.payload?.reason ?? "payment_failed";

            this._flag(roomId, "paymentFailed", true);
            this._setTerminalHint(roomId, reason, envelope.payload);
            this._pushTimeline(roomId, "PAYMENT", `Payment session failed (${reason})`);

        });

        this._subscribe(EVENT_TYPES.GAME_START_FAILED, (envelope) => {

            const roomId = envelope.payload?.roomId;
            const reason = envelope.payload?.reason ?? "game_start_failed";

            this._setTerminalHint(roomId, reason, envelope.payload);
            this._pushTimeline(roomId, "GAME", `Game start failed (${reason})`);

        });

        this._subscribe(EVENT_TYPES.GAME_CREATED, (envelope) => {

            const roomId = envelope.payload?.roomId;
            const gameId = envelope.payload?.gameId ?? null;
            const pending = this._ensurePending(roomId);

            if (pending && gameId) {

                pending.gameId = gameId;
                pending.flags.gameInitialized = true;

            }

            this._pushTimeline(roomId, "GAME", `Game created (${gameId ?? "—"})`);

        });

        this._subscribe(EVENT_TYPES.GAME_STARTED, (envelope) => {

            this._flag(envelope.payload?.roomId, "gameStarted", true);
            this._pushTimeline(envelope.payload?.roomId, "GAME", "Game started");

        });

        this._subscribe(EVENT_TYPES.SESSION_FINISHED, (envelope) => {

            const roomId = envelope.payload?.roomId;
            const pending = this._ensurePending(roomId);

            if (pending) {

                pending.flags.sessionFinished = true;
                pending.gameId = envelope.payload?.gameId ?? pending.gameId;
                pending.startedAt = pending.startedAt ?? envelope.payload?.timestamp;

            }

            this._setTerminalHint(
                roomId,
                envelope.payload?.reason ?? "session_ended",
                envelope.payload
            );

            this._pushTimeline(
                roomId,
                "RESULT",
                `Session finished (${envelope.payload?.reason ?? "session_ended"})`
            );

        });

        this._subscribe(EVENT_TYPES.RECOVERY_FAILED, (envelope) => {

            const roomId = envelope.payload?.roomId;

            this._flag(roomId, "recoveryFailed", true);
            this._pushTimeline(roomId, "RECOVERY", "Recovery failed");

        });

        this._subscribe(EVENT_TYPES.ROOM_DESTROYED, (envelope) => {

            this._finalize(envelope.payload);

        });

        if (loggingManager?.subscribe) {

            this._unsubscribeLogging = loggingManager.subscribe((record) => {

                this._ingestLog(record);

            });

        }

        this._initialized = true;

    }

    shutdown() {

        for (const entry of this._handlers) {

            this._eventBus?.unsubscribe(entry.type, entry.handler);

        }

        this._handlers = [];
        this._unsubscribeLogging?.();
        this._unsubscribeLogging = null;
        this._pending.clear();
        this._archived.clear();
        this._indexCache = null;
        this._initialized = false;

    }

    listRecords({
        roomId = null,
        gameId = null,
        lifecycleResult = null,
        playerNickname = null,
        walletAddress = null,
        fromAt = null,
        toAt = null,
        sort = "newest",
        limit = 200,
        offset = 0
    } = {}) {

        const index = this._readIndex();

        let rows = [...index.records];

        if (roomId) {

            const needle = String(roomId).toLowerCase();

            rows = rows.filter((row) => String(row.roomId).toLowerCase().includes(needle));

        }

        if (gameId) {

            const needle = String(gameId).toLowerCase();

            rows = rows.filter((row) => String(row.gameId ?? "").toLowerCase().includes(needle));

        }

        if (lifecycleResult && lifecycleResult !== "all") {

            rows = rows.filter((row) => row.lifecycleResult === lifecycleResult);

        }

        if (playerNickname) {

            const needle = String(playerNickname).toLowerCase();

            rows = rows.filter((row) => (row.playerNicknames ?? []).some(
                (name) => String(name ?? "").toLowerCase().includes(needle)
            ));

        }

        if (walletAddress) {

            const needle = String(walletAddress).toLowerCase();

            rows = rows.filter((row) => (row.walletAddresses ?? []).some(
                (wallet) => String(wallet ?? "").toLowerCase().includes(needle)
            ));

        }

        if (fromAt != null) {

            rows = rows.filter((row) => (row.finishedAt ?? 0) >= Number(fromAt));

        }

        if (toAt != null) {

            rows = rows.filter((row) => (row.finishedAt ?? 0) <= Number(toAt));

        }

        rows.sort((left, right) => {

            if (sort === "oldest") {

                return (left.finishedAt ?? 0) - (right.finishedAt ?? 0);

            }

            if (sort === "duration") {

                return (right.durationMs ?? 0) - (left.durationMs ?? 0);

            }

            if (sort === "result") {

                return String(left.lifecycleResult)
                    .localeCompare(String(right.lifecycleResult));

            }

            return (right.finishedAt ?? 0) - (left.finishedAt ?? 0);

        });

        const total = rows.length;
        const sliced = rows.slice(offset, offset + limit);

        return Object.freeze({
            total,
            offset,
            limit,
            records: Object.freeze(sliced.map((row) => Object.freeze({ ...row })))
        });

    }

    getRecord(sessionId) {

        if (!sessionId) {

            return null;

        }

        const index = this._readIndex();
        const summary = index.records.find(
            (row) => row.sessionId === sessionId
        );

        if (!summary?.filename) {

            return null;

        }

        const absolute = join(this._directory, summary.filename);

        if (!existsSync(absolute)) {

            return null;

        }

        try {

            return JSON.parse(readFileSync(absolute, "utf8"));

        } catch {

            return null;

        }

    }

    getDownloadBuffer(sessionId) {

        const record = this.getRecord(sessionId);

        if (!record) {

            return null;

        }

        const body = Buffer.from(JSON.stringify(record, null, 2), "utf8");

        return {
            buffer: body,
            filename: record.downloadFilename
                ?? this._buildFilename(record)
        };

    }

    _subscribe(type, handler) {

        this._eventBus.subscribe(type, handler);

        this._handlers.push({ type, handler });

    }

    _openPending(payload) {

        const roomId = payload?.roomId;

        if (!roomId || this._archived.has(roomId)) {

            return;

        }

        if (this._pending.has(roomId)) {

            return;

        }

        this._pending.set(roomId, {
            sessionId: `sess_${safeSegment(roomId)}_${Date.now()}`,
            roomId,
            gameId: null,
            createdAt: payload?.createdAt ?? Date.now(),
            startedAt: null,
            finishedAt: null,
            reason: null,
            flags: {
                setupStarted: false,
                setupCompleted: false,
                setupExpired: false,
                verifyCompleted: false,
                paymentEntered: false,
                paymentFailed: false,
                tonConnectSeen: false,
                gameInitialized: false,
                gameStarted: false,
                sessionFinished: false,
                recoveryFailed: false
            },
            players: new Map(),
            timeline: [],
            developerLogs: [],
            configuration: {
                room: payload ?? null,
                game: null,
                frozen: null
            }
        });

        this._pushTimeline(roomId, "ROOM", "Room created");

    }

    _ensurePending(roomId) {

        if (!roomId) {

            return null;

        }

        if (!this._pending.has(roomId) && !this._archived.has(roomId)) {

            this._openPending({ roomId, createdAt: Date.now() });

        }

        return this._pending.get(roomId) ?? null;

    }

    _flag(roomId, key, value) {

        const pending = this._ensurePending(roomId);

        if (!pending) {

            return;

        }

        pending.flags[key] = value;

    }

    _setTerminalHint(roomId, reason, payload = null) {

        const pending = this._ensurePending(roomId);

        if (!pending) {

            return;

        }

        pending.reason = reason ?? pending.reason;

        if (payload?.gameId) {

            pending.gameId = payload.gameId;

        }

    }

    _onPlayerJoined(payload) {

        const roomId = payload?.roomId;
        const playerId = payload?.playerId;
        const pending = this._ensurePending(roomId);

        if (!pending || !playerId) {

            return;

        }

        const player = this._playerManager?.getPlayer?.(playerId);
        const nickname = player?.identity?.nickname
            ?? payload?.nickname
            ?? null;
        const wallet = player?.identity?.wallet
            ?? payload?.wallet
            ?? null;

        pending.players.set(String(playerId), {
            playerId,
            nickname,
            walletAddress: wallet,
            status: player?.runtime?.playerState ?? null,
            socketId: null
        });

        this._pushTimeline(roomId, "ROOM", `Player joined (${playerId})`);

    }

    _pushTimeline(roomId, subsystem, message) {

        const pending = this._ensurePending(roomId);

        if (!pending) {

            return;

        }

        pending.timeline.push({
            at: Date.now(),
            subsystem,
            message
        });

        if (pending.timeline.length > MAX_TIMELINE) {

            pending.timeline.splice(0, pending.timeline.length - MAX_TIMELINE);

        }

    }

    _ingestLog(record) {

        if (!record) {

            return;

        }

        const message = String(record.message ?? "");
        const roomMatch = /roomId=([^\s|]+)/i.exec(message);
        const roomId = roomMatch?.[1] ?? record.roomId ?? null;

        if (!roomId || !this._pending.has(roomId)) {

            return;

        }

        const pending = this._pending.get(roomId);

        pending.developerLogs.push({
            at: record.at ?? record.timestamp ?? Date.now(),
            level: record.level ?? "info",
            source: record.source ?? "LoggingManager",
            message
        });

        if (pending.developerLogs.length > MAX_LOG_LINES) {

            pending.developerLogs.splice(
                0,
                pending.developerLogs.length - MAX_LOG_LINES
            );

        }

    }

    _finalize(payload) {

        const roomId = payload?.roomId;

        if (!roomId || this._archived.has(roomId)) {

            return;

        }

        const pending = this._ensurePending(roomId);

        if (!pending) {

            return;

        }

        const finishedAt = Date.now();

        pending.finishedAt = finishedAt;
        pending.reason = pending.reason ?? "room_destroyed";

        // Snapshot while sibling destroy listeners may still have artifacts.
        const roomDetail = this._projectionService?.buildRoomDetail?.(roomId)
            ?? null;
        const tonConnect = this._roomLobbyBridge?.getTonConnectDiagnostics?.(roomId)
            ?? roomDetail?.tonConnect
            ?? null;

        this._refreshPlayersFromManagers(pending);

        if (tonConnect?.events?.length) {

            for (const event of tonConnect.events) {

                pending.timeline.push({
                    at: event.at,
                    subsystem: "TONCONNECT",
                    message: `${event.type}${event.playerId ? ` (${event.playerId})` : ""}`
                });

            }

            pending.timeline.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));

            if (pending.timeline.length > MAX_TIMELINE) {

                pending.timeline = pending.timeline.slice(-MAX_TIMELINE);

            }

            pending.flags.tonConnectSeen = true;

        }

        const lifecycleResult = resolveLifecycleResult({
            reason: pending.reason,
            flags: pending.flags,
            gameId: pending.gameId
                ?? roomDetail?.linkedGame?.gameId
                ?? null
        });

        const failureOwner = resolveFailureOwner(lifecycleResult, pending.reason);
        const finalStage = resolveFinalStage(lifecycleResult, pending.flags);
        const createdAt = pending.createdAt ?? finishedAt;
        const startedAt = pending.startedAt
            ?? roomDetail?.setupSession?.startedAt
            ?? createdAt;
        const durationMs = Math.max(0, finishedAt - createdAt);
        const gameId = pending.gameId
            ?? roomDetail?.linkedGame?.gameId
            ?? null;

        const players = [...pending.players.values()].map((player) => {

            const seat = tonConnect?.players?.find(
                (entry) => String(entry.playerId) === String(player.playerId)
            );

            return Object.freeze({
                playerId: player.playerId,
                nickname: player.nickname ?? seat?.nickname ?? null,
                walletAddress: seat?.walletAddress
                    ?? player.walletAddress
                    ?? null,
                status: seat?.displayStatus
                    ?? seat?.status
                    ?? player.status
                    ?? null,
                socketId: seat?.socketId ?? player.socketId ?? null
            });

        });

        const record = Object.freeze({
            schemaVersion: 1,
            sessionId: pending.sessionId,
            roomId,
            gameId,
            createdAt,
            startedAt,
            finishedAt,
            durationMs,
            lifecycleResult,
            failureOwner,
            finalStage,
            reason: pending.reason,
            header: Object.freeze({
                sessionId: pending.sessionId,
                roomId,
                gameId,
                createdAt,
                startedAt,
                finishedAt,
                durationMs,
                lifecycleResult,
                failureOwner,
                finalStage
            }),
            players: Object.freeze(players),
            configuration: Object.freeze({
                frozen: pending.configuration.frozen,
                room: roomDetail?.room ?? pending.configuration.room,
                game: roomDetail?.linkedGame ?? pending.configuration.game,
                setupSession: roomDetail?.setupSession ?? null
            }),
            setupSession: roomDetail?.setupSession ?? null,
            verify: Object.freeze({
                completed: pending.flags.verifyCompleted === true
            }),
            payment: roomDetail?.paymentSession ?? null,
            tonConnect: tonConnect ?? null,
            walletConnectionSession: tonConnect
                ? Object.freeze({
                    paymentConnectionReady: tonConnect.paymentConnectionReady,
                    handshakeStage: tonConnect.handshakeStage,
                    players: tonConnect.players
                })
                : null,
            timeline: Object.freeze(pending.timeline.map((entry) => Object.freeze({
                ...entry
            }))),
            developerLog: Object.freeze(pending.developerLogs.map((entry) => (
                Object.freeze({ ...entry })
            ))),
            finalSnapshot: Object.freeze({
                room: roomDetail?.room ?? { roomId, status: "DESTROYED" },
                players,
                payment: roomDetail?.paymentSession ?? null,
                tonConnect,
                serverState: Object.freeze({
                    roomDestroyed: true,
                    playerCountAtDestroy: payload?.playerCount ?? players.length
                }),
                configuration: Object.freeze({
                    room: roomDetail?.room ?? null,
                    game: roomDetail?.linkedGame ?? null
                })
            }),
            downloadFilename: null
        });

        const downloadFilename = this._buildFilename(record);
        const mutable = {
            ...record,
            downloadFilename
        };

        this._writeRecord(mutable);
        this._archived.add(roomId);
        this._pending.delete(roomId);

    }

    _refreshPlayersFromManagers(pending) {

        for (const [playerId, existing] of pending.players.entries()) {

            const player = this._playerManager?.getPlayer?.(playerId);

            if (!player) {

                continue;

            }

            pending.players.set(playerId, {
                ...existing,
                nickname: player.identity?.nickname ?? existing.nickname,
                walletAddress: player.identity?.wallet ?? existing.walletAddress,
                status: player.runtime?.playerState ?? existing.status
            });

        }

        if (pending.players.size === 0 && this._roomLobbyBridge) {

            const diagnostics = this._roomLobbyBridge.getTonConnectDiagnostics?.(
                pending.roomId
            );

            for (const seat of diagnostics?.players ?? []) {

                pending.players.set(String(seat.playerId), {
                    playerId: seat.playerId,
                    nickname: seat.nickname,
                    walletAddress: seat.walletAddress,
                    status: seat.displayStatus ?? seat.status,
                    socketId: seat.socketId
                });

            }

        }

    }

    _buildFilename(record) {

        const stamp = formatFilenameTimestamp(record.finishedAt ?? Date.now());
        const room = safeSegment(record.roomId);
        const game = record.gameId
            ? `GAME_${safeSegment(record.gameId)}`
            : "NO_GAME";
        const result = safeSegment(record.lifecycleResult);

        return `${stamp}_ROOM_${room}_${game}_${result}.json`;

    }

    _writeRecord(record) {

        mkdirSync(this._directory, { recursive: true });

        const absolute = join(this._directory, record.downloadFilename);
        const temp = `${absolute}.tmp`;

        writeFileSync(temp, JSON.stringify(record, null, 2), "utf8");
        renameSync(temp, absolute);

        const summary = Object.freeze({
            sessionId: record.sessionId,
            roomId: record.roomId,
            gameId: record.gameId,
            createdAt: record.createdAt,
            finishedAt: record.finishedAt,
            durationMs: record.durationMs,
            lifecycleResult: record.lifecycleResult,
            failureOwner: record.failureOwner,
            finalStage: record.finalStage,
            playerCount: record.players?.length ?? 0,
            playerNicknames: Object.freeze(
                (record.players ?? [])
                    .map((player) => player.nickname)
                    .filter(Boolean)
            ),
            walletAddresses: Object.freeze(
                (record.players ?? [])
                    .map((player) => player.walletAddress)
                    .filter(Boolean)
            ),
            filename: record.downloadFilename
        });

        const index = this._readIndex();

        index.records = [
            summary,
            ...index.records.filter((row) => row.sessionId !== summary.sessionId)
        ];

        this._writeIndex(index);

    }

    _indexPath() {

        return join(this._directory, "index.json");

    }

    _readIndex() {

        if (this._indexCache) {

            return this._indexCache;

        }

        const path = this._indexPath();

        if (!existsSync(path)) {

            this._indexCache = { version: 1, records: [] };

            return this._indexCache;

        }

        try {

            const parsed = JSON.parse(readFileSync(path, "utf8"));

            this._indexCache = {
                version: parsed.version ?? 1,
                records: Array.isArray(parsed.records) ? parsed.records : []
            };

        } catch {

            this._indexCache = { version: 1, records: [] };

        }

        return this._indexCache;

    }

    _writeIndex(index) {

        const path = this._indexPath();
        const temp = `${path}.tmp`;

        writeFileSync(temp, JSON.stringify(index, null, 2), "utf8");
        renameSync(temp, path);
        this._indexCache = index;

    }

    rebuildIndexFromDisk() {

        mkdirSync(this._directory, { recursive: true });

        const files = readdirSync(this._directory)
            .filter((name) => name.endsWith(".json") && name !== "index.json");

        const records = [];

        for (const filename of files) {

            try {

                const record = JSON.parse(
                    readFileSync(join(this._directory, filename), "utf8")
                );

                records.push({
                    sessionId: record.sessionId,
                    roomId: record.roomId,
                    gameId: record.gameId ?? null,
                    createdAt: record.createdAt,
                    finishedAt: record.finishedAt,
                    durationMs: record.durationMs,
                    lifecycleResult: record.lifecycleResult,
                    failureOwner: record.failureOwner,
                    finalStage: record.finalStage,
                    playerCount: record.players?.length ?? 0,
                    playerNicknames: (record.players ?? [])
                        .map((player) => player.nickname)
                        .filter(Boolean),
                    walletAddresses: (record.players ?? [])
                        .map((player) => player.walletAddress)
                        .filter(Boolean),
                    filename: record.downloadFilename ?? filename
                });

            } catch {

                // Skip corrupt archives.
            }

        }

        records.sort((left, right) => (
            (right.finishedAt ?? 0) - (left.finishedAt ?? 0)
        ));

        this._writeIndex({ version: 1, records });

        return records.length;

    }

}
