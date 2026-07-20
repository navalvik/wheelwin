import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    GAME_STATES,
    getNextGameState
} from "../engines/gameState/GameStates.js";

/**
 * R1.3F — Server Auto Finish Mode.
 *
 * Internal controller (not a GameState). On GAMEPLAY_TIMER_WARNING (≤30s),
 * ensures the match always reaches BRAKE → WinnerActivation regardless of
 * player activity or connectivity.
 *
 * Case 1 — wheel already spinning (ω > 0): do not alter speed; schedule
 * existing force-BRAKE before timer expiry.
 *
 * Case 2 — wheel never started (ω == 0): drive InputAuthority press/release
 * cycles (same path as OfflineInputContinuation) until SPEED can complete
 * naturally via SpeedActivation, with force-BRAKE as a safety net.
 */
export class AutoFinishActivation {

    constructor({
        logger,
        eventBus,
        physicsEngine,
        inputAuthority,
        gameStateEngine,
        gameClockEngine,
        gameCatalog,
        brakeLeadMs = 8_000,
        spinGraceMs = 2_000,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._physicsEngine = physicsEngine;

        this._inputAuthority = inputAuthority;

        this._gameStateEngine = gameStateEngine;

        this._gameClockEngine = gameClockEngine;

        this._gameCatalog = gameCatalog;

        this._brakeLeadMs = Number.isFinite(brakeLeadMs) && brakeLeadMs >= 0
            ? brakeLeadMs
            : 8_000;

        this._spinGraceMs = Number.isFinite(spinGraceMs) && spinGraceMs >= 0
            ? spinGraceMs
            : 2_000;

        this._devMode = devMode;

        this._handlers = [];

        // gameId → Set(playerId) from GAME_CREATED
        this._rosters = new Map();

        // gameId → session { mode, expiresAt, roomId, brakeHandle }
        this._sessions = new Map();

        // gameId → Map(playerId → cursor) for Case 2 server agent presses
        this._agents = new Map();

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
            EVENT_TYPES.GAMEPLAY_TIMER_WARNING,
            (envelope) => {

                this._handleWarning(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PHYSICS_UPDATED,
            (envelope) => {

                this._handlePhysicsUpdated(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_STATE_CHANGED,
            (envelope) => {

                this._handleGameStateChanged(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.GAME_DESTROYED,
            (envelope) => {

                this._clearGame(envelope.payload?.gameId);

            }
        );

        this._initialized = true;

    }

    shutdown() {

        for (const gameId of [...this._sessions.keys()]) {

            this._clearGame(gameId);

        }

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._rosters.clear();

        this._initialized = false;

    }

    _handleGameCreated(payload) {

        const gameId = payload?.gameId;

        if (!gameId || !Array.isArray(payload.players)) {

            return;

        }

        const roster = new Set();

        for (const entry of payload.players) {

            const playerId = typeof entry === "string"
                ? entry
                : (entry?.playerId ?? entry?.id ?? null);

            if (playerId) {

                roster.add(playerId);

            }

        }

        this._rosters.set(gameId, roster);

    }

    _handleWarning(payload) {

        const gameId = payload?.gameId;

        if (!gameId || this._sessions.has(gameId)) {

            return;

        }

        const state = this._gameStateEngine.getState(gameId);

        if (!state || state === GAME_STATES.RESULT) {

            return;

        }

        const expiresAt = Number.isFinite(payload.expiresAt)
            ? payload.expiresAt
            : Date.now() + 30_000;

        const roomId = payload.roomId ?? null;

        this._sessions.set(gameId, {
            mode: null,
            expiresAt,
            roomId,
            brakeHandle: null
        });

        this._emit(EVENT_TYPES.AUTO_FINISH_STARTED, {
            gameId,
            roomId,
            expiresAt,
            startedAt: Date.now()
        });

        this._log(
            `AUTO_FINISH_STARTED | gameId=${gameId} | state=${state}`
        );

        if (state === GAME_STATES.BRAKE) {

            this._sessions.get(gameId).mode = "braking";

            return;

        }

        this._ensureSpeed(gameId);

        const afterAdvance = this._gameStateEngine.getState(gameId);

        if (afterAdvance === GAME_STATES.BRAKE
            || afterAdvance === GAME_STATES.RESULT) {

            this._sessions.get(gameId).mode = "braking";

            return;

        }

        const omega = this._readAngularVelocity(gameId);

        if (omega > 0) {

            this._sessions.get(gameId).mode = "spinning";

            this._scheduleForceBrake(gameId, expiresAt);

            this._log(
                `Case 1 spinning | gameId=${gameId} | ω=${omega.toFixed(4)}`
            );

            return;

        }

        this._sessions.get(gameId).mode = "accelerate";

        this._startAgents(gameId);

        this._scheduleForceBrake(gameId, expiresAt);

        this._log(`Case 2 accelerate | gameId=${gameId}`);

    }

    _ensureSpeed(gameId) {

        let guard = 0;

        while (guard < 8) {

            guard += 1;

            const state = this._gameStateEngine.getState(gameId);

            if (!state
                || state === GAME_STATES.SPEED
                || state === GAME_STATES.BRAKE
                || state === GAME_STATES.RESULT) {

                return;

            }

            const nextState = getNextGameState(state);

            if (!nextState || nextState === GAME_STATES.RESULT) {

                return;

            }

            if (state === GAME_STATES.READY
                || state === GAME_STATES.COUNTDOWN
                || state === GAME_STATES.SELF_TEST) {

                const clock = this._gameClockEngine.getClock(gameId);

                if (clock?.currentPhase === state) {

                    this._gameClockEngine.completePhase(gameId);

                }

            }

            const snapshot = this._gameStateEngine.transition(
                gameId,
                nextState,
                { reason: "Auto Finish — advance to SPEED" }
            );

            if (!snapshot) {

                this._logger.error(
                    `Auto Finish advance failed | gameId=${gameId} | `
                        + `from=${state} | to=${nextState}`
                );

                return;

            }

        }

    }

    _readAngularVelocity(gameId) {

        const simulation = this._physicsEngine.getSimulation(gameId);

        const omega = simulation?.runtime?.angularVelocity;

        return Number.isFinite(omega) ? omega : 0;

    }

    _startAgents(gameId) {

        const roster = this._rosters.get(gameId);

        if (!roster || !this._inputAuthority.hasGame(gameId)) {

            return;

        }

        const cursors = new Map();

        for (const playerId of roster) {

            const state = this._inputAuthority.getPlayerInputState(
                gameId,
                playerId
            );

            if (!state || state.locked) {

                continue;

            }

            cursors.set(playerId, {
                holding: state.buttonPressed === true,
                nextPressAt: state.cooldownUntil ?? 0,
                releaseAt: 0
            });

        }

        if (cursors.size > 0) {

            this._agents.set(gameId, cursors);

        }

    }

    _handlePhysicsUpdated(payload) {

        const gameId = payload?.gameId;

        if (!gameId) {

            return;

        }

        const session = this._sessions.get(gameId);

        if (!session || session.mode !== "accelerate") {

            return;

        }

        if (this._gameStateEngine.getState(gameId) !== GAME_STATES.SPEED) {

            this._agents.delete(gameId);

            return;

        }

        const cursors = this._agents.get(gameId);

        if (!cursors || cursors.size === 0) {

            return;

        }

        const now = Date.now();

        for (const [playerId, cursor] of [...cursors]) {

            this._advanceAgent(gameId, playerId, cursor, now);

        }

        // Once the wheel is spinning, stop injecting acceleration so Case 1
        // semantics apply for the remainder (natural SPEED end or scheduled BRAKE).
        if (this._readAngularVelocity(gameId) > 0) {

            const stillActive = this._agents.get(gameId);

            if (stillActive && stillActive.size > 0) {

                // Keep completing press budgets so SpeedActivation can finish.
                // ω > 0 is satisfied; continuing agents still required for SPEED end.
            }

        }

    }

    _advanceAgent(gameId, playerId, cursor, currentTime) {

        const state = this._inputAuthority.getPlayerInputState(gameId, playerId);

        if (!state || state.locked) {

            this._removeAgent(gameId, playerId);

            return;

        }

        if (cursor.holding) {

            if (currentTime < cursor.releaseAt) {

                return;

            }

            const released = this._inputAuthority.handleButtonRelease(
                gameId,
                playerId
            );

            if (released) {

                cursor.holding = false;

                cursor.nextPressAt = currentTime + this._cooldownMs();

            }

            return;

        }

        if (currentTime < cursor.nextPressAt) {

            return;

        }

        const pressed = this._inputAuthority.handleButtonPress(
            gameId,
            playerId
        );

        if (pressed) {

            cursor.holding = true;

            cursor.releaseAt = currentTime + this._holdMs();

        }

    }

    _removeAgent(gameId, playerId) {

        const cursors = this._agents.get(gameId);

        if (!cursors) {

            return;

        }

        cursors.delete(playerId);

        if (cursors.size === 0) {

            this._agents.delete(gameId);

        }

    }

    _scheduleForceBrake(gameId, expiresAt) {

        const session = this._sessions.get(gameId);

        if (!session) {

            return;

        }

        if (session.brakeHandle) {

            clearTimeout(session.brakeHandle);

            session.brakeHandle = null;

        }

        const now = Date.now();

        const targetAt = expiresAt - this._brakeLeadMs;

        const delay = Math.max(
            this._spinGraceMs,
            targetAt - now
        );

        const handle = setTimeout(() => {

            const active = this._sessions.get(gameId);

            if (active) {

                active.brakeHandle = null;

            }

            this._agents.delete(gameId);

            this._forceBrake(gameId);

        }, delay);

        if (typeof handle.unref === "function") {

            handle.unref();

        }

        session.brakeHandle = handle;

    }

    _forceBrake(gameId) {

        const state = this._gameStateEngine.getState(gameId);

        if (!state
            || state === GAME_STATES.RESULT
            || state === GAME_STATES.BRAKE) {

            return;

        }

        this._log(`Force BRAKE | gameId=${gameId} | from=${state}`);

        let guard = 0;

        while (guard < 8) {

            guard += 1;

            const current = this._gameStateEngine.getState(gameId);

            if (!current || current === GAME_STATES.RESULT) {

                return;

            }

            if (current === GAME_STATES.BRAKE) {

                return;

            }

            const nextState = getNextGameState(current);

            if (!nextState || nextState === GAME_STATES.RESULT) {

                return;

            }

            if (current === GAME_STATES.SPEED) {

                const clock = this._gameClockEngine.getClock(gameId);

                if (clock?.currentPhase === GAME_STATES.SPEED) {

                    this._gameClockEngine.completePhase(gameId);

                }

            }

            // completePhase emits PHASE_TIMEOUT; GameStateActivation may already
            // have advanced SPEED → BRAKE synchronously.
            const afterClock = this._gameStateEngine.getState(gameId);

            if (!afterClock
                || afterClock === GAME_STATES.RESULT
                || afterClock === GAME_STATES.BRAKE) {

                return;

            }

            const snapshot = this._gameStateEngine.transition(
                gameId,
                nextState,
                { reason: "Auto Finish — initiate BRAKE" }
            );

            if (!snapshot) {

                this._logger.error(
                    `Auto Finish force-BRAKE failed | gameId=${gameId} | `
                        + `from=${afterClock} | to=${nextState}`
                );

                return;

            }

        }

    }

    _handleGameStateChanged(payload) {

        const gameId = payload?.gameId;

        const currentState = payload?.currentState ?? payload?.state;

        if (!gameId) {

            return;

        }

        if (currentState === GAME_STATES.RESULT
            || currentState === GAME_STATES.BRAKE) {

            this._agents.delete(gameId);

            const session = this._sessions.get(gameId);

            if (session?.brakeHandle) {

                clearTimeout(session.brakeHandle);

                session.brakeHandle = null;

            }

        }

        if (currentState === GAME_STATES.RESULT) {

            this._clearGame(gameId);

        }

    }

    _clearGame(gameId) {

        if (!gameId) {

            return;

        }

        const session = this._sessions.get(gameId);

        if (session?.brakeHandle) {

            clearTimeout(session.brakeHandle);

        }

        this._sessions.delete(gameId);

        this._agents.delete(gameId);

        this._rosters.delete(gameId);

    }

    _cooldownMs() {

        return this._gameCatalog.getInputRules().pressCooldownMs;

    }

    _holdMs() {

        return this._gameCatalog.getInputRules().pressCooldownMs;

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.AUTO_FINISH_ACTIVATION,
            type,
            payload
        });

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _log(message) {

        this._logger.info(`[AutoFinish] ${message}`);

    }

}
