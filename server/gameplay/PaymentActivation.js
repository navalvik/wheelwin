import { EVENT_TYPES } from "../events/EventTypes.js";

/**
 * C4.2 — Payment Activation.
 *
 * Orchestration glue that connects the frozen Gameplay Core to the existing
 * PaymentEngine. It performs no settlement logic itself: it only triggers the
 * authoritative PaymentEngine exactly once, after the winner is determined.
 *
 * Authoritative flow:
 *
 *   WINNER_DETERMINED -> PaymentEngine.processPayment()
 *                         -> PAYMENT_STARTED
 *                         -> PAYMENT_COMPLETED (or PAYMENT_FAILED)
 *
 * Rules honoured:
 *   - Settlement begins only after WINNER_DETERMINED, never before.
 *   - Settlement is attempted exactly once per game.
 *   - Payment failure is swallowed here so it can never affect the winner,
 *     GameState, physics, or gameplay history — the game is already finished.
 */
export class PaymentActivation {

    constructor({
        logger,
        eventBus,
        paymentEngine,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._paymentEngine = paymentEngine;

        this._devMode = devMode;

        this._handlers = [];

        this._settled = new Set();

        this._initialized = false;

    }

    initialize() {

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

    forgetGame(gameId) {

        this._settled.delete(gameId);

    }

    _handleWinnerDetermined(payload) {

        const gameId = payload?.gameId;

        if (!gameId || this._settled.has(gameId)) {

            return;

        }

        this._settled.add(gameId);

        this._logStep("WINNER_DETERMINED");

        this._logStep("PaymentEngine.processPayment()");

        try {

            const result = this._paymentEngine.processPayment(gameId);

            this._logStep(
                `PAYMENT_COMPLETED | winnerAmount=${result?.winnerAmount ?? "?"}`
            );

        } catch (error) {

            // Settlement failure is already surfaced authoritatively via
            // PAYMENT_FAILED inside PaymentEngine. It must not propagate: the
            // gameplay result is immutable and unaffected by payment outcome.
            this._logStep(`PAYMENT_FAILED | reason=${error.message}`);

        }

    }

    _reset() {

        this._settled.clear();

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _logStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.info(`[PaymentActivation] ${message}`);

    }

}
