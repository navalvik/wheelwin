import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

/**
 * C4.8 — SPEED Lifetime Activation.
 *
 * Orchestration glue that owns the authoritative lifetime of the SPEED phase.
 * SPEED has no scheduled duration (Timers catalog durationMs = null) and must
 * never end on a timer. It ends only when gameplay is authoritatively complete.
 *
 * In the WheelWin gameplay model the SPEED phase is interactive: each player
 * accelerates the wheel with a limited number of input cycles (maxPressCycles).
 * Once a player exhausts that budget InputAuthority locks them and emits
 * PLAYER_PRESS_LIMIT_REACHED. When EVERY player in the game has reached that
 * limit, no further authoritative input is possible — gameplay is over. That is
 * the authoritative completion signal that owns the SPEED lifetime.
 *
 * Authoritative flow:
 *
 *   GAME_CREATED               -> record the game's player roster
 *   PLAYER_PRESS_LIMIT_REACHED -> mark player finished; when all finished:
 *   (all players locked)       -> GameClock.completePhase(gameId)  [exactly once]
 *                                   -> PHASE_TIMEOUT(SPEED)
 *                                   -> GameState transitions SPEED -> BRAKE
 *
 * This module never calculates physics, never mutates GameState directly, and
 * never invents gameplay rules. It only reads existing authoritative events and
 * asks the frozen GameClockEngine to complete the phase, exactly once per game.
 */
export class SpeedActivation {

    constructor({
        logger,
        eventBus,
        gameClockEngine,
        gameStateEngine,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameClockEngine = gameClockEngine;

        this._gameStateEngine = gameStateEngine;

        this._devMode = devMode;

        this._handlers = [];

        // Per game: expected roster and the set of players that have finished.
        this._rosters = new Map();

        this._finished = new Map();

        // Games whose SPEED phase has already been completed (idempotency).
        this._completed = new Set();

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
            EVENT_TYPES.PLAYER_PRESS_LIMIT_REACHED,
            (envelope) => {

                this._handlePressLimitReached(envelope.payload);

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

        this._finished.delete(gameId);

        this._completed.delete(gameId);

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

        this._finished.set(gameId, new Set());

        this._completed.delete(gameId);

    }

    _handlePressLimitReached(payload) {

        const gameId = payload?.gameId;

        const playerId = payload?.playerId;

        if (!gameId || !playerId || this._completed.has(gameId)) {

            return;

        }

        const roster = this._rosters.get(gameId);

        const finished = this._finished.get(gameId);

        if (!roster || !finished || roster.size === 0) {

            return;

        }

        if (roster.has(playerId)) {

            finished.add(playerId);

        }

        if (!this._allPlayersFinished(roster, finished)) {

            return;

        }

        this._completeSpeed(gameId);

    }

    _allPlayersFinished(roster, finished) {

        for (const playerId of roster) {

            if (!finished.has(playerId)) {

                return false;

            }

        }

        return true;

    }

    _completeSpeed(gameId) {

        // Defensive: only ever complete the authoritative SPEED phase, and only
        // once. PLAYER_PRESS_LIMIT_REACHED can only occur during SPEED (input is
        // validated for SPEED alone), but the guard keeps the transition exact.
        if (this._gameStateEngine.getState(gameId) !== GAME_STATES.SPEED) {

            return;

        }

        this._completed.add(gameId);

        this._logStep(`All players finished | gameId=${gameId}`);

        this._logStep("GameClock.completePhase() -> SPEED complete");

        this._gameClockEngine.completePhase(gameId);

    }

    _resolvePlayerId(entry) {

        if (typeof entry === "string") {

            return entry;

        }

        return entry?.playerId ?? entry?.id ?? null;

    }

    _reset() {

        this._rosters.clear();

        this._finished.clear();

        this._completed.clear();

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _logStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.info(`[SpeedActivation] ${message}`);

    }

}
