import { TIMER_PHASES } from "../catalog/Timers.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    CLOCK_PHASE_SEQUENCE,
    getNextClockPhase
} from "./gameClock/ClockPhases.js";
import {
    getPhaseCompletedEventType,
    getPhaseStartedEventType
} from "../gameplay/GameplayPhaseSequence.js";

export class GameClockEngine {

    constructor({ logger, eventBus, gameCatalog }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameCatalog = gameCatalog;

        this._clocks = new Map();

        this._infrastructureHandlers = [];

        this._initialized = false;

    }

    initialize() {

        const shutdownHandler = () => {

            this._handleServerShutdown();

        };

        this._eventBus.subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            shutdownHandler
        );

        this._infrastructureHandlers.push({
            event: EVENT_TYPES.SERVER_SHUTDOWN,
            handler: shutdownHandler
        });

        this._initialized = true;

    }

    shutdown() {

        for (const gameId of [...this._clocks.keys()]) {

            this.removeClock(gameId);

        }

        for (const subscription of this._infrastructureHandlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._infrastructureHandlers = [];

        this._initialized = false;

    }

    createClock(gameId) {

        this._assertInitialized();

        if (!gameId) {

            this._logger.error("Clock creation failed: gameId is required");

            return null;

        }

        if (this._clocks.has(gameId)) {

            this._logger.error(
                `Clock creation failed: clock already exists (${gameId})`
            );

            return null;

        }

        const record = {
            gameId,
            currentPhase: null,
            startedAt: null,
            pausedAt: null,
            elapsed: 0,
            running: false,
            paused: false,
            phaseStartedAt: null,
            phaseEndsAt: null,
            phaseRemainingMs: null,
            totalPausedMs: 0,
            pauseStartedAt: null,
            timeoutHandle: null,
            // P5.9 — RESULT starts only via beginResultPhase (ResultActivation).
            awaitingResultActivation: false,
            resultPhaseStarted: false,
            history: []
        };

        this._clocks.set(gameId, record);

        this._logger.info("Clock Created");

        return this._createSnapshot(record);

    }

    startClock(gameId) {

        this._assertInitialized();

        const record = this._getClockOrLog(gameId, "start");

        if (!record) {

            return null;

        }

        if (record.running) {

            this._logger.error(
                `Clock start failed: clock is already running (${gameId})`
            );

            return null;

        }

        const now = Date.now();

        record.running = true;

        record.paused = false;

        record.startedAt = now;

        record.pausedAt = null;

        record.elapsed = 0;

        record.totalPausedMs = 0;

        record.pauseStartedAt = null;

        record.currentPhase = CLOCK_PHASE_SEQUENCE[0];

        record.phaseStartedAt = now;

        record.phaseEndsAt = this._computePhaseEndsAt(record.currentPhase, now);

        record.phaseRemainingMs = this._getPhaseDuration(record.currentPhase);

        this._schedulePhaseTimeout(record);

        this._logger.info("Clock Started");

        this._emitPhaseStarted(record);

        this._emit(EVENT_TYPES.CLOCK_STARTED, {
            gameId,
            phase: record.currentPhase,
            startedAt: record.phaseStartedAt,
            endsAt: record.phaseEndsAt,
            timestamp: now
        });

        return this._createSnapshot(record);

    }

    pauseClock(gameId) {

        this._assertInitialized();

        const record = this._getClockOrLog(gameId, "pause");

        if (!record) {

            return null;

        }

        if (!record.running) {

            this._logger.error(
                `Clock pause failed: clock is not running (${gameId})`
            );

            return null;

        }

        if (record.paused) {

            this._logger.error(
                `Clock pause failed: clock is already paused (${gameId})`
            );

            return null;

        }

        const now = Date.now();

        record.paused = true;

        record.pausedAt = now;

        record.pauseStartedAt = now;

        if (record.timeoutHandle !== null) {

            clearTimeout(record.timeoutHandle);

            record.timeoutHandle = null;

            const elapsedInPhase = now - record.phaseStartedAt;

            record.phaseRemainingMs = Math.max(
                0,
                (record.phaseRemainingMs ?? 0) - elapsedInPhase
            );

        }

        this._logger.info("Clock Paused");

        this._emit(EVENT_TYPES.CLOCK_PAUSED, {
            gameId,
            phase: record.currentPhase,
            elapsed: this.getElapsed(gameId),
            timestamp: now
        });

        return this._createSnapshot(record);

    }

    resumeClock(gameId) {

        this._assertInitialized();

        const record = this._getClockOrLog(gameId, "resume");

        if (!record) {

            return null;

        }

        if (!record.running) {

            this._logger.error(
                `Clock resume failed: clock is not running (${gameId})`
            );

            return null;

        }

        if (!record.paused) {

            this._logger.error(
                `Clock resume failed: clock is not paused (${gameId})`
            );

            return null;

        }

        const now = Date.now();

        record.totalPausedMs += now - record.pauseStartedAt;

        record.paused = false;

        record.pausedAt = null;

        record.pauseStartedAt = null;

        record.phaseStartedAt = now;

        this._schedulePhaseTimeout(record, record.phaseRemainingMs);

        this._logger.info("Clock Resumed");

        this._emit(EVENT_TYPES.CLOCK_RESUMED, {
            gameId,
            phase: record.currentPhase,
            elapsed: this.getElapsed(gameId),
            timestamp: now
        });

        return this._createSnapshot(record);

    }

    stopClock(gameId) {

        this._assertInitialized();

        const record = this._getClockOrLog(gameId, "stop");

        if (!record) {

            return null;

        }

        if (!record.running) {

            this._logger.error(
                `Clock stop failed: clock is not running (${gameId})`
            );

            return null;

        }

        this._clearPhaseTimeout(record);

        const now = Date.now();

        record.elapsed = this._calculateElapsed(record, now);

        record.running = false;

        record.paused = false;

        record.pausedAt = null;

        record.pauseStartedAt = null;

        record.history.push({
            phase: record.currentPhase,
            stoppedAt: now,
            elapsed: record.elapsed
        });

        this._logger.info("Clock Stopped");

        this._emit(EVENT_TYPES.CLOCK_STOPPED, {
            gameId,
            phase: record.currentPhase,
            elapsed: record.elapsed,
            timestamp: now
        });

        return this._createSnapshot(record);

    }

    completePhase(gameId) {

        this._assertInitialized();

        this._logger.error(
            "Phase completion failed: P5.3 lifecycle uses scheduled phase durations only"
        );

        return null;

    }

    /**
     * P5.11 — Complete PRE_GAME_READY early when all players confirm.
     * Called only by PreGameReadyActivation.
     */
    completePreGameReadyPhase(gameId) {

        this._assertInitialized();

        const record = this._getClockOrLog(gameId, "complete PRE_GAME_READY for");

        if (!record || !record.running || record.paused) {

            return null;

        }

        if (record.currentPhase !== TIMER_PHASES.PRE_GAME_READY) {

            return this._createSnapshot(record);

        }

        this._clearPhaseTimeout(record);

        const now = Date.now();

        this._emitPhaseCompleted(record, now);

        record.history.push({
            phase: TIMER_PHASES.PRE_GAME_READY,
            completedAt: now,
            elapsed: this._calculateElapsed(record, now)
        });

        record.currentPhase = TIMER_PHASES.READY;

        record.phaseStartedAt = now;

        record.phaseEndsAt = this._computePhaseEndsAt(TIMER_PHASES.READY, now);

        record.phaseRemainingMs = this._getPhaseDuration(TIMER_PHASES.READY);

        this._emitPhaseStarted(record);

        this._schedulePhaseTimeout(record);

        return this._createSnapshot(record);

    }

    /**
     * P5.9 — Begin the RESULT phase after winner determination.
     * Called only by ResultActivation. Schedules the catalog RESULT duration
     * (4s) on GameClockEngine — no client timers.
     */
    beginResultPhase(gameId) {

        this._assertInitialized();

        const record = this._getClockOrLog(gameId, "begin RESULT for");

        if (!record || !record.running || record.paused) {

            return null;

        }

        if (record.resultPhaseStarted
            || record.currentPhase === TIMER_PHASES.RESULT) {

            return this._createSnapshot(record);

        }

        const brakeJustCompleted = record.currentPhase === TIMER_PHASES.BRAKE;

        if (!brakeJustCompleted && !record.awaitingResultActivation) {

            this._logger.error(
                `RESULT start failed: clock is not awaiting RESULT (${gameId})`
            );

            return null;

        }

        this._clearPhaseTimeout(record);

        const now = Date.now();

        record.awaitingResultActivation = false;

        record.resultPhaseStarted = true;

        record.currentPhase = TIMER_PHASES.RESULT;

        record.phaseStartedAt = now;

        record.phaseEndsAt = this._computePhaseEndsAt(TIMER_PHASES.RESULT, now);

        record.phaseRemainingMs = this._getPhaseDuration(TIMER_PHASES.RESULT);

        this._logger.info("RESULT Phase Started");

        this._emitPhaseStarted(record);

        this._schedulePhaseTimeout(record);

        return this._createSnapshot(record);

    }

    restorePhaseSchedule(gameId, { phase, phaseStartedAt, phaseEndsAt }) {

        this._assertInitialized();

        const record = this._getClockOrLog(gameId, "restore phase schedule for");

        if (!record || !record.running || record.paused) {

            return null;

        }

        if (!phase || !Number.isFinite(phaseStartedAt) || !Number.isFinite(phaseEndsAt)) {

            return null;

        }

        this._clearPhaseTimeout(record);

        record.currentPhase = phase;

        record.phaseStartedAt = phaseStartedAt;

        record.phaseEndsAt = phaseEndsAt;

        record.phaseRemainingMs = Math.max(0, phaseEndsAt - Date.now());

        this._schedulePhaseTimeout(record, record.phaseRemainingMs);

        return this._createSnapshot(record);

    }

    removeClock(gameId) {

        const record = this._clocks.get(gameId);

        if (!record) {

            this._logger.error(
                `Clock removal failed: clock not found (${gameId})`
            );

            return false;

        }

        if (record.running) {

            this.stopClock(gameId);

        }

        this._clearPhaseTimeout(record);

        this._clocks.delete(gameId);

        this._logger.info("Clock Removed");

        return true;

    }

    // C4.5 — read-only operational accessor (no behavior change).
    getActiveClockCount() {

        return this._clocks.size;

    }

    getClock(gameId) {

        const record = this._clocks.get(gameId);

        if (!record) {

            return null;

        }

        return this._createSnapshot(record);

    }

    getElapsed(gameId) {

        const record = this._clocks.get(gameId);

        if (!record || !record.startedAt) {

            return 0;

        }

        return this._calculateElapsed(record, Date.now());

    }

    isRunning(gameId) {

        const record = this._clocks.get(gameId);

        return record?.running === true;

    }

    getRemaining(gameId) {

        const record = this._clocks.get(gameId);

        if (!record || !record.running || !record.currentPhase) {

            return null;

        }

        if (record.paused) {

            return record.phaseRemainingMs;

        }

        const duration = this._getPhaseDuration(record.currentPhase);

        if (duration === null) {

            return null;

        }

        return Math.max(0, (record.phaseEndsAt ?? (record.phaseStartedAt + duration))
            - Date.now());

    }

    getPhaseSchedule(gameId) {

        const record = this._clocks.get(gameId);

        if (!record || !record.currentPhase) {

            return null;

        }

        return {
            gameId,
            phase: record.currentPhase,
            startedAt: record.phaseStartedAt,
            endsAt: record.phaseEndsAt,
            running: record.running,
            paused: record.paused
        };

    }

    getDebugSnapshot(gameId) {

        const record = this._clocks.get(gameId);

        if (!record) {

            return null;

        }

        return {
            gameId,
            running: record.running,
            paused: record.paused,
            currentPhase: record.currentPhase,
            elapsed: this.getElapsed(gameId),
            remainingTime: this.getRemaining(gameId),
            history: record.history.map((entry) => ({ ...entry }))
        };

    }

    _handlePhaseTimeout(record) {

        this._clearPhaseTimeout(record);

        const now = Date.now();

        const phase = record.currentPhase;

        const elapsed = this._calculateElapsed(record, now);

        this._logger.info("Phase Timeout");

        this._emitPhaseCompleted(record, now);

        this._emit(EVENT_TYPES.PHASE_TIMEOUT, {
            gameId: record.gameId,
            phase,
            elapsed,
            startedAt: record.phaseStartedAt,
            endsAt: record.phaseEndsAt,
            timestamp: now
        });

        record.history.push({
            phase,
            completedAt: now,
            elapsed
        });

        const nextPhase = getNextClockPhase(phase);

        if (!nextPhase || !record.running) {

            if (record.running) {

                record.running = false;

                record.elapsed = elapsed;

            }

            return;

        }

        // P5.9 — BRAKE → RESULT is gated by ResultActivation (after WINNER_DETERMINED).
        if (phase === TIMER_PHASES.BRAKE
            && nextPhase === TIMER_PHASES.RESULT) {

            if (record.resultPhaseStarted) {

                return;

            }

            record.awaitingResultActivation = true;

            return;

        }

        record.currentPhase = nextPhase;

        record.phaseStartedAt = now;

        record.phaseEndsAt = this._computePhaseEndsAt(nextPhase, now);

        record.phaseRemainingMs = this._getPhaseDuration(nextPhase);

        this._emitPhaseStarted(record);

        this._schedulePhaseTimeout(record);

    }

    _schedulePhaseTimeout(record, remainingMs = null) {

        this._clearPhaseTimeout(record);

        const duration = remainingMs ?? this._getPhaseDuration(record.currentPhase);

        if (!Number.isFinite(duration) || duration <= 0) {

            return;

        }

        record.phaseRemainingMs = duration;

        if (!Number.isFinite(record.phaseEndsAt)) {

            record.phaseEndsAt = record.phaseStartedAt + duration;

        }

        record.timeoutHandle = setTimeout(() => {

            record.timeoutHandle = null;

            this._handlePhaseTimeout(record);

        }, duration);

    }

    _computePhaseEndsAt(phase, startedAt) {

        const duration = this._getPhaseDuration(phase);

        if (!Number.isFinite(duration)) {

            return null;

        }

        return startedAt + duration;

    }

    _emitPhaseStarted(record) {

        const payload = {
            gameId: record.gameId,
            phase: record.currentPhase,
            startedAt: record.phaseStartedAt,
            endsAt: record.phaseEndsAt,
            durationMs: this._getPhaseDuration(record.currentPhase),
            timestamp: record.phaseStartedAt
        };

        this._emit(getPhaseStartedEventType(record.currentPhase), payload);

    }

    _emitPhaseCompleted(record, completedAt) {

        const payload = {
            gameId: record.gameId,
            phase: record.currentPhase,
            startedAt: record.phaseStartedAt,
            endsAt: record.phaseEndsAt,
            completedAt,
            timestamp: completedAt
        };

        this._emit(getPhaseCompletedEventType(record.currentPhase), payload);

    }

    _getPhaseDuration(phase) {

        const timers = this._gameCatalog.getTimers();

        const definition = timers[phase];

        if (!definition) {

            return null;

        }

        return definition.durationMs;

    }

    _calculateElapsed(record, now) {

        if (!record.startedAt) {

            return 0;

        }

        let pausedMs = record.totalPausedMs;

        if (record.paused && record.pauseStartedAt) {

            pausedMs += now - record.pauseStartedAt;

        }

        return Math.max(0, now - record.startedAt - pausedMs);

    }

    _clearPhaseTimeout(record) {

        if (record.timeoutHandle !== null) {

            clearTimeout(record.timeoutHandle);

            record.timeoutHandle = null;

        }

    }

    _getClockOrLog(gameId, operation) {

        if (!gameId) {

            this._logger.error(`Clock ${operation} failed: gameId is required`);

            return null;

        }

        const record = this._clocks.get(gameId);

        if (!record) {

            this._logger.error(
                `Clock ${operation} failed: clock not found (${gameId})`
            );

            return null;

        }

        return record;

    }

    _createSnapshot(record) {

        return {
            gameId: record.gameId,
            currentPhase: record.currentPhase,
            startedAt: record.startedAt,
            phaseStartedAt: record.phaseStartedAt,
            phaseEndsAt: record.phaseEndsAt,
            pausedAt: record.pausedAt,
            elapsed: this.getElapsed(record.gameId),
            running: record.running,
            paused: record.paused
        };

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.GAME_CLOCK_ENGINE,
            type,
            payload
        });

    }

    _handleServerShutdown() {

        for (const gameId of [...this._clocks.keys()]) {

            this.removeClock(gameId);

        }

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("GameClockEngine is not initialized");

        }

    }

}
