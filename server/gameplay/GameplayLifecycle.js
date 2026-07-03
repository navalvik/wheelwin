import { EVENT_TYPES } from "../events/EventTypes.js";
import { EVENT_SOURCES } from "../events/EventSources.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { GAME_STATUS } from "../models/GameStatus.js";

const DEFAULT_RESULT_LINGER_MS = 3000;

/**
 * C3.9 — Gameplay Core teardown coordinator.
 *
 * Releases every authoritative gameplay resource once a game reaches its
 * terminal RESULT state so that completed games do not accumulate in memory.
 * It performs no gameplay logic and owns no gameplay state; it only wires the
 * existing engine `remove*` APIs together in a deterministic order:
 *
 *   Physics simulation → Input queue → GameClock → WinnerActivation guards →
 *   Payment record → Winner result → GameState → Configuration → Game record
 *
 * Room teardown is intentionally excluded — room lifecycle is owned by
 * RoomManager / RoomLobbyBridge, not the gameplay core.
 *
 * Teardown is deferred by the RESULT display duration so that clients, recovery
 * and audit can still read the authoritative result while RESULT is shown. All
 * pending timers are tracked and cleared on shutdown (no orphan timers).
 */
export class GameplayLifecycle {

    constructor({
        logger,
        eventBus,
        gameCatalog,
        physicsEngine,
        inputAuthority,
        gameClockEngine,
        gameStateEngine,
        configurationEngine,
        winnerEngine,
        winnerActivation,
        speedActivation = null,
        offlineInputContinuation = null,
        paymentEngine = null,
        paymentActivation = null,
        auditEngine = null,
        auditActivation = null,
        waitForAudit = false,
        gameManager,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameCatalog = gameCatalog;

        this._physicsEngine = physicsEngine;

        this._inputAuthority = inputAuthority;

        this._gameClockEngine = gameClockEngine;

        this._gameStateEngine = gameStateEngine;

        this._configurationEngine = configurationEngine;

        this._winnerEngine = winnerEngine;

        this._winnerActivation = winnerActivation;

        this._speedActivation = speedActivation;

        this._offlineInputContinuation = offlineInputContinuation;

        this._paymentEngine = paymentEngine;

        this._paymentActivation = paymentActivation;

        this._auditEngine = auditEngine;

        this._auditActivation = auditActivation;

        this._waitForAudit = waitForAudit;

        this._gameManager = gameManager;

        this._devMode = devMode;

        this._handlers = [];

        this._pendingTeardowns = new Map();

        this._completed = new Set();

        this._awaitingAudit = new Set();

        this._auditTerminal = new Set();

        this._initialized = false;

    }

    /**
     * Re-wires the authoritative InputAuthority after construction.
     *
     * GameplayLifecycle is constructed before InputAuthority exists (InputAuthority
     * depends on wiring that is assembled later), so the constructor captures a
     * null reference. Like SimulationLoop.setInputAuthority, this injects the real
     * instance once it is available, so the deferred teardown timer never fires
     * against a null dependency. It changes no gameplay behavior.
     */
    setInputAuthority(inputAuthority) {

        if (inputAuthority) {

            this._inputAuthority = inputAuthority;

        }

    }

    /**
     * Injects OfflineInputContinuation after construction. Like InputAuthority it
     * is assembled after GameplayLifecycle (it depends on the fully-wired
     * InputAuthority), so the reference is injected once available. Teardown then
     * releases its per-game continuation cursors alongside the other engines.
     */
    setOfflineInputContinuation(offlineInputContinuation) {

        if (offlineInputContinuation) {

            this._offlineInputContinuation = offlineInputContinuation;

        }

    }

    /**
     * C4.4 — Enables audit-gated teardown after AuditActivation is constructed.
     * When enabled, a completed game is not torn down until its audit reaches a
     * terminal state (AUDIT_READY or AUDIT_FAILED), so audit always completes
     * before authoritative data is destroyed.
     */
    configureAudit({ auditEngine, auditActivation }) {

        if (auditEngine) {

            this._auditEngine = auditEngine;

        }

        if (auditActivation) {

            this._auditActivation = auditActivation;

        }

        this._waitForAudit = true;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.GAME_STATE_CHANGED,
            (envelope) => {

                this._handleGameStateChanged(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.AUDIT_READY,
            (envelope) => {

                this._handleAuditTerminal(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.AUDIT_FAILED,
            (envelope) => {

                this._handleAuditTerminal(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._clearPendingTeardowns();

            }
        );

        this._initialized = true;

    }

    shutdown() {

        this._clearPendingTeardowns();

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._completed.clear();

        this._awaitingAudit.clear();

        this._auditTerminal.clear();

        this._initialized = false;

    }

    getPendingTeardownCount() {

        return this._pendingTeardowns.size;

    }

    _handleGameStateChanged(payload) {

        const gameId = payload?.gameId;

        const currentState = payload?.currentState ?? payload?.state;

        if (!gameId || currentState !== GAME_STATES.RESULT) {

            return;

        }

        if (this._pendingTeardowns.has(gameId) || this._completed.has(gameId)) {

            return;

        }

        // C4.4 — Audit must finalize before authoritative data is destroyed.
        // Defer teardown until the audit reaches a terminal state; the audit
        // terminal handler schedules the linger timer once audit is done.
        if (this._waitForAudit && !this._auditTerminal.has(gameId)) {

            this._awaitingAudit.add(gameId);

            this._logStep(`Awaiting audit before teardown ${gameId}`);

            return;

        }

        this._scheduleTeardown(gameId);

    }

    _handleAuditTerminal(payload) {

        const gameId = payload?.gameId;

        if (!gameId) {

            return;

        }

        this._auditTerminal.add(gameId);

        if (!this._awaitingAudit.has(gameId)) {

            return;

        }

        this._awaitingAudit.delete(gameId);

        this._logStep(`Audit terminal received, scheduling teardown ${gameId}`);

        this._scheduleTeardown(gameId);

    }

    _scheduleTeardown(gameId) {

        if (this._pendingTeardowns.has(gameId) || this._completed.has(gameId)) {

            return;

        }

        const lingerMs = this._resolveResultLingerMs();

        const handle = setTimeout(() => {

            this._pendingTeardowns.delete(gameId);

            this._teardown(gameId);

        }, lingerMs);

        if (typeof handle.unref === "function") {

            handle.unref();

        }

        this._pendingTeardowns.set(gameId, handle);

    }

    _teardown(gameId) {

        // Disposal race guard: a linger timer may fire after GameplayLifecycle has
        // been shut down (dependencies released / references dropped). Once
        // disposed, teardown must be a no-op — the resources it would release are
        // already being torn down by the shutdown sequence.
        if (!this._initialized) {

            return;

        }

        this._completed.add(gameId);

        this._logStep(`Game destroyed ${gameId}`);

        if (this._physicsEngine.getSimulation(gameId)) {

            this._physicsEngine.removeSimulation(gameId);

            this._logStep("Simulation removed");

        }

        if (this._inputAuthority.hasGame(gameId)) {

            this._inputAuthority.removeGame(gameId);

            this._logStep("Queue removed");

        }

        if (this._gameClockEngine.getClock(gameId)) {

            this._gameClockEngine.removeClock(gameId);

            this._logStep("Clock removed");

        }

        if (this._winnerActivation) {

            this._winnerActivation.forgetGame(gameId);

        }

        if (this._speedActivation) {

            this._speedActivation.forgetGame(gameId);

        }

        if (this._offlineInputContinuation) {

            this._offlineInputContinuation.forgetGame(gameId);

        }

        if (this._paymentActivation) {

            this._paymentActivation.forgetGame(gameId);

        }

        if (this._auditActivation) {

            this._auditActivation.forgetGame(gameId);

        }

        if (
            this._auditEngine
            && this._auditEngine.getAuditReport(gameId)
        ) {

            this._auditEngine.removeAuditReport(gameId);

            this._logStep("Audit report removed");

        }

        this._awaitingAudit.delete(gameId);

        this._auditTerminal.delete(gameId);

        if (
            this._paymentEngine
            && this._paymentEngine.getPaymentStatus(gameId) !== null
        ) {

            this._paymentEngine.removePayment(gameId);

            this._logStep("Payment removed");

        }

        if (this._winnerEngine.getResult(gameId)) {

            this._winnerEngine.removeResult(gameId);

            this._logStep("Winner removed");

        }

        if (this._gameStateEngine.getState(gameId)) {

            this._gameStateEngine.removeState(gameId);

            this._logStep("GameState removed");

        }

        if (this._configurationEngine.getConfiguration(gameId)) {

            this._configurationEngine.removeConfiguration(gameId);

            this._logStep("Configuration removed");

        }

        this._destroyGameRecord(gameId);

        // C4.5 — authoritative "resources released" signal. This is the final
        // lifecycle event of a completed game and drives operational metrics,
        // health, and event-integrity validation. It changes no gameplay.
        this._eventBus.emit({
            source: EVENT_SOURCES.GAMEPLAY_LIFECYCLE,
            type: EVENT_TYPES.CLEANUP_COMPLETED,
            payload: { gameId, timestamp: Date.now() }
        });

        this._logStep(`Active games: ${this._countActiveGames()}`);

    }

    _destroyGameRecord(gameId) {

        if (!this._gameManager || !this._gameManager.hasGame(gameId)) {

            return;

        }

        const snapshot = this._gameManager.getGame(gameId);

        if (snapshot?.status === GAME_STATUS.RUNNING) {

            this._gameManager.finishGame(gameId);

        }

        this._gameManager.destroyGame(gameId);

    }

    _countActiveGames() {

        if (!this._gameManager) {

            return 0;

        }

        return this._gameManager.getGames().length;

    }

    _resolveResultLingerMs() {

        const timers = this._gameCatalog?.getTimers?.();

        const durationMs = timers?.[GAME_STATES.RESULT]?.durationMs;

        if (Number.isFinite(durationMs) && durationMs > 0) {

            return durationMs;

        }

        return DEFAULT_RESULT_LINGER_MS;

    }

    _clearPendingTeardowns() {

        for (const handle of this._pendingTeardowns.values()) {

            clearTimeout(handle);

        }

        this._pendingTeardowns.clear();

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _logStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.info(`[GameplayLifecycle] ${message}`);

    }

}
