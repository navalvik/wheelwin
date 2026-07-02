import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "./gameState/GameStates.js";
import {
    getAllowedTransitions,
    isTransitionAllowed,
    isValidGameState
} from "./gameState/TransitionTable.js";

export class GameStateEngine {

    constructor({ logger, eventBus }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._states = new Map();

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

        for (const gameId of [...this._states.keys()]) {

            this.removeState(gameId);

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

    initializeGameState(gameId, context = {}) {

        this._assertInitialized();

        if (!gameId) {

            this._logger.error("State initialization failed: gameId is required");

            return null;

        }

        if (this._states.has(gameId)) {

            this._logger.error(
                `State initialization failed: game already initialized (${gameId})`
            );

            return null;

        }

        const enteredAt = Date.now();

        const reason = context.reason ?? "Game initialized";

        const record = {
            currentState: GAME_STATES.READY,
            previousState: null,
            enteredAt,
            history: [
                {
                    state: GAME_STATES.READY,
                    enteredAt,
                    reason
                }
            ]
        };

        this._states.set(gameId, record);

        this._logger.info("State Initialized");

        this._emitStateChanged({
            gameId,
            previousState: null,
            currentState: GAME_STATES.READY,
            timestamp: enteredAt,
            reason
        });

        return this._createSnapshot(gameId, record);

    }

    getState(gameId) {

        const record = this._states.get(gameId);

        if (!record) {

            return null;

        }

        return record.currentState;

    }

    canTransition(gameId, nextState) {

        if (!isValidGameState(nextState)) {

            return false;

        }

        const record = this._states.get(gameId);

        if (!record) {

            return false;

        }

        return isTransitionAllowed(record.currentState, nextState);

    }

    transition(gameId, nextState, context = {}) {

        this._assertInitialized();

        if (!gameId) {

            this._logger.error("Transition failed: gameId is required");

            return null;

        }

        if (!isValidGameState(nextState)) {

            this._rejectTransition({
                gameId,
                currentState: this._states.get(gameId)?.currentState ?? null,
                requestedState: nextState,
                reason: "Unknown state"
            });

            return null;

        }

        const record = this._states.get(gameId);

        if (!record) {

            this._rejectTransition({
                gameId,
                currentState: null,
                requestedState: nextState,
                reason: "Game state is not initialized"
            });

            return null;

        }

        if (record.currentState === nextState) {

            this._rejectTransition({
                gameId,
                currentState: record.currentState,
                requestedState: nextState,
                reason: "Duplicate transition"
            });

            return null;

        }

        if (!isTransitionAllowed(record.currentState, nextState)) {

            this._rejectTransition({
                gameId,
                currentState: record.currentState,
                requestedState: nextState,
                reason: `Invalid transition from ${record.currentState} to ${nextState}`
            });

            return null;

        }

        const enteredAt = Date.now();

        const reason = context.reason ?? `Transition to ${nextState}`;

        const previousState = record.currentState;

        record.previousState = previousState;

        record.currentState = nextState;

        record.enteredAt = enteredAt;

        record.history.push({
            state: nextState,
            enteredAt,
            reason
        });

        this._logger.info("Transition Accepted");

        this._emitStateChanged({
            gameId,
            previousState,
            currentState: nextState,
            timestamp: enteredAt,
            reason
        });

        return this._createSnapshot(gameId, record);

    }

    resetState(gameId, context = {}) {

        this._assertInitialized();

        const existing = this._states.get(gameId);

        if (!existing) {

            this._logger.error(
                `State reset failed: game not initialized (${gameId})`
            );

            return null;

        }

        this.removeState(gameId);

        return this.initializeGameState(gameId, {
            reason: context.reason ?? "State reset"
        });

    }

    removeState(gameId) {

        if (!this._states.has(gameId)) {

            this._logger.error(
                `State removal failed: game not found (${gameId})`
            );

            return false;

        }

        this._states.delete(gameId);

        this._logger.info("State Removed");

        return true;

    }

    getHistory(gameId) {

        const record = this._states.get(gameId);

        if (!record) {

            return null;

        }

        return record.history.map((entry) => ({ ...entry }));

    }

    getDebugSnapshot(gameId) {

        const record = this._states.get(gameId);

        if (!record) {

            return null;

        }

        return {
            gameId,
            currentState: record.currentState,
            previousState: record.previousState,
            enteredAt: record.enteredAt,
            history: record.history.map((entry) => ({ ...entry })),
            allowedTransitions: [...getAllowedTransitions(record.currentState)]
        };

    }

    _rejectTransition({
        gameId,
        currentState,
        requestedState,
        reason
    }) {

        this._logger.info("Transition Rejected");

        this._eventBus.emit({
            source: EVENT_SOURCES.GAME_STATE_ENGINE,
            type: EVENT_TYPES.GAME_STATE_REJECTED,
            payload: {
                gameId,
                currentState,
                requestedState,
                reason
            }
        });

    }

    _emitStateChanged(payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.GAME_STATE_ENGINE,
            type: EVENT_TYPES.GAME_STATE_CHANGED,
            payload
        });

    }

    _createSnapshot(gameId, record) {

        return {
            gameId,
            currentState: record.currentState,
            previousState: record.previousState,
            enteredAt: record.enteredAt,
            history: record.history.map((entry) => ({ ...entry }))
        };

    }

    _handleServerShutdown() {

        for (const gameId of [...this._states.keys()]) {

            this.removeState(gameId);

        }

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("GameStateEngine is not initialized");

        }

    }

}
