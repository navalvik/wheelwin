import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

/**
 * C4.7 — Authoritative GameClock broadcaster.
 *
 * This module is a READ-ONLY sampler of the frozen GameClockEngine. It owns no
 * time of its own: every value it emits is read from the engine at the moment
 * of sampling. Its sole responsibility is to publish the authoritative clock
 * (phase + remaining time) to clients so the client never calculates gameplay
 * time. It is not a second clock and it never advances phases.
 */
export class GameClockBroadcaster {

    constructor({
        logger,
        eventBus,
        gameClockEngine,
        intervalMs = 1000,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameClockEngine = gameClockEngine;

        this._intervalMs = intervalMs;

        this._devMode = devMode;

        this._intervals = new Map();

        this._handlers = [];

        this._initialized = false;

    }

    initialize() {

        this._subscribe(EVENT_TYPES.CLOCK_STARTED, (envelope) => {

            this._startBroadcast(envelope.payload?.gameId);

        });

        // A phase transition changes the authoritative phase synchronously right
        // after PHASE_TIMEOUT is emitted; defer one tick so the sampled snapshot
        // reflects the new phase, then push it immediately (no waiting a second).
        this._subscribe(EVENT_TYPES.PHASE_TIMEOUT, (envelope) => {

            const gameId = envelope.payload?.gameId;

            setImmediate(() => this._emitUpdate(gameId));

        });

        this._subscribe(EVENT_TYPES.CLOCK_STOPPED, (envelope) => {

            const gameId = envelope.payload?.gameId;

            this._emitUpdate(gameId);

            this._stopBroadcast(gameId);

        });

        this._subscribe(EVENT_TYPES.CLEANUP_COMPLETED, (envelope) => {

            this._stopBroadcast(envelope.payload?.gameId);

        });

        this._subscribe(EVENT_TYPES.SERVER_SHUTDOWN, () => {

            this._stopAll();

        });

        this._initialized = true;

    }

    shutdown() {

        this._stopAll();

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

        // Push the current phase immediately so clients see COUNTDOWN at once.
        this._emitUpdate(gameId);

        const handle = setInterval(() => {

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

            clearInterval(handle);

            this._intervals.delete(gameId);

        }

    }

    _stopAll() {

        for (const handle of this._intervals.values()) {

            clearInterval(handle);

        }

        this._intervals.clear();

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

        const remainingSeconds = remainingMs === null
            ? null
            : Math.ceil(remainingMs / 1000);

        this._eventBus.emit({
            source: EVENT_SOURCES.GAME_CLOCK_BROADCASTER,
            type: EVENT_TYPES.CLOCK_UPDATE,
            payload: {
                gameId,
                phase: snapshot.currentPhase,
                remainingMs,
                remainingSeconds,
                running: snapshot.running
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
