import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

const RADIANS_TO_DEGREES = 180 / Math.PI;

/**
 * C4.7 — Authoritative GameClock and one-second gameplay snapshot broadcaster.
 *
 * This module is a READ-ONLY sampler of the frozen GameClockEngine. It owns no
 * time of its own: every value it emits is read from the engine at the moment
 * of sampling. Its sole responsibility is to publish the authoritative clock
 * (phase + remaining time + current server physics pose) to clients. It is not
 * a second clock, does not advance phases, and samples the existing engines.
 */
export class GameClockBroadcaster {

    constructor({
        logger,
        eventBus,
        gameClockEngine,
        gameStateEngine = null,
        physicsEngine = null,
        intervalMs = 1000,
        setIntervalFn = setInterval,
        clearIntervalFn = clearInterval,
        nowFn = Date.now,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameClockEngine = gameClockEngine;

        this._gameStateEngine = gameStateEngine;

        this._physicsEngine = physicsEngine;

        this._intervalMs = intervalMs;

        this._setIntervalFn = setIntervalFn;

        this._clearIntervalFn = clearIntervalFn;

        this._nowFn = nowFn;

        this._devMode = devMode;

        this._intervals = new Map();

        this._sequences = new Map();

        this._handlers = [];

        this._initialized = false;

    }

    initialize() {

        this._subscribe(EVENT_TYPES.CLOCK_STARTED, (envelope) => {

            this._startBroadcast(envelope.payload?.gameId);

        });

        for (const phaseEvent of [
            EVENT_TYPES.PRE_GAME_READY_STARTED,
            EVENT_TYPES.READY_STARTED,
            EVENT_TYPES.SELF_TEST_STARTED,
            EVENT_TYPES.SPEED_STARTED,
            EVENT_TYPES.BRAKE_STARTED,
            EVENT_TYPES.RESULT_STARTED,
            EVENT_TYPES.PHASE_TIMEOUT
        ]) {

            this._subscribe(phaseEvent, (envelope) => {

                const gameId = envelope.payload?.gameId;

                setImmediate(() => this._emitUpdate(gameId));

            });

        }

        this._subscribe(EVENT_TYPES.CLOCK_STOPPED, (envelope) => {

            const gameId = envelope.payload?.gameId;

            this._emitUpdate(gameId);

            this._stopBroadcast(gameId);

        });

        this._subscribe(EVENT_TYPES.CLEANUP_COMPLETED, (envelope) => {

            const gameId = envelope.payload?.gameId;

            this._stopBroadcast(gameId);

            this._sequences.delete(gameId);

        });

        this._subscribe(EVENT_TYPES.SERVER_SHUTDOWN, () => {

            this._stopAll();

        });

        this._initialized = true;

    }

    shutdown() {

        this._stopAll();

        this._sequences.clear();

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(subscription.event, subscription.handler);

        }

        this._handlers = [];

        this._initialized = false;

    }

    getActiveBroadcastCount() {

        return this._intervals.size;

    }

    _startBroadcast(gameId) {

        if (!gameId || this._intervals.has(gameId)) {

            return;

        }

        // Push the current phase immediately so clients see READY at once.
        this._emitUpdate(gameId);

        const handle = this._setIntervalFn(() => {

            this._emitUpdate(gameId);

        }, this._intervalMs);

        if (typeof handle.unref === "function") {

            handle.unref();

        }

        this._intervals.set(gameId, handle);

    }

    _stopBroadcast(gameId) {

        if (!gameId) {

            return;

        }

        const handle = this._intervals.get(gameId);

        if (handle) {

            this._clearIntervalFn(handle);

            this._intervals.delete(gameId);

        }

    }

    _stopAll() {

        for (const handle of this._intervals.values()) {

            this._clearIntervalFn(handle);

        }

        this._intervals.clear();

        this._sequences.clear();

    }

    _emitUpdate(gameId) {

        if (!gameId) {

            return;

        }

        const snapshot = this._gameClockEngine.getClock(gameId);

        if (!snapshot) {

            this._stopBroadcast(gameId);

            return;

        }

        const remainingMs = this._gameClockEngine.getRemaining(gameId);

        const schedule = this._gameClockEngine.getPhaseSchedule(gameId);

        const remainingSeconds = remainingMs === null
            ? null
            : Math.ceil(remainingMs / 1000);

        const simulation = this._physicsEngine?.getSimulation?.(gameId) ?? null;

        const runtime = simulation?.runtime;

        const sequence = (this._sequences.get(gameId) ?? 0) + 1;

        this._sequences.set(gameId, sequence);

        const physics = runtime ? {
            wheelAngle: runtime.angle * RADIANS_TO_DEGREES,
            triangleAngle: runtime.triangleAngle * RADIANS_TO_DEGREES,
            angularVelocity: runtime.angularVelocity,
            triangleAngularVelocity: runtime.triangleAngularVelocity,
            simulationTimeMs: runtime.simulationTimeMs
        } : null;

        this._eventBus.emit({
            source: EVENT_SOURCES.GAME_CLOCK_BROADCASTER,
            type: EVENT_TYPES.CLOCK_UPDATE,
            payload: {
                gameId,
                phase: snapshot.currentPhase,
                gameState: this._gameStateEngine?.getState?.(gameId)
                    ?? snapshot.currentPhase,
                startedAt: schedule?.startedAt ?? snapshot.phaseStartedAt ?? null,
                endsAt: schedule?.endsAt ?? snapshot.phaseEndsAt ?? null,
                remainingMs,
                remainingSeconds,
                running: snapshot.running,
                physics,
                syncSequence: sequence,
                serverTimestamp: this._nowFn()
            }
        });

        // Once the authoritative clock is no longer running there is nothing
        // more to sample; stop the interval so no work outlives the game.
        if (!snapshot.running) {

            this._stopBroadcast(gameId);

        }

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

}
