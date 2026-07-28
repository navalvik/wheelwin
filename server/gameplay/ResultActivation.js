import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

/**
 * P5.9 / R5.19 — RESULT activation.
 *
 * WINNER_DETERMINED → beginResultPhase (GameClock) → RESULT_STARTED (4s)
 * → RESULT_COMPLETED → OPEN_PAGE6 (GameplayPhaseLifecycle).
 *
 * WinnerEngine never starts RESULT. Duration is owned by GameClockEngine only.
 * Settlement runs in parallel and must not own Page6 navigation (R5.19).
 */
export class ResultActivation {

    constructor({
        logger,
        eventBus,
        gameClockEngine,
        winnerEngine,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameClockEngine = gameClockEngine;

        this._winnerEngine = winnerEngine;

        this._devMode = devMode;

        this._handlers = [];

        this._started = new Set();

        this._page6Opened = new Set();

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
            EVENT_TYPES.OPEN_PAGE6,
            (envelope) => {

                this._handleOpenPage6(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.CLEANUP_COMPLETED,
            (envelope) => {

                const gameId = envelope.payload?.gameId;

                if (gameId) {

                    this.forgetGame(gameId);

                }

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._started.clear();

                this._page6Opened.clear();

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

        this._started.clear();

        this._page6Opened.clear();

        this._initialized = false;

    }

    forgetGame(gameId) {

        this._started.delete(gameId);

        this._page6Opened.delete(gameId);

    }

    hasOpenedPage6(gameId) {

        return this._page6Opened.has(gameId);

    }

    _handleWinnerDetermined(payload) {

        const gameId = payload?.gameId;

        if (!gameId || this._started.has(gameId)) {

            return;

        }

        const result = this._winnerEngine.getResult(gameId);

        if (!result) {

            this._logger.error(
                `RESULT activation failed: winner result missing (${gameId})`
            );

            return;

        }

        this._logStep(`WINNER_DETERMINED → beginResultPhase | gameId=${gameId}`);

        const snapshot = this._gameClockEngine.beginResultPhase(gameId);

        if (!snapshot) {

            this._logger.error(
                `RESULT activation failed: beginResultPhase rejected (${gameId})`
            );

            return;

        }

        this._started.add(gameId);

        this._logStep(
            `RESULT_STARTED | durationMs=${snapshot.phaseRemainingMs
                ?? snapshot.remainingTime
                ?? "?"}`
        );

    }

    _handleOpenPage6(payload) {

        const gameId = payload?.gameId;

        if (!gameId) {

            return;

        }

        this._page6Opened.add(gameId);

        this._logStep(`OPEN_PAGE6 | gameId=${gameId}`);

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _logStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.info(`[ResultActivation] ${message}`);

    }

}
