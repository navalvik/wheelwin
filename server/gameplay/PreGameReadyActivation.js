import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { getPhaseStartedEventType } from "./GameplayPhaseSequence.js";

/**
 * P5.11 — Server-authoritative PRE_GAME_READY preparation phase.
 *
 * Tracks per-player readiness, accepts PLAYER_READY_CONFIRM once per player,
 * and completes early when every registered player confirms. The GameClockEngine
 * owns the 3-minute timeout; this module never restarts that timer.
 */
export class PreGameReadyActivation {

    constructor({
        logger,
        eventBus,
        configurationEngine,
        gameStateEngine,
        gameClockEngine,
        physicsEngine = null,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._configurationEngine = configurationEngine;

        this._gameStateEngine = gameStateEngine;

        this._gameClockEngine = gameClockEngine;

        this._physicsEngine = physicsEngine;

        this._devMode = devMode;

        this._handlers = [];

        this._sessions = new Map();

        this._wheelBroadcastByGame = new Set();

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            getPhaseStartedEventType(GAME_STATES.PRE_GAME_READY),
            (envelope) => {

                this._handlePreGameReadyStarted(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.READY_STARTED,
            (envelope) => {

                const gameId = envelope.payload?.gameId;

                if (gameId) {

                    this.forgetGame(gameId);

                }

            }
        );

        this._subscribe(
            EVENT_TYPES.CLEANUP_COMPLETED,
            (envelope) => {

                const gameId = envelope.payload?.gameId;

                if (gameId) {

                    this.forgetGame(gameId);

                }

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._sessions.clear();

                this._wheelBroadcastByGame.clear();

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

        this._sessions.clear();

        this._wheelBroadcastByGame.clear();

        this._initialized = false;

    }

    forgetGame(gameId) {

        this._sessions.delete(gameId);

        this._wheelBroadcastByGame.delete(gameId);

    }

    handlePlayerReadyConfirm(gameId, playerId) {

        this._assertInitialized();

        if (!gameId || !playerId) {

            return { accepted: false, reason: "gameId and playerId are required" };

        }

        if (this._gameStateEngine.getState(gameId) !== GAME_STATES.PRE_GAME_READY) {

            return {
                accepted: false,
                reason: "Preparation confirmations are only allowed during PRE_GAME_READY"
            };

        }

        const session = this._sessions.get(gameId);

        if (!session) {

            return {
                accepted: false,
                reason: "Preparation session is not active"
            };

        }

        if (!(playerId in session.readyPlayers)) {

            return {
                accepted: false,
                reason: "Player is not registered for this game"
            };

        }

        if (session.readyPlayers[playerId] === true) {

            return { accepted: false, reason: "Player already confirmed readiness" };

        }

        session.readyPlayers[playerId] = true;

        this._emitClientEvent(EVENT_TYPES.PRE_GAME_READY_UPDATED, {
            gameId,
            readyPlayers: { ...session.readyPlayers },
            startedAt: session.startedAt,
            expiresAt: session.expiresAt,
            timestamp: Date.now()
        });

        if (this._areAllPlayersReady(session)) {

            this._gameClockEngine.completePreGameReadyPhase(gameId);

        }

        return { accepted: true };

    }

    getSnapshot(gameId) {

        const session = this._sessions.get(gameId);

        if (!session) {

            return null;

        }

        return {
            readyPlayers: { ...session.readyPlayers },
            startedAt: session.startedAt,
            expiresAt: session.expiresAt
        };

    }

    _handlePreGameReadyStarted(payload) {

        const gameId = payload?.gameId;

        if (!gameId || payload?.phase !== GAME_STATES.PRE_GAME_READY) {

            return;

        }

        if (this._sessions.has(gameId)) {

            return;

        }

        const configuration = this._configurationEngine.getConfiguration(gameId);

        if (!configuration) {

            this._logger.error(
                `PRE_GAME_READY failed: configuration missing (${gameId})`
            );

            return;

        }

        const playerIds = (configuration.players ?? []).map(
            (player) => player.playerId
        );

        const readyPlayers = Object.fromEntries(
            playerIds.map((playerId) => [playerId, false])
        );

        const startedAt = payload.startedAt ?? Date.now();

        const expiresAt = payload.endsAt
            ?? (startedAt + (payload.durationMs ?? 0));

        this._sessions.set(gameId, {
            gameId,
            readyPlayers,
            startedAt,
            expiresAt
        });

        this._broadcastWheelConfiguration(gameId, configuration);

        this._emitClientEvent(EVENT_TYPES.PRE_GAME_READY_STARTED, {
            gameId,
            readyPlayers: { ...readyPlayers },
            startedAt,
            expiresAt,
            timestamp: startedAt
        });

        if (this._devMode) {

            this._logger.info(
                `[PreGameReady] STARTED | gameId=${gameId}`
                + ` | players=${playerIds.length}`
            );

        }

    }

    _broadcastWheelConfiguration(gameId, configuration) {

        if (this._wheelBroadcastByGame.has(gameId)) {

            return;

        }

        this._wheelBroadcastByGame.add(gameId);

        const payload = {
            gameId,
            sectors: configuration.sectors ?? [],
            wheelAngle: configuration.wheel?.startAngle ?? null,
            triangleAngle: configuration.triangle?.startAngle ?? null
        };

        if (this._physicsEngine
            && Number.isFinite(payload.wheelAngle)
            && Number.isFinite(payload.triangleAngle)) {

            this._physicsEngine.setPoseDegrees(
                gameId,
                payload.wheelAngle,
                payload.triangleAngle
            );

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.PRE_GAME_READY_ACTIVATION,
            type: EVENT_TYPES.WHEEL_CONFIGURATION,
            payload
        });

    }

    _areAllPlayersReady(session) {

        const entries = Object.values(session.readyPlayers);

        return entries.length > 0 && entries.every((ready) => ready === true);

    }

    _emitClientEvent(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.PRE_GAME_READY_ACTIVATION,
            type,
            payload
        });

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("PreGameReadyActivation is not initialized");

        }

    }

}
