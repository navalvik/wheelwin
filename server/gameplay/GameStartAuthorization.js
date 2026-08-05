import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../models/PaymentSession.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";

/**
 * P6.7 — Authoritative gameplay start after blockchain payment confirmation.
 *
 * PAYMENTS_COMPLETE → GAME_START_AUTHORIZED → GAME_INITIALIZING → OPEN_PAGE5
 *
 * Clients never decide when the game starts. This module is the sole gate.
 */
export const GAME_START_PHASE = Object.freeze({
    AUTHORIZED: "GAME_START_AUTHORIZED",
    INITIALIZING: "GAME_INITIALIZING",
    OPENED: "OPEN_PAGE5",
    FAILED: "FAILED"
});

export class GameStartAuthorization {

    constructor({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameManager,
        paymentSessionManager,
        gameContractManager,
        configurationEngine,
        physicsEngine = null,
        gameClockEngine = null,
        gameplayContextResolver = null,
        recoveryEngine = null,
        auditLedger = null,
        roomConfig = null,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._roomManager = roomManager;

        this._playerManager = playerManager;

        this._gameManager = gameManager;

        this._paymentSessionManager = paymentSessionManager;

        this._gameContractManager = gameContractManager;

        this._configurationEngine = configurationEngine;

        this._physicsEngine = physicsEngine;

        this._gameClockEngine = gameClockEngine;

        this._gameplayContextResolver = gameplayContextResolver;

        this._recoveryEngine = recoveryEngine;

        this._auditLedger = auditLedger;

        this._expectedPlayers = roomConfig?.maxPlayers ?? 3;

        this._authorizationDurationMs = Number.isFinite(
            roomConfig?.gameStartAuthorizationDurationMs
        ) && roomConfig.gameStartAuthorizationDurationMs > 0
            ? roomConfig.gameStartAuthorizationDurationMs
            : 60 * 1000;

        this._devMode = devMode;

        // roomId → { phase, gameId, authorizedAt, initializingAt, openPage5At }
        this._lifecycleByRoom = new Map();

        // R7.24 — roomId → timeout while waiting for start gates.
        this._authorizationTimers = new Map();

        this._handlers = [];

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
            (envelope) => {

                this._evaluate(envelope.payload?.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_CONTRACT_PAYMENTS_COMPLETE,
            (envelope) => {

                this._evaluate(envelope.payload?.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_SESSION_FAILED,
            (envelope) => {

                this._abandon(envelope.payload?.roomId, "payment_session_failed");

            }
        );

        this._subscribe(
            EVENT_TYPES.ROOM_DESTROYED,
            (envelope) => {

                this._forgetRoom(envelope.payload?.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.SESSION_FINISHED,
            (envelope) => {

                this._forgetRoom(envelope.payload?.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._reset();

            }
        );

        this._initialized = true;

    }

    shutdown() {

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._reset();

        this._initialized = false;

    }

    getLifecycle(roomId) {

        return this._lifecycleByRoom.get(roomId) ?? null;

    }

    /**
     * Reconnect restore payload — current phase only; never re-runs bootstrap.
     */
    getReconnectSnapshot(roomId) {

        const lifecycle = this._lifecycleByRoom.get(roomId);

        if (!lifecycle) {

            return null;

        }

        return Object.freeze({
            roomId,
            gameId: lifecycle.gameId,
            phase: lifecycle.phase,
            authorizedAt: lifecycle.authorizedAt ?? null,
            initializingAt: lifecycle.initializingAt ?? null,
            openPage5At: lifecycle.openPage5At ?? null,
            blockchainCompletedAt: lifecycle.blockchainCompletedAt ?? null
        });

    }

    _evaluate(roomId) {

        if (!roomId || !this._initialized) {

            return;

        }

        const existing = this._lifecycleByRoom.get(roomId);

        if (
            existing
            && (
                existing.phase === GAME_START_PHASE.AUTHORIZED
                || existing.phase === GAME_START_PHASE.INITIALIZING
                || existing.phase === GAME_START_PHASE.OPENED
                || existing.phase === GAME_START_PHASE.FAILED
            )
        ) {

            return;

        }

        const gate = this._checkStartConditions(roomId);

        if (!gate.ok) {

            this._scheduleAuthorizationTimeout(roomId);

            return;

        }

        this._clearAuthorizationTimeout(roomId);

        this._authorizeAndBootstrap(roomId, gate);

    }

    _scheduleAuthorizationTimeout(roomId) {

        if (!roomId || this._authorizationTimers.has(roomId)) {

            return;

        }

        const timeoutId = setTimeout(() => {

            this._authorizationTimers.delete(roomId);

            const existing = this._lifecycleByRoom.get(roomId);

            if (
                existing
                && (
                    existing.phase === GAME_START_PHASE.AUTHORIZED
                    || existing.phase === GAME_START_PHASE.INITIALIZING
                    || existing.phase === GAME_START_PHASE.OPENED
                    || existing.phase === GAME_START_PHASE.FAILED
                )
            ) {

                return;

            }

            const gate = this._checkStartConditions(roomId);

            if (gate.ok) {

                this._authorizeAndBootstrap(roomId, gate);

                return;

            }

            this._logger.decisionTrace?.({
                stage: "LIFECYCLE_TIMEOUT",
                decision: "GAME_START_AUTHORIZATION_TIMEOUT",
                reason: gate.reason ?? "game_start_authorization_timeout",
                caller: "GameStartAuthorization._scheduleAuthorizationTimeout",
                nextAction: "GAME_START_FAILED → _closeRoom",
                roomId
            });

            this._fail(
                roomId,
                gate.gameId ?? null,
                gate.reason ?? "game_start_authorization_timeout"
            );

        }, this._authorizationDurationMs);

        this._authorizationTimers.set(roomId, timeoutId);

    }

    _clearAuthorizationTimeout(roomId) {

        const timeoutId = this._authorizationTimers.get(roomId);

        if (!timeoutId) {

            return;

        }

        clearTimeout(timeoutId);

        this._authorizationTimers.delete(roomId);

    }

    _checkStartConditions(roomId) {

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return { ok: false, reason: "room_missing" };

        }

        if (room.status === ROOM_STATUS.DESTROYED) {

            return { ok: false, reason: "room_cancelled" };

        }

        const session = this._paymentSessionManager?.getSession(roomId);

        if (!session || session.status !== PAYMENT_SESSION_STATUS.COMPLETED) {

            return { ok: false, reason: "payment_session_incomplete" };

        }

        if (!session.allConfirmed()) {

            return { ok: false, reason: "payments_not_all_confirmed" };

        }

        const unpaid = session.participants.some(
            (participant) => (
                participant.status !== PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            )
        );

        if (unpaid) {

            return { ok: false, reason: "seat_not_confirmed" };

        }

        const contract = this._gameContractManager?.getContract(roomId);

        if (
            !contract
            || contract.status !== GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE
        ) {

            return { ok: false, reason: "contract_not_payments_complete" };

        }

        const gameId = session.gameId
            ?? contract.gameId
            ?? this._gameManager?.getPendingGameplayGameId?.(roomId)
            ?? this._gameplayContextResolver?.resolveGameIdByRoomId?.(roomId)
            ?? null;

        if (!gameId) {

            return { ok: false, reason: "game_missing" };

        }

        if (this._recoveryEngine?.getRecoverySnapshot?.(gameId)) {

            return { ok: false, reason: "recovery_pending" };

        }

        return {
            ok: true,
            room,
            session,
            contract,
            gameId,
            blockchainCompletedAt: session.completedAt
                ?? contract.paymentsCompletedAt
                ?? Date.now()
        };

    }

    _authorizeAndBootstrap(roomId, gate) {

        this._clearAuthorizationTimeout(roomId);

        const { gameId, blockchainCompletedAt } = gate;

        const authorizedAt = Date.now();

        this._lifecycleByRoom.set(roomId, {
            phase: GAME_START_PHASE.AUTHORIZED,
            gameId,
            blockchainCompletedAt,
            authorizedAt,
            initializingAt: null,
            openPage5At: null
        });

        this._audit(roomId, {
            type: "BLOCKCHAIN_COMPLETE",
            gameId,
            at: blockchainCompletedAt
        });

        this._audit(roomId, {
            type: "GAME_START_AUTHORIZED",
            gameId,
            at: authorizedAt
        });

        this._emit(EVENT_TYPES.GAME_START_AUTHORIZED, {
            roomId,
            gameId,
            authorizedAt,
            blockchainCompletedAt
        });

        this._log(
            `GAME_START_AUTHORIZED | roomId=${roomId} | gameId=${gameId}`
        );

        const initializingAt = Date.now();

        const lifecycle = this._lifecycleByRoom.get(roomId);

        lifecycle.phase = GAME_START_PHASE.INITIALIZING;

        lifecycle.initializingAt = initializingAt;

        this._audit(roomId, {
            type: "GAME_INITIALIZING",
            gameId,
            at: initializingAt
        });

        this._emit(EVENT_TYPES.GAME_INITIALIZING, {
            roomId,
            gameId,
            initializingAt
        });

        this._log(
            `GAME_INITIALIZING | roomId=${roomId} | gameId=${gameId}`
        );

        const validation = this._validateBootstrap(roomId, gameId);

        if (!validation.ok) {

            this._fail(roomId, gameId, validation.reason);

            return;

        }

        const openPage5At = Date.now();

        lifecycle.phase = GAME_START_PHASE.OPENED;

        lifecycle.openPage5At = openPage5At;

        this._audit(roomId, {
            type: "OPEN_PAGE5",
            gameId,
            at: openPage5At
        });

        this._emit(EVENT_TYPES.GAME_START_BOOTSTRAP_READY, {
            roomId,
            gameId,
            openPage5At
        });

        this._log(
            `GAME_START_BOOTSTRAP_READY | roomId=${roomId} | gameId=${gameId}`
        );

    }

    _validateBootstrap(roomId, gameId) {

        const room = this._roomManager.getRoom(roomId);

        if (!room) {

            return { ok: false, reason: "room_missing" };

        }

        if (room.players.length !== this._expectedPlayers) {

            return { ok: false, reason: "room_not_full" };

        }

        for (const playerId of room.players) {

            if (!this._playerManager.getIdentity(playerId)) {

                return { ok: false, reason: "player_missing" };

            }

        }

        const game = this._gameManager?.getGame?.(gameId);

        if (!game) {

            return { ok: false, reason: "game_not_found" };

        }

        const configuration = this._configurationEngine
            ?.getConfiguration?.(gameId);

        if (!configuration) {

            return { ok: false, reason: "configuration_missing" };

        }

        if (
            configuration.traceSeed === undefined
            || configuration.traceSeed === null
            || configuration.traceSeed === ""
        ) {

            return { ok: false, reason: "trace_seed_missing" };

        }

        try {

            this._configurationEngine.validateConfiguration(configuration);

        } catch (error) {

            return {
                ok: false,
                reason: `configuration_invalid:${error?.message ?? "unknown"}`
            };

        }

        if (
            this._physicsEngine
            && !this._physicsEngine.getSimulation?.(gameId)
        ) {

            return { ok: false, reason: "simulation_missing" };

        }

        if (
            this._gameClockEngine
            && !this._gameClockEngine.getClock?.(gameId)
        ) {

            return { ok: false, reason: "clock_missing" };

        }

        // Re-check payment / contract gates immediately before open.
        const gate = this._checkStartConditions(roomId);

        if (!gate.ok) {

            return gate;

        }

        return { ok: true };

    }

    _fail(roomId, gameId, reason) {

        this._clearAuthorizationTimeout(roomId);

        const lifecycle = this._lifecycleByRoom.get(roomId);

        if (lifecycle) {

            lifecycle.phase = GAME_START_PHASE.FAILED;

            lifecycle.failReason = reason;

        } else {

            this._lifecycleByRoom.set(roomId, {
                phase: GAME_START_PHASE.FAILED,
                gameId,
                failReason: reason
            });

        }

        this._audit(roomId, {
            type: "GAME_START_FAILED",
            gameId,
            reason,
            at: Date.now()
        });

        this._emit(EVENT_TYPES.GAME_START_FAILED, {
            roomId,
            gameId,
            reason
        });

        this._log(
            `GAME_START_FAILED | roomId=${roomId} | gameId=${gameId} | `
                + `reason=${reason}`
        );

        // Keep FAILED latch so dual completion events cannot re-authorize.
        // Temporary bootstrap bookkeeping beyond the latch is not retained.

    }

    _abandon(roomId, reason) {

        if (!roomId) {

            return;

        }

        const lifecycle = this._lifecycleByRoom.get(roomId);

        if (!lifecycle || lifecycle.phase === GAME_START_PHASE.OPENED) {

            this._forgetRoom(roomId);

            return;

        }

        this._audit(roomId, {
            type: "GAME_START_ABANDONED",
            gameId: lifecycle.gameId ?? null,
            reason,
            at: Date.now()
        });

        this._forgetRoom(roomId);

    }

    _forgetRoom(roomId) {

        if (!roomId) {

            return;

        }

        this._clearAuthorizationTimeout(roomId);

        this._lifecycleByRoom.delete(roomId);

    }

    _audit(roomId, entry) {

        this._auditLedger?.append?.(roomId, Object.freeze({
            category: "GAME_START",
            ...entry
        }));

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.GAME_START_AUTHORIZATION,
            type,
            payload
        });

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _reset() {

        for (const roomId of [...this._authorizationTimers.keys()]) {

            this._clearAuthorizationTimeout(roomId);

        }

        this._lifecycleByRoom.clear();

    }

    _log(message) {

        this._logger.info(`[GameStartAuthorization] ${message}`);

    }

}
