/**
 * R6.2B / R6.2C — Per-room diagnostic log (DEV-only).
 *
 * Observes EventBus + LoggingManager and writes one chronological text file
 * per Room under logs/games/. On close, appends SUMMARY / CHECKLIST /
 * RECOVERY FAILURE and renames the file by outcome.
 *
 * Does not alter gameplay or recovery control flow.
 */

import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    writeSync
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { LOG_CHANNELS, LOG_LEVELS } from "./levels.js";

const SERVICE = "wheelwin-game-diagnostic";

const ROOM_ID_IN_MESSAGE = /(?:^|\|\s*)roomId=([^\s|]+)/i;

const SOCKET_ID_IN_MESSAGE = /(?:^|\|\s*)socket\.id=([^\s|]+)/i;

const PLAYER_ID_IN_MESSAGE = /(?:^|\|\s*)playerId=([^\s|]+)/i;

const REASON_IN_MESSAGE = /(?:^|\|\s*)reason=(.+)$/i;

const CHECK_STATUS = Object.freeze({
    OK: "OK",
    FAILED: "FAILED",
    NO: "NO",
    NOT_SENT: "NOT SENT",
    SKIPPED: "SKIPPED",
    UNKNOWN: "UNKNOWN"
});

const OUTCOMES = Object.freeze({
    GAME_COMPLETED: "GAME_COMPLETED",
    SETUP_EXPIRED: "SETUP_EXPIRED",
    RECOVERY_FAILED: "RECOVERY_FAILED",
    ROOM_DESTROYED: "ROOM_DESTROYED"
});

function formatTimestamp(ms = Date.now()) {

    const date = new Date(ms);

    const pad = (value, size = 2) => String(value).padStart(size, "0");

    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`
        + `-${pad(date.getUTCDate())}`
        + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
        + `:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;

}

function formatFilenameTimestamp(ms = Date.now()) {

    const date = new Date(ms);

    const pad = (value, size = 2) => String(value).padStart(size, "0");

    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`
        + `-${pad(date.getUTCDate())}`
        + `_${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}`
        + `-${pad(date.getUTCSeconds())}`;

}

function formatDuration(ms) {

    const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));

    const hours = Math.floor(totalSeconds / 3600);

    const minutes = Math.floor((totalSeconds % 3600) / 60);

    const seconds = totalSeconds % 60;

    const pad = (value) => String(value).padStart(2, "0");

    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;

}

function safeSegment(value) {

    return String(value ?? "unknown").replace(/[^\w.-]+/g, "_");

}

function extractFromMessage(message, pattern) {

    if (typeof message !== "string") {

        return null;

    }

    const match = message.match(pattern);

    return match?.[1] && match[1] !== "null"
        ? String(match[1]).trim()
        : null;

}

function checklistLine(label, status) {

    const dots = ".".repeat(Math.max(2, 42 - label.length));

    return `${label}${dots}${status}`;

}

function createFlags() {

    return {
        roomCreated: false,
        setupStarted: false,
        setupCompleted: false,
        setupExpired: false,
        playerJoinedCount: 0,
        verifyCompleted: false,
        paymentEntered: false,
        gameInitialized: false,
        gameStarted: false,
        sessionFinished: false,
        roomDestroyed: false,
        clientDisconnected: false,
        sessionRecoveryRequest: false,
        playerFound: false,
        socketRebound: false,
        setupSessionSync: false,
        recoveryCompleted: false,
        recoveryFailed: false
    };

}

export class GameDiagnosticLogManager {

    static _instance = null;

    constructor() {

        this._initialized = false;

        this._enabled = false;

        this._eventBus = null;

        this._loggingManager = null;

        this._playerManager = null;

        this._directory = null;

        this._sessions = new Map();

        this._gameToRoom = new Map();

        this._playerToRoom = new Map();

        this._handlers = [];

        this._unsubscribeLogging = null;

    }

    static getInstance() {

        if (!GameDiagnosticLogManager._instance) {

            GameDiagnosticLogManager._instance = new GameDiagnosticLogManager();

        }

        return GameDiagnosticLogManager._instance;

    }

    static resetForTests() {

        if (GameDiagnosticLogManager._instance) {

            GameDiagnosticLogManager._instance.shutdown();

        }

        GameDiagnosticLogManager._instance = null;

    }

    initialize({
        enabled = false,
        eventBus,
        loggingManager,
        playerManager = null,
        directory = null
    }) {

        this.shutdown();

        this._enabled = enabled === true;

        this._eventBus = eventBus ?? null;

        this._loggingManager = loggingManager ?? null;

        this._playerManager = playerManager ?? null;

        this._directory = directory
            || join(process.cwd(), "logs", "games");

        this._initialized = true;

        if (!this._enabled || !this._eventBus || !this._loggingManager) {

            return this;

        }

        try {

            mkdirSync(this._directory, { recursive: true });

        } catch {

            this._enabled = false;

            return this;

        }

        this._subscribeEventBus();

        this._unsubscribeLogging = this._loggingManager.subscribe(
            (record) => this._onLogRecord(record)
        );

        this._loggingManager.write({
            level: LOG_LEVELS.INFO,
            channel: LOG_CHANNELS.APPLICATION,
            service: SERVICE,
            message: "Game diagnostic logging enabled (DEV)",
            fields: { directory: "logs/games" }
        });

        return this;

    }

    isEnabled() {

        return this._initialized && this._enabled;

    }

    getActiveLogPath(roomId) {

        const session = this._sessions.get(roomId);

        if (!session || session.closed) {

            return null;

        }

        return session.filePath;

    }

    getLogPath(roomId) {

        return this._sessions.get(roomId)?.filePath ?? null;

    }

    readLog(roomId) {

        const filePath = this.getLogPath(roomId);

        if (!filePath || !existsSync(filePath)) {

            return null;

        }

        try {

            return readFileSync(filePath);

        } catch {

            return null;

        }

    }

    getSafeStatus() {

        const open = [...this._sessions.values()].filter((s) => !s.closed);

        return Object.freeze({
            enabled: this.isEnabled(),
            openSessions: open.length,
            totalSessions: this._sessions.size
        });

    }

    shutdown() {

        for (const roomId of [...this._sessions.keys()]) {

            this._closeSession(roomId, "shutdown");

        }

        if (this._unsubscribeLogging) {

            this._unsubscribeLogging();

            this._unsubscribeLogging = null;

        }

        for (const subscription of this._handlers) {

            this._eventBus?.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._sessions.clear();

        this._gameToRoom.clear();

        this._playerToRoom.clear();

        this._enabled = false;

        this._initialized = false;

        this._eventBus = null;

        this._loggingManager = null;

        this._playerManager = null;

    }

    _subscribeEventBus() {

        const track = (event, handler) => {

            this._eventBus.subscribe(event, handler);

            this._handlers.push({ event, handler });

        };

        track(EVENT_TYPES.ROOM_CREATED, (envelope) => {

            this._openSession(envelope.payload);

            const session = this._sessions.get(envelope.payload?.roomId);

            if (session) {

                session.flags.roomCreated = true;

                session.maxPlayers = envelope.payload?.maxPlayers
                    ?? session.maxPlayers;

            }

            this._append(
                envelope.payload?.roomId,
                "ROOM",
                "created",
                envelope.payload
            );

        });

        track(EVENT_TYPES.ROOM_FULL, (envelope) => {

            this._append(
                envelope.payload?.roomId,
                "ROOM",
                "full",
                envelope.payload
            );

        });

        track(EVENT_TYPES.ROOM_LOCKED, (envelope) => {

            this._append(
                envelope.payload?.roomId,
                "ROOM",
                "lock",
                envelope.payload
            );

        });

        track(EVENT_TYPES.ROOM_UNLOCKED, (envelope) => {

            this._append(
                envelope.payload?.roomId,
                "ROOM",
                "unlock",
                envelope.payload
            );

        });

        track(EVENT_TYPES.ROOM_DESTROYED, (envelope) => {

            const roomId = envelope.payload?.roomId;

            const session = this._sessions.get(roomId);

            if (session) {

                session.flags.roomDestroyed = true;

            }

            this._append(roomId, "ROOM", "destroy", envelope.payload);

            this._closeSession(roomId, "ROOM_DESTROYED");

        });

        track(EVENT_TYPES.SETUP_SESSION_STARTED, (envelope) => {

            const payload = envelope.payload ?? {};

            const roomId = payload.roomId;

            this._openSession({ roomId });

            const session = this._sessions.get(roomId);

            if (session) {

                session.flags.setupStarted = true;

                session.setupExpiresAt = payload.expiresAt ?? null;

            }

            this._append(roomId, "SETUP SESSION", "started", payload);

            this._append(roomId, "GENERAL", "Setup expiresAt", {
                expiresAt: payload.expiresAt ?? null,
                setupSessionId: payload.setupSessionId ?? null
            });

        });

        track(EVENT_TYPES.SETUP_SESSION_COMPLETED, (envelope) => {

            const roomId = envelope.payload?.roomId;

            const session = this._sessions.get(roomId);

            if (session) {

                session.flags.setupCompleted = true;

            }

            this._append(roomId, "SETUP SESSION", "completed", envelope.payload);

        });

        track(EVENT_TYPES.SETUP_SESSION_EXPIRED, (envelope) => {

            const roomId = envelope.payload?.roomId;

            const session = this._sessions.get(roomId);

            if (session) {

                session.flags.setupExpired = true;

            }

            this._append(roomId, "SETUP SESSION", "expired", envelope.payload);

        });

        track(EVENT_TYPES.SETUP_SESSION_SYNC, (envelope) => {

            const roomId = envelope.payload?.roomId;

            const session = this._sessions.get(roomId);

            // Normal setup also emits SETUP_SESSION_SYNC — only attribute to
            // recovery when a reclaim attempt is already in flight.
            if (session?.activeRecovery
                || session?.flags?.sessionRecoveryRequest
                || session?.flags?.clientDisconnected) {

                this._markRecoveryStep(roomId, "SETUP_SESSION_SYNC", envelope.payload);

                this._append(roomId, "RECOVERY", "SETUP_SESSION_SYNC", envelope.payload);

            } else {

                this._append(roomId, "SETUP SESSION", "SETUP_SESSION_SYNC", envelope.payload);

            }

        });

        track(EVENT_TYPES.PLAYER_JOINED, (envelope) => {

            const { roomId, playerId } = envelope.payload ?? {};

            if (roomId && playerId) {

                this._playerToRoom.set(playerId, roomId);

            }

            const session = this._sessions.get(roomId);

            if (session) {

                session.flags.playerJoinedCount += 1;

                session.playerIds.add(playerId);

            }

            this._append(roomId, "ROOM", "join", {
                ...envelope.payload,
                nickname: this._nickname(playerId)
            });

            this._append(roomId, "PLAYERS", "joined", {
                playerId,
                nickname: this._nickname(playerId)
            });

        });

        track(EVENT_TYPES.PLAYER_LEFT, (envelope) => {

            const { roomId, playerId } = envelope.payload ?? {};

            this._append(roomId, "ROOM", "leave", {
                ...envelope.payload,
                nickname: this._nickname(playerId)
            });

        });

        track(EVENT_TYPES.PLAYER_CREATED, (envelope) => {

            const playerId = envelope.payload?.playerId;

            const roomId = this._playerToRoom.get(playerId)
                ?? envelope.payload?.roomId
                ?? null;

            this._append(roomId, "PLAYERS", "created", {
                playerId,
                nickname: envelope.payload?.nickname
                    ?? this._nickname(playerId)
            });

        });

        track(EVENT_TYPES.PLAYER_CONNECTED, (envelope) => {

            const playerId = envelope.payload?.playerId;

            const roomId = this._resolveRoomId(envelope.payload);

            this._append(roomId, "PLAYERS", "connection CONNECTED", {
                playerId,
                nickname: this._nickname(playerId),
                ...envelope.payload
            });

        });

        track(EVENT_TYPES.PLAYER_DISCONNECTED, (envelope) => {

            const playerId = envelope.payload?.playerId;

            const roomId = this._resolveRoomId(envelope.payload);

            const session = this._sessions.get(roomId);

            if (session) {

                session.flags.clientDisconnected = true;

            }

            this._append(roomId, "PLAYERS", "connection DISCONNECTED", {
                playerId,
                nickname: this._nickname(playerId),
                ...envelope.payload
            });

        });

        track(EVENT_TYPES.PLAYER_RUNTIME_UPDATED, (envelope) => {

            const playerId = envelope.payload?.playerId;

            const roomId = this._resolveRoomId(envelope.payload);

            const connectionState = envelope.payload?.connectionState
                ?? envelope.payload?.runtime?.connectionState;

            if (connectionState) {

                this._append(roomId, "PLAYERS", `connection ${connectionState}`, {
                    playerId,
                    nickname: this._nickname(playerId)
                });

            }

        });

        track(EVENT_TYPES.LOBBY_SOCKET_DELIVERY, (envelope) => {

            const delivery = envelope.payload ?? {};

            const eventName = delivery.event;

            const roomId = delivery.roomId
                ?? delivery.payload?.roomId
                ?? this._resolveRoomId(delivery.payload);

            if (!eventName || !roomId) {

                return;

            }

            const session = this._sessions.get(roomId);

            if (!session || session.closed) {

                return;

            }

            if (eventName === "VERIFY_COMPLETED") {

                session.flags.verifyCompleted = true;

                this._append(roomId, "ROOM", "VERIFY_COMPLETED", {
                    roomId,
                    event: eventName
                });

            }

            if (eventName === "PAYMENT_STAGE_READY"
                || eventName === "ENTRY_PAYMENT_SESSION_UPDATED"
                || eventName === "PAYMENT_SESSION_CREATED") {

                session.flags.paymentEntered = true;

                this._append(roomId, "ROOM", "PAYMENT_ENTERED", {
                    roomId,
                    event: eventName
                });

            }

            if (eventName === "SETUP_SESSION_SYNC"
                && (session.activeRecovery
                    || session.flags.sessionRecoveryRequest
                    || session.flags.clientDisconnected)) {

                this._markRecoveryStep(roomId, "SETUP_SESSION_SYNC", {
                    socketId: delivery.socketId ?? null
                });

            }

        });

        track(EVENT_TYPES.ENTRY_PAYMENT_COMPLETED, (envelope) => {

            const roomId = envelope.payload?.roomId;

            const session = this._sessions.get(roomId);

            if (session) {

                session.flags.paymentEntered = true;

            }

            this._append(roomId, "ROOM", "ENTRY_PAYMENT_COMPLETED", envelope.payload);

        });

        track(EVENT_TYPES.GAME_CREATED, (envelope) => {

            const { roomId, gameId } = envelope.payload ?? {};

            if (roomId && gameId) {

                this._gameToRoom.set(gameId, roomId);

                const session = this._sessions.get(roomId);

                if (session) {

                    session.gameId = gameId;

                }

            }

            this._append(roomId, "GENERAL", "Game ID", { gameId });

            this._append(roomId, "GAMEPLAY", "GAME_CREATED", envelope.payload);

        });

        track(EVENT_TYPES.GAME_INITIALIZED, (envelope) => {

            const roomId = this._resolveRoomId(envelope.payload);

            const session = this._sessions.get(roomId);

            if (session) {

                session.flags.gameInitialized = true;

                if (envelope.payload?.gameId) {

                    session.gameId = envelope.payload.gameId;

                    this._gameToRoom.set(envelope.payload.gameId, roomId);

                }

            }

            this._append(roomId, "GAMEPLAY", "GAME_INITIALIZED", envelope.payload);

        });

        track(EVENT_TYPES.GAME_STARTED, (envelope) => {

            const roomId = this._resolveRoomId(envelope.payload);

            const session = this._sessions.get(roomId);

            if (session) {

                session.flags.gameStarted = true;

            }

            this._append(roomId, "GAMEPLAY", "GAME_STARTED", envelope.payload);

        });

        const phaseEvents = [
            EVENT_TYPES.GAME_STATE_CHANGED,
            EVENT_TYPES.READY_STARTED,
            EVENT_TYPES.READY_COMPLETED,
            EVENT_TYPES.SELF_TEST_STARTED,
            EVENT_TYPES.SELF_TEST_COMPLETED,
            EVENT_TYPES.SPEED_STARTED,
            EVENT_TYPES.SPEED_COMPLETED,
            EVENT_TYPES.BRAKE_STARTED,
            EVENT_TYPES.BRAKE_COMPLETED,
            EVENT_TYPES.RESULT_STARTED,
            EVENT_TYPES.RESULT_COMPLETED,
            EVENT_TYPES.PRE_GAME_READY_STARTED,
            EVENT_TYPES.PRE_GAME_READY_COMPLETED
        ];

        for (const event of phaseEvents) {

            track(event, (envelope) => {

                const roomId = this._resolveRoomId(envelope.payload);

                const session = this._sessions.get(roomId);

                if (session
                    && (event === EVENT_TYPES.READY_STARTED
                        || event === EVENT_TYPES.SPEED_STARTED
                        || event === EVENT_TYPES.GAME_STATE_CHANGED)) {

                    session.flags.gameStarted = true;

                }

                this._append(
                    roomId,
                    "GAMEPLAY",
                    `phase ${event}`,
                    envelope.payload
                );

            });

        }

        track(EVENT_TYPES.LOBBY_SOCKET_DISCONNECTED, (envelope) => {

            const socketId = envelope.payload?.socketId ?? null;

            for (const [roomId, session] of this._sessions.entries()) {

                if (session.closed) {

                    continue;

                }

                if (socketId && session.socketIds.has(socketId)) {

                    session.flags.clientDisconnected = true;

                    this._append(roomId, "RECOVERY", "disconnect", {
                        socketId,
                        reason: envelope.payload?.reason ?? null
                    });

                }

            }

        });

        track(EVENT_TYPES.RECOVERY_STARTED, (envelope) => {

            const roomId = this._resolveRoomId(envelope.payload);

            this._beginRecoveryAttempt(roomId, envelope.payload);

            this._append(roomId, "RECOVERY", "RECOVERY_STARTED", envelope.payload);

        });

        track(EVENT_TYPES.PLAYER_RECOVERED, (envelope) => {

            const roomId = this._resolveRoomId(envelope.payload);

            this._completeRecoveryAttempt(roomId, true, envelope.payload);

            this._append(
                roomId,
                "RECOVERY",
                "recovery completed (player)",
                envelope.payload
            );

        });

        track(EVENT_TYPES.SESSION_RECOVERED, (envelope) => {

            const roomId = this._resolveRoomId(envelope.payload);

            this._completeRecoveryAttempt(roomId, true, envelope.payload);

            this._append(
                roomId,
                "RECOVERY",
                "recovery completed (session)",
                envelope.payload
            );

        });

        track(EVENT_TYPES.RECOVERY_FAILED, (envelope) => {

            const roomId = this._resolveRoomId(envelope.payload);

            this._failRecoveryAttempt(
                roomId,
                "RECOVERY_FAILED",
                envelope.payload?.reason ?? "recovery failed",
                envelope.payload
            );

            this._append(roomId, "ERRORS", "recovery failed", envelope.payload);

        });

        track(EVENT_TYPES.OPEN_PAGE6, (envelope) => {

            const roomId = this._resolveRoomId(envelope.payload);

            this._append(roomId, "GAMEPLAY", "OPEN_PAGE6", {
                gameId: envelope.payload?.gameId ?? null,
                roomId,
                timestamp: envelope.payload?.timestamp ?? Date.now()
            });

        });

        track(EVENT_TYPES.RESULT_SESSION_EXPIRED, (envelope) => {

            const roomId = envelope.payload?.roomId
                ?? this._resolveRoomId(envelope.payload);

            this._append(roomId, "GAMEPLAY", "RESULT_SESSION_EXPIRED", {
                roomId,
                gameId: envelope.payload?.gameId ?? null,
                reason: envelope.payload?.reason ?? null,
                expiresAt: envelope.payload?.expiresAt ?? null,
                startedAt: envelope.payload?.startedAt ?? null,
                timestamp: envelope.payload?.timestamp ?? Date.now()
            });

        });

        track(EVENT_TYPES.CLIENT_PAGE6_DIAGNOSTIC, (envelope) => {

            const payload = envelope.payload ?? {};

            const roomId = payload.roomId
                ?? this._resolveRoomId(payload);

            if (!roomId) {

                return;

            }

            this._append(
                roomId,
                "CLIENT_PAGE6",
                `[R12.5G ClientDiag] ${payload.event ?? "UNKNOWN"}`,
                {
                    diagnosticSource: payload.diagnosticSource ?? "client",
                    diagnosticVersion: payload.diagnosticVersion ?? "R12.5G",
                    roomId,
                    gameId: payload.gameId ?? null,
                    playerId: payload.playerId ?? null,
                    socketId: payload.socketId ?? null,
                    clientType: payload.clientType ?? "unknown",
                    currentPage: payload.currentPage ?? null,
                    currentPageType: payload.currentPageType ?? null,
                    timestamp: payload.timestamp ?? Date.now(),
                    event: payload.event ?? null,
                    footerMode: payload.footerMode ?? null,
                    timerLabel: payload.timerLabel ?? null,
                    timerValue: payload.timerValue ?? null,
                    page6Mounted: payload.page6Mounted ?? null,
                    page6DomPresent: payload.page6DomPresent ?? null,
                    page6DomVisible: payload.page6DomVisible ?? null,
                    page6HeadlineText: payload.page6HeadlineText ?? null,
                    headerMessageText: payload.headerMessageText ?? null,
                    infoBarPresent: payload.infoBarPresent ?? null,
                    infoBarTimerLabelText: payload.infoBarTimerLabelText ?? null,
                    infoBarTimerValueText: payload.infoBarTimerValueText ?? null,
                    resultSessionExpiresAt: payload.resultSessionExpiresAt ?? null,
                    remainingResultSessionSeconds:
                        payload.remainingResultSessionSeconds ?? null,
                    combination: payload.combination ?? null,
                    socketConnected: payload.socketConnected ?? null,
                    visibilityState: payload.visibilityState ?? null,
                    recoveryDecision: payload.recoveryDecision ?? null,
                    navigationTarget: payload.navigationTarget ?? null,
                    source: payload.source ?? null,
                    reason: payload.reason ?? null
                }
            );

        });

        track(EVENT_TYPES.SESSION_FINISHED, (envelope) => {

            const roomId = envelope.payload?.roomId
                ?? this._resolveRoomId(envelope.payload);

            const session = this._sessions.get(roomId);

            if (session) {

                session.flags.sessionFinished = true;

            }

            this._append(roomId, "GAMEPLAY", "SESSION_FINISHED", envelope.payload);

            this._closeSession(roomId, "SESSION_FINISHED");

        });

        track(EVENT_TYPES.GAME_DESTROYED, (envelope) => {

            const roomId = this._resolveRoomId(envelope.payload);

            this._append(roomId, "GAMEPLAY", "GAME_DESTROYED", envelope.payload);

            if (roomId) {

                this._closeSession(roomId, "GAME_DESTROYED");

            }

        });

        track(EVENT_TYPES.SERVER_SHUTDOWN, () => {

            for (const roomId of [...this._sessions.keys()]) {

                this._closeSession(roomId, "shutdown");

            }

        });

    }

    _openSession(payload = {}) {

        if (!this._enabled) {

            return;

        }

        const roomId = payload.roomId;

        if (!roomId || this._sessions.has(roomId)) {

            return;

        }

        const createdAt = Date.now();

        const filename = `${formatFilenameTimestamp(createdAt)}_ROOM_${safeSegment(roomId)}.log`;

        const filePath = join(this._directory, filename);

        let fd;

        try {

            fd = openSync(filePath, "a");

        } catch {

            return;

        }

        const session = {
            roomId,
            filePath,
            baseFilename: filename,
            fd,
            createdAt,
            closedAt: null,
            gameId: null,
            setupExpiresAt: null,
            maxPlayers: payload.maxPlayers ?? 3,
            closed: false,
            socketIds: new Set(),
            playerIds: new Set(),
            flags: createFlags(),
            recoveryAttempts: [],
            activeRecovery: null,
            shutdownReason: null,
            outcome: null
        };

        this._sessions.set(roomId, session);

        this._writeLine(session, "GENERAL", "Room diagnostic log opened", {
            roomId,
            creationTime: formatTimestamp(createdAt),
            filename
        });

        this._writeLine(session, "GENERAL", "Room ID", { roomId });

        this._writeLine(session, "GENERAL", "creation time", {
            creationTime: formatTimestamp(createdAt),
            createdAtMs: createdAt
        });

        this._loggingManager?.write({
            level: LOG_LEVELS.INFO,
            channel: LOG_CHANNELS.APPLICATION,
            service: SERVICE,
            message: "Opened room diagnostic log",
            fields: { roomId, filename }
        });

    }

    _closeSession(roomId, reason) {

        const session = this._sessions.get(roomId);

        if (!session || session.closed) {

            return;

        }

        if (session.activeRecovery) {

            // Incomplete attempt at close → mark failed unless already finished.
            this._failRecoveryAttempt(
                roomId,
                session.activeRecovery.failurePoint ?? "INCOMPLETE",
                session.activeRecovery.failureReason ?? "session closed during recovery",
                {
                    playerId: session.activeRecovery.playerId,
                    socketId: session.activeRecovery.socketId
                }
            );

        }

        session.shutdownReason = reason;

        session.closedAt = Date.now();

        session.outcome = this._resolveOutcome(session);

        this._writeLine(session, "GENERAL", "Room diagnostic log closing", {
            reason,
            gameId: session.gameId,
            outcome: session.outcome
        });

        this._appendSummary(session);

        this._appendChecklist(session);

        this._appendRecoveryFailures(session);

        this._appendRecoveryAttemptSummary(session);

        try {

            closeSync(session.fd);

        } catch {
            // ignore
        }

        session.fd = null;

        session.closed = true;

        this._renameClosedLog(session);

        if (session.gameId) {

            this._gameToRoom.delete(session.gameId);

        }

    }

    _resolveOutcome(session) {

        if (session.flags.setupExpired && !session.flags.gameInitialized) {

            return OUTCOMES.SETUP_EXPIRED;

        }

        if (session.flags.gameInitialized
            || session.flags.gameStarted
            || session.flags.sessionFinished) {

            return OUTCOMES.GAME_COMPLETED;

        }

        const failed = session.recoveryAttempts.filter((a) => a.success === false);

        if (failed.length > 0) {

            return OUTCOMES.RECOVERY_FAILED;

        }

        return OUTCOMES.ROOM_DESTROYED;

    }

    _renameClosedLog(session) {

        if (!session?.filePath || !session.outcome) {

            return;

        }

        const directory = dirname(session.filePath);

        const currentName = basename(session.filePath);

        const withoutExt = currentName.replace(/\.log$/i, "");

        // Avoid double-suffix if somehow closed twice.
        const base = withoutExt.replace(
            /_(GAME_COMPLETED|SETUP_EXPIRED|RECOVERY_FAILED|ROOM_DESTROYED)$/,
            ""
        );

        const nextName = `${base}_${session.outcome}.log`;

        const nextPath = join(directory, nextName);

        if (nextPath === session.filePath) {

            return;

        }

        try {

            renameSync(session.filePath, nextPath);

            session.filePath = nextPath;

        } catch {
            // Keep original path if rename fails.
        }

    }

    _appendSummary(session) {

        const failed = session.recoveryAttempts.filter((a) => a.success === false);

        const succeeded = session.recoveryAttempts.filter((a) => a.success === true);

        const setupState = session.flags.setupExpired
            ? "EXPIRED"
            : session.flags.setupCompleted
                ? "COMPLETED"
                : session.flags.setupStarted
                    ? "ACTIVE"
                    : "NONE";

        const gameplayState = session.flags.gameStarted
            || session.flags.gameInitialized
            ? "STARTED"
            : "NOT_STARTED";

        const lines = [
            "",
            "==========================================================",
            "SUMMARY",
            "==========================================================",
            "",
            "Room ID:",
            session.roomId,
            "",
            "Game ID:",
            session.gameId ?? "—",
            "",
            "Duration:",
            formatDuration((session.closedAt ?? Date.now()) - session.createdAt),
            "",
            "Players:",
            String(session.playerIds.size || session.flags.playerJoinedCount),
            "",
            "Setup Session:",
            setupState,
            "",
            "Gameplay:",
            gameplayState,
            "",
            "Recovery attempts:",
            String(session.recoveryAttempts.length),
            "",
            "Successful recoveries:",
            String(succeeded.length),
            "",
            "Failed recoveries:",
            String(failed.length),
            "",
            "Room result:",
            session.outcome ?? OUTCOMES.ROOM_DESTROYED,
            "",
            "Shutdown reason:",
            session.shutdownReason ?? "UNKNOWN",
            "",
            "==========================================================",
            ""
        ];

        this._writeRaw(session, lines.join("\n"));

    }

    _appendChecklist(session) {

        const flags = session.flags;

        const expectedPlayers = session.maxPlayers || 3;

        const playerJoinStatus = flags.playerJoinedCount >= expectedPlayers
            ? CHECK_STATUS.OK
            : flags.playerJoinedCount > 0
                ? CHECK_STATUS.FAILED
                : CHECK_STATUS.NO;

        const recoveryExpected = flags.clientDisconnected
            || flags.sessionRecoveryRequest
            || session.recoveryAttempts.length > 0;

        const items = [
            ["ROOM_CREATED", flags.roomCreated ? CHECK_STATUS.OK : CHECK_STATUS.NO],
            [
                "SETUP_SESSION_STARTED",
                flags.setupStarted ? CHECK_STATUS.OK : CHECK_STATUS.NO
            ],
            [
                `PLAYER_JOINED x${expectedPlayers}`,
                playerJoinStatus
            ],
            [
                "VERIFY_COMPLETED",
                flags.verifyCompleted
                    ? CHECK_STATUS.OK
                    : flags.gameInitialized
                        ? CHECK_STATUS.UNKNOWN
                        : CHECK_STATUS.NO
            ],
            [
                "PAYMENT_ENTERED",
                flags.paymentEntered
                    ? CHECK_STATUS.OK
                    : flags.gameInitialized
                        ? CHECK_STATUS.UNKNOWN
                        : CHECK_STATUS.NO
            ],
            [
                "GAME_INITIALIZED",
                flags.gameInitialized ? CHECK_STATUS.OK : CHECK_STATUS.NO
            ],
            [
                "CLIENT_DISCONNECTED",
                flags.clientDisconnected
                    ? CHECK_STATUS.OK
                    : recoveryExpected
                        ? CHECK_STATUS.NO
                        : CHECK_STATUS.SKIPPED
            ],
            [
                "SESSION_RECOVERY_REQUEST",
                flags.sessionRecoveryRequest
                    ? CHECK_STATUS.OK
                    : recoveryExpected
                        ? CHECK_STATUS.NO
                        : CHECK_STATUS.SKIPPED
            ],
            [
                "PLAYER_FOUND",
                flags.playerFound
                    ? CHECK_STATUS.OK
                    : this._recoveryHadFailureAt(session, "PLAYER_FOUND")
                        ? CHECK_STATUS.FAILED
                        : recoveryExpected
                            ? CHECK_STATUS.NO
                            : CHECK_STATUS.SKIPPED
            ],
            [
                "SOCKET_REBOUND",
                flags.socketRebound
                    ? CHECK_STATUS.OK
                    : this._recoveryHadFailureAt(session, "SOCKET_REBOUND")
                        ? CHECK_STATUS.FAILED
                        : recoveryExpected
                            ? CHECK_STATUS.NO
                            : CHECK_STATUS.SKIPPED
            ],
            [
                "SETUP_SESSION_SYNC",
                flags.setupSessionSync
                    ? CHECK_STATUS.OK
                    : this._recoveryHadFailureAt(session, "SETUP_SESSION_SYNC")
                        ? CHECK_STATUS.FAILED
                        : recoveryExpected && flags.sessionRecoveryRequest
                            ? CHECK_STATUS.NOT_SENT
                            : recoveryExpected
                                ? CHECK_STATUS.NO
                                : CHECK_STATUS.SKIPPED
            ],
            [
                "RECOVERY_COMPLETED",
                flags.recoveryCompleted
                    ? CHECK_STATUS.OK
                    : flags.recoveryFailed
                        ? CHECK_STATUS.FAILED
                        : recoveryExpected
                            ? CHECK_STATUS.NO
                            : CHECK_STATUS.SKIPPED
            ],
            [
                "ROOM_DESTROYED",
                flags.roomDestroyed
                    || session.shutdownReason === "ROOM_DESTROYED"
                    || session.shutdownReason === "SESSION_FINISHED"
                    || session.shutdownReason === "GAME_DESTROYED"
                    ? CHECK_STATUS.OK
                    : CHECK_STATUS.NO
            ]
        ];

        const lines = [
            "==========================================================",
            "CHECKLIST",
            "==========================================================",
            "",
            ...items.map(([label, status]) => checklistLine(label, status)),
            "",
            "==========================================================",
            ""
        ];

        this._writeRaw(session, lines.join("\n"));

    }

    _appendRecoveryFailures(session) {

        const failed = session.recoveryAttempts.filter((a) => a.success === false);

        if (failed.length === 0) {

            return;

        }

        const blocks = [
            "==========================================================",
            "RECOVERY FAILURE",
            "==========================================================",
            ""
        ];

        for (const attempt of failed) {

            blocks.push(`Attempt:`);

            blocks.push(`#${attempt.index}`);

            blocks.push("");

            blocks.push("Failure point:");

            blocks.push("");

            blocks.push(attempt.failurePoint ?? "UNKNOWN");

            blocks.push("");

            blocks.push("Failure reason:");

            blocks.push("");

            blocks.push(attempt.failureReason ?? "unknown");

            blocks.push("");

            blocks.push("Room ID:");

            blocks.push(session.roomId);

            blocks.push("");

            blocks.push("Player ID:");

            blocks.push(attempt.playerId ?? "—");

            blocks.push("");

            blocks.push("Socket ID:");

            blocks.push(attempt.socketId ?? "—");

            blocks.push("");

            blocks.push("Last successful recovery step:");

            blocks.push("");

            blocks.push(attempt.lastSuccessStep ?? "NONE");

            blocks.push("");

            blocks.push("----------------------------------------------------------");

            blocks.push("");

        }

        blocks.push("==========================================================");

        blocks.push("");

        this._writeRaw(session, blocks.join("\n"));

    }

    _appendRecoveryAttemptSummary(session) {

        if (session.recoveryAttempts.length === 0) {

            return;

        }

        const lines = [
            "==========================================================",
            "RECOVERY ATTEMPTS",
            "==========================================================",
            ""
        ];

        for (const attempt of session.recoveryAttempts) {

            lines.push(`Attempt #${attempt.index}`);

            lines.push("");

            lines.push(attempt.success === true
                ? "SUCCESS"
                : attempt.success === false
                    ? "FAILED"
                    : "UNKNOWN");

            lines.push("");

        }

        lines.push("==========================================================");

        lines.push("");

        this._writeRaw(session, lines.join("\n"));

    }

    _recoveryHadFailureAt(session, point) {

        return session.recoveryAttempts.some(
            (attempt) => attempt.success === false
                && attempt.failurePoint === point
        );

    }

    _beginRecoveryAttempt(roomId, payload = {}) {

        const session = this._sessions.get(roomId);

        if (!session || session.closed) {

            return null;

        }

        if (session.activeRecovery) {

            return session.activeRecovery;

        }

        const attempt = {
            index: session.recoveryAttempts.length + 1,
            startedAt: Date.now(),
            steps: [],
            success: null,
            failurePoint: null,
            failureReason: null,
            lastSuccessStep: null,
            playerId: payload.playerId ?? null,
            socketId: payload.socketId ?? null
        };

        session.activeRecovery = attempt;

        session.flags.sessionRecoveryRequest = true;

        return attempt;

    }

    _markRecoveryStep(roomId, step, payload = {}) {

        const session = this._sessions.get(roomId);

        if (!session || session.closed) {

            return;

        }

        let attempt = session.activeRecovery;

        if (!attempt
            && (step === "SESSION_RECOVERY_REQUEST"
                || step === "CLIENT_DISCONNECTED")) {

            if (step === "SESSION_RECOVERY_REQUEST") {

                attempt = this._beginRecoveryAttempt(roomId, payload);

            }

            // CLIENT_DISCONNECTED alone does not open an attempt.

        }

        if (!attempt && step !== "CLIENT_DISCONNECTED") {

            // Late recovery step without an open attempt — start one.
            attempt = this._beginRecoveryAttempt(roomId, payload);

        }

        if (step === "CLIENT_DISCONNECTED") {

            session.flags.clientDisconnected = true;

            if (!attempt) {

                return;

            }

        }

        if (!attempt) {

            return;

        }

        if (payload.playerId) {

            attempt.playerId = payload.playerId;

        }

        if (payload.socketId) {

            attempt.socketId = payload.socketId;

        }

        attempt.steps.push(step);

        attempt.lastSuccessStep = step;

        if (step === "SESSION_RECOVERY_REQUEST") {

            session.flags.sessionRecoveryRequest = true;

        }

        if (step === "PLAYER_FOUND") {

            session.flags.playerFound = true;

        }

        if (step === "SOCKET_REBOUND") {

            session.flags.socketRebound = true;

        }

        if (step === "SETUP_SESSION_SYNC") {

            session.flags.setupSessionSync = true;

        }

        if (step === "CLIENT_DISCONNECTED") {

            session.flags.clientDisconnected = true;

        }

    }

    _completeRecoveryAttempt(roomId, success, payload = {}) {

        const session = this._sessions.get(roomId);

        if (!session || session.closed) {

            return;

        }

        const attempt = session.activeRecovery
            ?? this._beginRecoveryAttempt(roomId, payload);

        if (!attempt) {

            return;

        }

        if (payload.playerId) {

            attempt.playerId = payload.playerId;

        }

        if (payload.socketId) {

            attempt.socketId = payload.socketId;

        }

        attempt.success = success === true;

        if (success) {

            session.flags.recoveryCompleted = true;

            attempt.steps.push("RECOVERY_COMPLETED");

            attempt.lastSuccessStep = "RECOVERY_COMPLETED";

        }

        session.recoveryAttempts.push(attempt);

        session.activeRecovery = null;

    }

    _failRecoveryAttempt(roomId, failurePoint, reason, payload = {}) {

        const session = this._sessions.get(roomId);

        if (!session || session.closed) {

            return;

        }

        const attempt = session.activeRecovery
            ?? this._beginRecoveryAttempt(roomId, payload);

        if (!attempt) {

            return;

        }

        if (payload.playerId) {

            attempt.playerId = payload.playerId;

        }

        if (payload.socketId) {

            attempt.socketId = payload.socketId;

        }

        attempt.success = false;

        attempt.failurePoint = failurePoint;

        attempt.failureReason = reason;

        session.flags.recoveryFailed = true;

        session.recoveryAttempts.push(attempt);

        session.activeRecovery = null;

    }

    _append(roomId, section, event, payload = {}) {

        if (!this._enabled || !roomId) {

            return;

        }

        const session = this._sessions.get(roomId);

        if (!session || session.closed) {

            return;

        }

        const socketId = payload?.socketId
            ?? payload?.socket?.id
            ?? null;

        if (socketId) {

            session.socketIds.add(socketId);

            this._writeLine(session, "PLAYERS", "socket.id history", {
                socketId,
                playerId: payload.playerId ?? null,
                event
            });

        }

        this._writeLine(session, section, event, payload);

    }

    _writeLine(session, section, event, payload = {}) {

        if (!session?.fd || session.closed) {

            return;

        }

        const compact = this._compactPayload(payload);

        const line = `${formatTimestamp()} | [${section}] ${event}`
            + (compact ? ` | ${compact}` : "")
            + "\n";

        this._writeRaw(session, line);

    }

    _writeRaw(session, text) {

        if (!session?.fd || session.closed) {

            return;

        }

        try {

            writeSync(session.fd, text, null, "utf8");

        } catch {
            // Diagnostic must never throw into gameplay.
        }

    }

    _compactPayload(payload) {

        if (!payload || typeof payload !== "object") {

            return "";

        }

        const parts = [];

        for (const [key, value] of Object.entries(payload)) {

            if (value == null || value === "") {

                continue;

            }

            if (typeof value === "object") {

                continue;

            }

            parts.push(`${key}=${value}`);

        }

        return parts.join(" ");

    }

    _nickname(playerId) {

        if (!playerId || !this._playerManager) {

            return null;

        }

        try {

            return this._playerManager.getIdentity?.(playerId)?.nickname
                ?? null;

        } catch {

            return null;

        }

    }

    _resolveRoomId(payload = {}) {

        if (payload?.roomId) {

            return payload.roomId;

        }

        if (payload?.gameId && this._gameToRoom.has(payload.gameId)) {

            return this._gameToRoom.get(payload.gameId);

        }

        if (payload?.playerId && this._playerToRoom.has(payload.playerId)) {

            return this._playerToRoom.get(payload.playerId);

        }

        return null;

    }

    /**
     * Mirror LoggingManager records that belong to an open room (recovery traces).
     */
    _onLogRecord(record) {

        if (!this._enabled || !record) {

            return;

        }

        let roomId = record.roomId
            ?? extractFromMessage(record.message, ROOM_ID_IN_MESSAGE);

        if (!roomId && record.playerId) {

            roomId = this._playerToRoom.get(record.playerId) ?? null;

        }

        if (!roomId && record.gameId) {

            roomId = this._gameToRoom.get(record.gameId) ?? null;

        }

        if (!roomId) {

            return;

        }

        const session = this._sessions.get(roomId);

        if (!session || session.closed) {

            return;

        }

        const message = String(record.message ?? "");

        const socketId = record.socketId
            ?? extractFromMessage(message, SOCKET_ID_IN_MESSAGE);

        const playerId = record.playerId
            ?? extractFromMessage(message, PLAYER_ID_IN_MESSAGE);

        if (socketId) {

            session.socketIds.add(socketId);

        }

        let section = "GENERAL";

        let event = message;

        if (message.includes("[R6.2A Recovery]")) {

            section = "RECOVERY";

            event = message.replace(/^\[R6\.2A Recovery\]\s*/, "");

            this._ingestRecoveryTrace(session, roomId, event, {
                playerId,
                socketId,
                reason: extractFromMessage(message, REASON_IN_MESSAGE)
            });

            if (/reclaim failure|not authorized|not recoverable/i.test(message)) {

                section = "ERRORS";

            }

        } else if (record.level === LOG_LEVELS.ERROR
            || record.level === LOG_LEVELS.FATAL) {

            section = "ERRORS";

            event = message;

        } else if (record.service === SERVICE) {

            return;

        } else if (record.level === LOG_LEVELS.ERROR
            || record.level === LOG_LEVELS.FATAL
            || record.level === LOG_LEVELS.WARN) {

            section = "ERRORS";

        } else {

            return;

        }

        this._writeLine(session, section, event, {
            playerId,
            socketId,
            gameId: record.gameId ?? session.gameId,
            level: record.level
        });

    }

    _ingestRecoveryTrace(session, roomId, eventText, payload = {}) {

        const text = String(eventText ?? "");

        if (/soft disconnect|CLIENT_DISCONNECTED|disconnect/i.test(text)
            && !/SESSION_RECOVERY_REQUEST/i.test(text)) {

            session.flags.clientDisconnected = true;

            this._markRecoveryStep(roomId, "CLIENT_DISCONNECTED", payload);

        }

        if (/SESSION_RECOVERY_REQUEST received/i.test(text)) {

            this._beginRecoveryAttempt(roomId, payload);

            this._markRecoveryStep(roomId, "SESSION_RECOVERY_REQUEST", payload);

        }

        if (/stash lookup/i.test(text)) {

            if (/result=hit/i.test(text) || /source=active context/i.test(text)) {

                this._markRecoveryStep(roomId, "PLAYER_FOUND", payload);

            } else if (/result=miss|result=not recoverable|result=room mismatch/i.test(text)) {

                this._failRecoveryAttempt(
                    roomId,
                    "PLAYER_FOUND",
                    payload.reason ?? text,
                    payload
                );

            }

        }

        if (/socket rebound/i.test(text)) {

            this._markRecoveryStep(roomId, "SOCKET_REBOUND", payload);

        }

        if (/SETUP_SESSION_SYNC emitted/i.test(text)) {

            this._markRecoveryStep(roomId, "SETUP_SESSION_SYNC", payload);

        }

        if (/reclaim success/i.test(text)) {

            this._markRecoveryStep(roomId, "SOCKET_REBOUND", payload);

            this._completeRecoveryAttempt(roomId, true, payload);

        }

        if (/reclaim failure/i.test(text)) {

            let failurePoint = "RECLAIM";

            if (/not authorized/i.test(text)) {

                failurePoint = "SOCKET_REBOUND";

            } else if (/not recoverable/i.test(text)) {

                failurePoint = "PLAYER_FOUND";

            } else if (/Room session is not active/i.test(text)) {

                failurePoint = "ROOM";

            }

            // If we already rebound, prefer SOCKET_REBOUND as failure point.
            const attempt = session.activeRecovery;

            if (attempt?.steps?.includes("SOCKET_REBOUND")
                && !attempt.steps.includes("SETUP_SESSION_SYNC")) {

                failurePoint = "SETUP_SESSION_SYNC";

            } else if (attempt?.steps?.includes("PLAYER_FOUND")
                && !attempt.steps.includes("SOCKET_REBOUND")) {

                failurePoint = "SOCKET_REBOUND";

            }

            this._failRecoveryAttempt(
                roomId,
                failurePoint,
                payload.reason ?? text,
                payload
            );

        }

    }

}
