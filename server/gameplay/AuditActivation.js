import { EVENT_TYPES } from "../events/EventTypes.js";
import { EVENT_SOURCES } from "../events/EventSources.js";

/**
 * C4.4 — Audit Activation.
 *
 * Orchestration glue that makes the existing AuditEngine the final authoritative
 * step of every completed game. It performs no audit logic itself: it only
 * triggers AuditEngine.buildAuditReport() exactly once, after payment reaches a
 * terminal state, and then publishes an authoritative AUDIT_READY event.
 *
 * Authoritative flow:
 *
 *   PAYMENT_COMPLETED / PAYMENT_FAILED
 *        -> AuditEngine.buildAuditReport()
 *             -> AUDIT_STARTED (emitted by AuditEngine)
 *             -> AUDIT_REPORT_CREATED / AUDIT_COMPLETED (emitted by AuditEngine)
 *        -> AUDIT_READY (emitted here)
 *
 * Rules honoured:
 *   - Audit begins only after payment is final, never before.
 *   - Audit is attempted exactly once per game.
 *   - Audit records only authoritative facts — it never touches winner,
 *     payment, GameState, or gameplay. The game is already complete.
 *   - Audit failure is swallowed here; AuditEngine already surfaces AUDIT_FAILED.
 *     A failed audit only changes audit status, never the game outcome.
 */
export class AuditActivation {

    constructor({
        logger,
        eventBus,
        auditEngine,
        gameReportEngine = null,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._auditEngine = auditEngine;

        this._gameReportEngine = gameReportEngine;

        this._devMode = devMode;

        this._handlers = [];

        this._audited = new Set();

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.PAYMENT_COMPLETED,
            (envelope) => {

                this._handlePaymentTerminal(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.PAYMENT_FAILED,
            (envelope) => {

                this._handlePaymentTerminal(envelope.payload);

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

        this._audited.delete(gameId);

    }

    _handlePaymentTerminal(payload) {

        const gameId = payload?.gameId;

        if (!gameId || this._audited.has(gameId)) {

            return;

        }

        this._audited.add(gameId);

        this._logStep(`Payment terminal -> AuditEngine.finalizeGame() | ${gameId}`);

        let report = null;

        try {

            report = this._auditEngine.buildAuditReport(gameId);

        } catch (error) {

            // AuditEngine already emitted AUDIT_FAILED authoritatively. The
            // failure must not propagate: gameplay and payment are immutable and
            // unaffected by audit outcome. Only audit status changes.
            this._logStep(`AUDIT_FAILED | reason=${error.message}`);

            return;

        }

        this._emitAuditReady(report);

        this._logStep(`AUDIT_READY | auditId=${report?.auditId ?? "?"}`);

    }

    _emitAuditReady(report) {

        if (!report) {

            return;

        }

        const readyPayload = buildAuditReadyPayload(report);

        let gameReport = null;

        if (this._gameReportEngine) {

            try {

                gameReport = this._gameReportEngine.createFromAuditReport(
                    report,
                    { auditId: readyPayload.auditId }
                );

            } catch (error) {

                this._logger?.error?.(
                    `Game Report creation failed: ${error.message}`
                );

            }

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.AUDIT_ENGINE,
            type: EVENT_TYPES.AUDIT_READY,
            payload: {
                ...readyPayload,
                gameReport
            }
        });

    }

    _reset() {

        this._audited.clear();

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _logStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.info(`[AuditActivation] ${message}`);

    }

}

/**
 * Derives the authoritative audit reference and immutable facts from a frozen
 * audit report. No value is computed here — every field is copied verbatim from
 * data the authoritative engines already produced.
 */
export function buildAuditReadyPayload(report) {

    const createdAt = report?.createdAt ?? Date.now();

    const traceSeed = report?.metadata?.traceSeed
        ?? report?.configuration?.traceSeed
        ?? null;

    return {
        gameId: report?.gameId ?? null,
        roomId: report?.configuration?.metadata?.roomId ?? null,
        configurationId: report?.configuration?.configurationVersion ?? null,
        auditId: buildAuditReference(report?.gameId, traceSeed, createdAt),
        winner: report?.winner?.winningPlayer ?? null,
        winningSector: report?.winner?.winningSector ?? null,
        finalWheelAngle: report?.winner?.finalAngle ?? null,
        paymentStatus: report?.payment?.paymentStatus ?? null,
        platformFee: report?.payment?.platformFee ?? null,
        traceSeed,
        timestamp: createdAt
    };

}

function buildAuditReference(gameId, traceSeed, createdAt) {

    const seed = traceSeed ?? gameId ?? "unknown";

    return `audit_${seed}_${createdAt}`;

}
