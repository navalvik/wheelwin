import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { CONNECTION_STATE } from "../models/ConnectionState.js";

/**
 * P5.6B — Offline SPEED hold release.
 *
 * If a player disconnects while pressed during SPEED, the server performs one
 * authoritative RELEASE immediately. No synthetic PRESS cycles are generated.
 * Remaining cycles stay unused until reconnect (or SPEED ends).
 */
export class OfflineInputContinuation {

    constructor({
        logger,
        eventBus,
        inputAuthority,
        gameStateEngine,
        playerManager,
        gameCatalog,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._inputAuthority = inputAuthority;

        this._gameStateEngine = gameStateEngine;

        this._playerManager = playerManager;

        this._gameCatalog = gameCatalog;

        this._devMode = devMode;

        this._handlers = [];

        // gameId -> Set<playerId>
        this._rosters = new Map();

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.GAME_CREATED,
            (envelope) => {

                this._handleGameCreated(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PLAYER_DISCONNECTED,
            (envelope) => {

                this._handlePlayerDisconnected(envelope.payload);

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

    forgetGame(gameId) {

        this._rosters.delete(gameId);

    }

    /**
     * Diagnostics: P5.6B no longer keeps active continuation cursors.
     */
    getActiveContinuations() {

        return [];

    }

    _handleGameCreated(payload) {

        const gameId = payload?.gameId;

        if (!gameId || !Array.isArray(payload.players)) {

            return;

        }

        const roster = new Set();

        for (const entry of payload.players) {

            const playerId = this._resolvePlayerId(entry);

            if (playerId) {

                roster.add(playerId);

            }

        }

        this._rosters.set(gameId, roster);

    }

    _handlePlayerDisconnected(payload) {

        const playerId = payload?.playerId;

        if (!playerId) {

            return;

        }

        const gameId = this._resolveGameIdForPlayer(playerId);

        if (!gameId) {

            return;

        }

        if (this._gameStateEngine.getState(gameId) !== GAME_STATES.SPEED) {

            return;

        }

        this._releaseIfHolding(gameId, playerId);

    }

    _releaseIfHolding(gameId, playerId) {

        const state = this._inputAuthority.getPlayerInputState(gameId, playerId);

        if (!state || state.buttonPressed !== true) {

            return;

        }

        const released = this._inputAuthority.handleButtonRelease(
            gameId,
            playerId
        );

        if (released && this._devMode) {

            this._logger.info(
                `[OfflineInput] RELEASE on disconnect`
                + ` | gameId=${gameId}`
                + ` | playerId=${playerId}`
                + ` | completedCycles=${released.completedCycles ?? released.pressCount}`
                + ` | locked=${released.buttonLocked ?? released.locked}`
            );

        }

    }

    _resolveGameIdForPlayer(playerId) {

        for (const [gameId, roster] of this._rosters) {

            if (roster.has(playerId)) {

                return gameId;

            }

        }

        return null;

    }

    _resolvePlayerId(entry) {

        if (!entry) {

            return null;

        }

        if (typeof entry === "string") {

            return entry;

        }

        return entry.playerId ?? entry.id ?? null;

    }

    _isPlayerOnline(playerId) {

        const player = this._playerManager.getPlayer?.(playerId)
            ?? this._playerManager.get?.(playerId);

        if (!player) {

            return false;

        }

        return player.connectionState === CONNECTION_STATE.ONLINE
            || player.online === true;

    }

    _reset() {

        this._rosters.clear();

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

}
