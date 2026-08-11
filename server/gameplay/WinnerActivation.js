import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { PHYSICS_SIMULATION_STATE } from "../engines/physics/PhysicsSimulationState.js";

/** R9.2 — bounded resolve attempts after PHYSICS_STOPPED (1 immediate + retries). */
const DEFAULT_RESOLVE_ATTEMPTS = 3;

/** R9.2 — non-blocking delay between resolve attempts (ms). */
const DEFAULT_RESOLVE_RETRY_DELAY_MS = 25;

/** R11.2 — deferred resolve delays after fast retries (ms). */
const DEFAULT_DEFERRED_RETRY_DELAYS_MS = Object.freeze([
    1000,
    5000,
    30000
]);

/** R11.2 — terminal failure reason codes. */
export const WINNER_RESOLUTION_FAILURE_REASON = Object.freeze({
    RESOLUTION_EXCEPTION: "resolution_exception",
    REQUIRED_INPUTS_UNAVAILABLE: "required_inputs_unavailable",
    RETRY_BUDGET_EXHAUSTED: "retry_budget_exhausted"
});

/**
 * P5.8 — Winner Activation.
 *
 * PHYSICS_STOPPED → WinnerEngine.resolveResult() → WINNER_DETERMINED (once).
 * R9.2 — bounded non-blocking retry on resolve failure (no physics replay).
 * R11.2 — deferred retries + WINNER_RESOLUTION_FAILED terminal observability.
 * BrakePhaseController owns BRAKE physics (P5.7).
 * GameplayPhaseLifecycle owns RESULT / Page6 transitions (deferred).
 */
export class WinnerActivation {

    constructor({
        logger,
        eventBus,
        physicsEngine,
        winnerEngine,
        gameStateEngine,
        configurationEngine = null,
        devMode = false,
        resolveAttempts = DEFAULT_RESOLVE_ATTEMPTS,
        resolveRetryDelayMs = DEFAULT_RESOLVE_RETRY_DELAY_MS,
        deferredRetryDelaysMs = DEFAULT_DEFERRED_RETRY_DELAYS_MS
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._physicsEngine = physicsEngine;

        this._winnerEngine = winnerEngine;

        this._gameStateEngine = gameStateEngine;

        this._configurationEngine = configurationEngine;

        this._devMode = devMode;

        this._resolveAttempts = Number.isFinite(resolveAttempts) && resolveAttempts > 0
            ? Math.floor(resolveAttempts)
            : DEFAULT_RESOLVE_ATTEMPTS;

        this._resolveRetryDelayMs = Number.isFinite(resolveRetryDelayMs)
            && resolveRetryDelayMs >= 0
            ? resolveRetryDelayMs
            : DEFAULT_RESOLVE_RETRY_DELAY_MS;

        this._deferredRetryDelaysMs = Array.isArray(deferredRetryDelaysMs)
            ? deferredRetryDelaysMs.filter(
                (delay) => Number.isFinite(delay) && delay >= 0
            )
            : [...DEFAULT_DEFERRED_RETRY_DELAYS_MS];

        this._handlers = [];

        this._brakeTriggered = new Set();

        this._resolved = new Set();

        this._resultTransitioned = new Set();

        /** @type {Set<string>} */
        this._terminalFailed = new Set();

        /** @type {Map<string, { totalAttempts: number, lastError: string|null }>} */
        this._retryState = new Map();

        /** @type {Map<string, ReturnType<typeof setTimeout>>} */
        this._retryTimers = new Map();

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.GAME_STATE_CHANGED,
            (envelope) => {

                this._handleGameStateChanged(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PHYSICS_STOPPED,
            (envelope) => {

                this._handlePhysicsStopped(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.WINNER_DETERMINED,
            (envelope) => {

                this._handleWinnerDetermined(envelope.payload);

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

    _handleGameStateChanged(payload) {

        const gameId = payload?.gameId;

        const currentState = payload?.currentState ?? payload?.state;

        if (!gameId || currentState !== GAME_STATES.BRAKE) {

            return;

        }

        // P5.7 — BrakePhaseController owns Page5 BRAKE physics.
        this._brakeTriggered.add(gameId);

        this._logStep("BRAKE owned by BrakePhaseController");

    }

    _handlePhysicsStopped(payload) {

        const gameId = payload?.gameId;

        if (!gameId || this._resolved.has(gameId)) {

            return;

        }

        // Claim once — prevents duplicate WINNER_DETERMINED / retry chains.
        this._resolved.add(gameId);

        this._retryState.set(gameId, {
            totalAttempts: 0,
            lastError: null
        });

        this._logStep("Wheel stopped");

        this._attemptFastResolve(gameId, 1);

    }

    /**
     * R9.2 — Fast resolve attempts (existing behavior).
     */
    _attemptFastResolve(gameId, attempt) {

        this._clearRetryTimer(gameId);

        if (this._terminalFailed.has(gameId)) {

            return;

        }

        const existing = this._winnerEngine.getResult?.(gameId);

        if (existing) {

            this._emitWinnerDetermined(gameId, existing);

            return;

        }

        this._incrementAttempt(gameId);

        this._logStep(
            `WinnerEngine.resolveResult() fast attempt ${attempt}/${this._resolveAttempts}`
        );

        let result;

        try {

            result = this._winnerEngine.resolveResult(gameId);

        } catch (error) {

            const reason = error?.message ?? String(error);

            this._recordLastError(gameId, reason);

            if (attempt < this._resolveAttempts) {

                this._logger.warn(
                    `Winner determination retry scheduled | gameId=${gameId} | `
                        + `attempt=${attempt}/${this._resolveAttempts} | reason=${reason}`
                );

                const timerId = setTimeout(() => {

                    this._retryTimers.delete(gameId);

                    this._attemptFastResolve(gameId, attempt + 1);

                }, this._resolveRetryDelayMs);

                this._retryTimers.set(gameId, timerId);

                return;

            }

            this._logger.warn(
                `Winner fast retries exhausted | gameId=${gameId} | reason=${reason}`
            );

            this._scheduleDeferredResolve(gameId, 0);

            return;

        }

        this._emitWinnerDetermined(gameId, result);

    }

    _scheduleDeferredResolve(gameId, deferredIndex) {

        this._clearRetryTimer(gameId);

        if (this._terminalFailed.has(gameId)) {

            return;

        }

        const existing = this._winnerEngine.getResult?.(gameId);

        if (existing) {

            this._emitWinnerDetermined(gameId, existing);

            return;

        }

        const delay = this._deferredRetryDelaysMs[deferredIndex];

        if (delay === undefined) {

            const state = this._retryState.get(gameId);

            this._emitTerminalFailure(
                gameId,
                WINNER_RESOLUTION_FAILURE_REASON.RETRY_BUDGET_EXHAUSTED,
                state?.lastError ?? "retry_budget_exhausted"
            );

            return;

        }

        this._logger.info(
            `Winner deferred retry scheduled | gameId=${gameId} | `
                + `deferred=${deferredIndex + 1}/${this._deferredRetryDelaysMs.length} | `
                + `delayMs=${delay}`
        );

        const timerId = setTimeout(() => {

            this._retryTimers.delete(gameId);

            this._attemptDeferredResolve(gameId, deferredIndex);

        }, delay);

        this._retryTimers.set(gameId, timerId);

    }

    /**
     * R11.2 — Deferred resolve attempts with input validation.
     */
    _attemptDeferredResolve(gameId, deferredIndex) {

        this._clearRetryTimer(gameId);

        if (this._terminalFailed.has(gameId)) {

            return;

        }

        const existing = this._winnerEngine.getResult?.(gameId);

        if (existing) {

            this._emitWinnerDetermined(gameId, existing);

            return;

        }

        const validation = this._validateResolutionInputs(gameId);

        if (!validation.ok) {

            this._emitTerminalFailure(
                gameId,
                validation.reason,
                validation.detail
            );

            return;

        }

        this._incrementAttempt(gameId);

        this._logStep(
            `WinnerEngine.resolveResult() deferred attempt `
                + `${deferredIndex + 1}/${this._deferredRetryDelaysMs.length}`
        );

        let result;

        try {

            result = this._winnerEngine.resolveResult(gameId);

        } catch (error) {

            const reason = error?.message ?? String(error);

            this._recordLastError(gameId, reason);

            this._logger.warn(
                `Winner deferred resolve failed | gameId=${gameId} | `
                    + `deferred=${deferredIndex + 1} | reason=${reason}`
            );

            this._scheduleDeferredResolve(gameId, deferredIndex + 1);

            return;

        }

        this._emitWinnerDetermined(gameId, result);

    }

    _validateResolutionInputs(gameId) {

        if (this._winnerEngine.getResult?.(gameId)) {

            return { ok: true };

        }

        const physics = this._physicsEngine?.getSimulation?.(gameId);

        if (!physics) {

            return {
                ok: false,
                reason: WINNER_RESOLUTION_FAILURE_REASON.REQUIRED_INPUTS_UNAVAILABLE,
                detail: "Physics simulation is missing"
            };

        }

        if (physics.runtime?.state !== PHYSICS_SIMULATION_STATE.STOPPED) {

            return {
                ok: false,
                reason: WINNER_RESOLUTION_FAILURE_REASON.REQUIRED_INPUTS_UNAVAILABLE,
                detail: "Physics simulation is not complete"
            };

        }

        if (this._configurationEngine?.getConfiguration) {

            const configuration = this._configurationEngine.getConfiguration(gameId);

            if (!configuration) {

                return {
                    ok: false,
                    reason: WINNER_RESOLUTION_FAILURE_REASON.REQUIRED_INPUTS_UNAVAILABLE,
                    detail: "Configuration is missing"
                };

            }

        }

        return { ok: true };

    }

    _emitWinnerDetermined(gameId, result) {

        if (this._terminalFailed.has(gameId)) {

            return;

        }

        this._clearRetryTimer(gameId);

        this._retryState.delete(gameId);

        this._logStep(`Winning Sector ${result.winningSector?.sectorId ?? "?"}`);

        this._logStep(`Winning Player ${result.winningPlayer?.playerId ?? "?"}`);

        this._emit(EVENT_TYPES.WINNER_DETERMINED, {
            gameId,
            winningSector: {
                index: result.winningSector?.index ?? null,
                sectorId: result.winningSector?.sectorId ?? null,
                color: result.winningSector?.color ?? null,
                icon: result.winningSector?.icon ?? null
            },
            winningPlayerId: result.winningPlayer?.playerId ?? null,
            winnerPlayerId: result.winnerPlayerId
                ?? result.winningPlayer?.playerId
                ?? null,
            winningPlayerColor: result.winningPlayer?.color ?? null,
            winningPlayerIcon: result.winningPlayer?.icon ?? null,
            winnerSectorIndex: result.winnerSectorIndex
                ?? result.winningSector?.index
                ?? null,
            finalWheelAngle: result.finalAngle ?? result.wheelFinalAngle ?? null,
            wheelFinalAngle: result.wheelFinalAngle ?? result.finalAngle ?? null,
            triangleFinalAngle: result.triangleFinalAngle ?? null,
            resolvedAt: result.resolvedAt ?? null,
            serverTimestamp: result.resolvedAt ?? Date.now()
        });

        this._logStep("WINNER_DETERMINED");

    }

    _emitTerminalFailure(gameId, reason, lastError) {

        if (this._terminalFailed.has(gameId)) {

            return;

        }

        this._terminalFailed.add(gameId);

        this._clearRetryTimer(gameId);

        const state = this._retryState.get(gameId) ?? {
            totalAttempts: 0,
            lastError: null
        };

        this._retryState.delete(gameId);

        const resolvedReason = reason
            ?? WINNER_RESOLUTION_FAILURE_REASON.RESOLUTION_EXCEPTION;

        const attempts = state.totalAttempts;

        const errorText = lastError ?? state.lastError ?? null;

        this._logger.error(
            `Winner resolution failed terminally | gameId=${gameId} | `
                + `roomId=${this._resolveRoomId(gameId) ?? "unknown"} | `
                + `reason=${resolvedReason} | attempts=${attempts} | `
                + `lastError=${errorText ?? "none"}`
        );

        this._emit(EVENT_TYPES.WINNER_RESOLUTION_FAILED, {
            gameId,
            roomId: this._resolveRoomId(gameId),
            reason: resolvedReason,
            attempts,
            lastError: errorText,
            timestamp: Date.now()
        });

    }

    _resolveRoomId(gameId) {

        const configuration = this._configurationEngine?.getConfiguration?.(gameId);

        return configuration?.metadata?.roomId ?? null;

    }

    _incrementAttempt(gameId) {

        const state = this._retryState.get(gameId) ?? {
            totalAttempts: 0,
            lastError: null
        };

        state.totalAttempts += 1;

        this._retryState.set(gameId, state);

    }

    _recordLastError(gameId, lastError) {

        const state = this._retryState.get(gameId) ?? {
            totalAttempts: 0,
            lastError: null
        };

        state.lastError = lastError;

        this._retryState.set(gameId, state);

    }

    _handleWinnerDetermined(payload) {

        const gameId = payload?.gameId;

        if (!gameId) {

            return;

        }

        // RESULT / Page6 owned by ResultActivation + GameplayPhaseLifecycle (P5.9).
        this._resultTransitioned.add(gameId);

        this._logStep("Winner ready (ResultActivation owns RESULT)");

    }

    forgetGame(gameId) {

        this._clearRetryTimer(gameId);

        this._brakeTriggered.delete(gameId);

        this._resolved.delete(gameId);

        this._resultTransitioned.delete(gameId);

        this._terminalFailed.delete(gameId);

        this._retryState.delete(gameId);

    }

    _clearRetryTimer(gameId) {

        const timerId = this._retryTimers.get(gameId);

        if (timerId != null) {

            clearTimeout(timerId);

            this._retryTimers.delete(gameId);

        }

    }

    _reset() {

        for (const gameId of [...this._retryTimers.keys()]) {

            this._clearRetryTimer(gameId);

        }

        this._brakeTriggered.clear();

        this._resolved.clear();

        this._resultTransitioned.clear();

        this._terminalFailed.clear();

        this._retryState.clear();

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.WINNER_ENGINE,
            type,
            payload
        });

    }

    _logStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.info(`[WinnerActivation] ${message}`);

    }

}
