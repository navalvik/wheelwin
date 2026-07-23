import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import {
    GAMEPLAY_PHASE_SEQUENCE,
    getPhaseCompletedEventType,
    getPhaseStartedEventType,
    isOfficialGameplayPhase
} from "./GameplayPhaseSequence.js";

/**
 * P5.3 — Single authoritative owner of Page5 gameplay phase lifecycle.
 *
 * Server owns every phase entry and the transition to Page6. Clients render only.
 * Reacts to GameClockEngine scheduler events; never controls physics or inputs.
 *
 * P6.8B — when requireSettlementBeforePage6 is true, OPEN_PAGE6 waits for
 * SETTLEMENT_COMPLETED (in addition to RESULT_COMPLETED).
 */
export class GameplayPhaseLifecycle {

    constructor({
        logger,
        eventBus,
        gameStateEngine,
        gameClockEngine,
        winnerEngine = null,
        requireSettlementBeforePage6 = false,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameStateEngine = gameStateEngine;

        this._gameClockEngine = gameClockEngine;

        this._winnerEngine = winnerEngine;

        this._requireSettlementBeforePage6 = requireSettlementBeforePage6 === true;

        this._devMode = devMode;

        this._handlers = [];

        this._completedGames = new Set();

        this._resultReady = new Set();

        this._settlementReady = new Set();

        this._initialized = false;

    }

    initialize() {

        validateLifecycleEventCoverage();

        for (const phase of GAMEPLAY_PHASE_SEQUENCE) {

            this._subscribe(getPhaseStartedEventType(phase), (envelope) => {

                this._handlePhaseStarted(envelope.payload);

            });

            this._subscribe(getPhaseCompletedEventType(phase), (envelope) => {

                this._handlePhaseCompleted(envelope.payload);

            });

        }

        this._subscribe(
            EVENT_TYPES.SETTLEMENT_COMPLETED,
            (envelope) => {

                this._handleSettlementCompleted(envelope.payload);

            }
        );

        this._initialized = true;

    }

    /**
     * P6.8B — enable OPEN_PAGE6 gate after ContractSettlementManager is wired.
     */
    configureSettlementGate({ enabled = true } = {}) {

        this._requireSettlementBeforePage6 = enabled === true;

    }

    shutdown() {

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._completedGames.clear();

        this._resultReady.clear();

        this._settlementReady.clear();

        this._initialized = false;

    }

    forgetGame(gameId) {

        this._completedGames.delete(gameId);

        this._resultReady.delete(gameId);

        this._settlementReady.delete(gameId);

    }

    _handlePhaseStarted({ gameId, phase }) {

        if (!gameId || !isOfficialGameplayPhase(phase)) {

            return;

        }

        const currentState = this._gameStateEngine.getState(gameId);

        if (currentState === phase) {

            return;

        }

        const snapshot = this._gameStateEngine.transition(gameId, phase, {
            reason: `${phase} started`
        });

        if (!snapshot && this._devMode) {

            this._logger.info(
                `[GameplayPhaseLifecycle] ignored ${phase} start | gameId=${gameId}`
            );

        }

    }

    _handlePhaseCompleted({ gameId, phase }) {

        if (!gameId || !isOfficialGameplayPhase(phase)) {

            return;

        }

        if (phase !== GAME_STATES.RESULT) {

            return;

        }

        if (this._completedGames.has(gameId)) {

            return;

        }

        this._resultReady.add(gameId);

        this._emitLifecycle(EVENT_TYPES.GAME_RESULT_READY, {
            gameId,
            result: this._winnerEngine?.getResult(gameId) ?? null,
            timestamp: Date.now()
        });

        this._tryOpenPage6(gameId);

    }

    _handleSettlementCompleted(payload) {

        const gameId = payload?.gameId;

        if (!gameId) {

            return;

        }

        this._settlementReady.add(gameId);

        this._tryOpenPage6(gameId);

    }

    _tryOpenPage6(gameId) {

        if (!gameId || this._completedGames.has(gameId)) {

            return;

        }

        if (!this._resultReady.has(gameId)) {

            return;

        }

        if (
            this._requireSettlementBeforePage6
            && !this._settlementReady.has(gameId)
        ) {

            if (this._devMode) {

                this._logger.info(
                    `[GameplayPhaseLifecycle] OPEN_PAGE6 deferred — waiting for settlement | gameId=${gameId}`
                );

            }

            return;

        }

        this._completedGames.add(gameId);

        this._emitLifecycle(EVENT_TYPES.OPEN_PAGE6, {
            gameId,
            timestamp: Date.now()
        });

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _emitLifecycle(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.GAMEPLAY_PHASE_LIFECYCLE,
            type,
            payload
        });

        if (this._devMode) {

            this._logger.info(
                `[GameplayPhaseLifecycle] ${type} | gameId=${payload.gameId}`
            );

        }

    }

}

function validateLifecycleEventCoverage() {

    for (const phase of GAMEPLAY_PHASE_SEQUENCE) {

        if (!(getPhaseStartedEventType(phase) in EVENT_TYPES)) {

            throw new Error(
                `Missing lifecycle started event for phase ${phase}`
            );

        }

        if (!(getPhaseCompletedEventType(phase) in EVENT_TYPES)) {

            throw new Error(
                `Missing lifecycle completed event for phase ${phase}`
            );

        }

    }

}
