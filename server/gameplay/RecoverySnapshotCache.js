import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

/**
 * C4.3 — Recovery snapshot cache.
 *
 * Captures authoritative RecoveryEngine snapshots at terminal RESULT and enriches
 * them with live payment status while settlement progresses. The cache survives
 * GameplayLifecycle teardown so reconnecting clients can still restore Page6.
 *
 * This module does not duplicate RecoveryEngine logic — it only stores the
 * frozen snapshots RecoveryEngine already builds.
 */
export class RecoverySnapshotCache {

    constructor({
        logger,
        eventBus,
        recoveryEngine,
        paymentEngine = null,
        auditEngine = null,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._recoveryEngine = recoveryEngine;

        this._paymentEngine = paymentEngine;

        this._auditEngine = auditEngine;

        this._devMode = devMode;

        this._handlers = [];

        this._cache = new Map();

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
            EVENT_TYPES.PAYMENT_STARTED,
            (envelope) => {

                this._refreshPaymentStatus(envelope.payload?.gameId);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_COMPLETED,
            (envelope) => {

                this._refreshPaymentStatus(envelope.payload?.gameId);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_FAILED,
            (envelope) => {

                this._refreshPaymentStatus(envelope.payload?.gameId);

            }
        );

        this._subscribe(
            EVENT_TYPES.AUDIT_READY,
            (envelope) => {

                this._refreshAuditStatus(envelope.payload?.gameId, "READY");

            }
        );

        this._subscribe(
            EVENT_TYPES.AUDIT_FAILED,
            (envelope) => {

                this._refreshAuditStatus(envelope.payload?.gameId, "FAILED");

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._cache.clear();

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

        this._cache.clear();

        this._initialized = false;

    }

    get(gameId) {

        return this._cache.get(gameId) ?? null;

    }

    forget(gameId) {

        this._cache.delete(gameId);

    }

    _handleGameStateChanged(payload) {

        const gameId = payload?.gameId;

        const currentState = payload?.currentState ?? payload?.state;

        if (!gameId || currentState !== GAME_STATES.RESULT) {

            return;

        }

        this._capture(gameId);

    }

    _refreshPaymentStatus(gameId) {

        if (!gameId || !this._cache.has(gameId)) {

            return;

        }

        const entry = this._cache.get(gameId);

        entry.paymentStatus = this._resolvePaymentStatus(gameId);

        entry.payment = this._paymentEngine?.getPayment(gameId) ?? entry.payment;

        this._logStep(`Payment status refreshed for ${gameId}`);

    }

    _refreshAuditStatus(gameId, auditStatus) {

        if (!gameId || !this._cache.has(gameId)) {

            return;

        }

        const entry = this._cache.get(gameId);

        entry.auditStatus = auditStatus;

        this._logStep(`Audit status refreshed for ${gameId} -> ${auditStatus}`);

    }

    _capture(gameId) {

        try {

            const snapshot = this._recoveryEngine.buildRecoverySnapshot(gameId);

            this._cache.set(gameId, {
                snapshot,
                payment: this._paymentEngine?.getPayment(gameId) ?? null,
                paymentStatus: this._resolvePaymentStatus(gameId),
                auditStatus: this._resolveAuditStatus(gameId),
                capturedAt: Date.now()
            });

            this._logStep(`Snapshot cached for ${gameId}`);

        } catch (error) {

            this._logger.error(
                `Recovery snapshot capture failed | gameId=${gameId} | reason=${error.message}`
            );

        }

    }

    _resolvePaymentStatus(gameId) {

        if (!this._paymentEngine) {

            return null;

        }

        return this._paymentEngine.getPaymentStatus(gameId);

    }

    _resolveAuditStatus(gameId) {

        if (!this._auditEngine) {

            return null;

        }

        return this._auditEngine.getAuditReport(gameId) ? "READY" : null;

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _logStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.info(`[RecoverySnapshotCache] ${message}`);

    }

}
