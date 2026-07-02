import { randomUUID } from "node:crypto";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";
import { INPUT_ACTIONS, INPUT_COMMAND_TYPES } from "./InputCommandTypes.js";
import { PLAYER_STATE } from "../models/PlayerState.js";

function createDefaultPlayerInputState(playerId) {

    return {
        playerId,
        pressCount: 0,
        buttonPressed: false,
        lastPressTime: null,
        cooldownUntil: 0,
        locked: false
    };

}

export class InputAuthority {

    constructor({
        logger,
        eventBus,
        gameCatalog,
        playerManager,
        physicsEngine,
        gameStateEngine,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameCatalog = gameCatalog;

        this._playerManager = playerManager;

        this._physicsEngine = physicsEngine;

        this._gameStateEngine = gameStateEngine;

        this._devMode = devMode;

        this._registries = new Map();

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

        for (const gameId of [...this._registries.keys()]) {

            this._removeGameRegistry(gameId);

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

    registerPlayer(gameId, playerId) {

        this._assertInitialized();

        if (!gameId || !playerId) {

            this._logger.error("Player registration failed: gameId and playerId are required");

            return null;

        }

        const registry = this._getOrCreateRegistry(gameId);

        if (registry.players.has(playerId)) {

            this._logger.error(
                `Player registration failed: player already registered (${playerId})`
            );

            return null;

        }

        const state = createDefaultPlayerInputState(playerId);

        registry.players.set(playerId, state);

        return this._createPlayerSnapshot(state);

    }

    registerPlayers(gameId, playerIds) {

        this._assertInitialized();

        if (!gameId || !Array.isArray(playerIds)) {

            this._logger.error(
                "Player registration failed: gameId and playerIds are required"
            );

            return [];

        }

        const registered = [];

        for (const playerId of playerIds) {

            this._playerManager.setPlayerState(playerId, PLAYER_STATE.PLAYING);

            const snapshot = this.registerPlayer(gameId, playerId);

            if (snapshot) {

                registered.push(playerId);

            }

        }

        return registered;

    }

    removePlayer(gameId, playerId) {

        this._assertInitialized();

        const registry = this._registries.get(gameId);

        if (!registry) {

            return false;

        }

        return registry.players.delete(playerId);

    }

    handleButtonPress(gameId, playerId) {

        this._assertInitialized();

        return this._handleButtonAction(
            gameId,
            playerId,
            INPUT_ACTIONS.PRESS
        );

    }

    handleButtonRelease(gameId, playerId) {

        this._assertInitialized();

        return this._handleButtonAction(
            gameId,
            playerId,
            INPUT_ACTIONS.RELEASE
        );

    }

    getPlayerInputState(gameId, playerId) {

        const state = this._registries.get(gameId)?.players.get(playerId);

        if (!state) {

            return null;

        }

        return this._createPlayerSnapshot(state);

    }

    hasGame(gameId) {

        return this._registries.has(gameId);

    }

    resetPlayer(gameId, playerId) {

        this._assertInitialized();

        const registry = this._registries.get(gameId);

        if (!registry || !registry.players.has(playerId)) {

            return null;

        }

        registry.players.set(playerId, createDefaultPlayerInputState(playerId));

        return this.getPlayerInputState(gameId, playerId);

    }

    getAcceptedCommands(gameId) {

        const registry = this._registries.get(gameId);

        if (!registry) {

            return [];

        }

        return registry.acceptedCommands.map((command) => ({ ...command }));

    }

    getDebugSnapshot(gameId, playerId) {

        const state = this.getPlayerInputState(gameId, playerId);

        if (!state) {

            return null;

        }

        const now = Date.now();

        return {
            gameId,
            playerId,
            pressCount: state.pressCount,
            buttonPressed: state.buttonPressed,
            cooldownActive: now < state.cooldownUntil,
            cooldownUntil: state.cooldownUntil,
            locked: state.locked
        };

    }

    _handleButtonAction(gameId, playerId, action) {

        this._logInputStep("Input Received");

        const gameState = this._gameStateEngine.getState(gameId);

        const registry = this._registries.get(gameId);

        const state = registry?.players.get(playerId);

        if (!registry || !state) {

            this._logInputStep(`GameState = ${gameState ?? "unknown"}`);

            return this._rejectInput({
                gameId,
                playerId,
                action,
                gameState,
                reason: "Player is not registered for input"
            });

        }

        this._logInputStep("Player validated");

        this._logInputStep(`GameState = ${gameState ?? "unknown"}`);

        const validation = this._validateInput(
            gameId,
            playerId,
            state,
            action,
            gameState
        );

        if (!validation.valid) {

            return this._rejectInput({
                gameId,
                playerId,
                action,
                gameState,
                reason: validation.reason
            });

        }

        const timestamp = Date.now();

        if (action === INPUT_ACTIONS.PRESS) {

            state.buttonPressed = true;

            state.lastPressTime = timestamp;

            this._enqueueCommand(registry, {
                type: INPUT_COMMAND_TYPES.ACCELERATION_START,
                gameId,
                playerId,
                timestamp
            });

        } else {

            state.buttonPressed = false;

            state.pressCount += 1;

            const inputRules = this._gameCatalog.getInputRules();

            state.cooldownUntil = timestamp + inputRules.pressCooldownMs;

            this._enqueueCommand(registry, {
                type: INPUT_COMMAND_TYPES.ACCELERATION_STOP,
                gameId,
                playerId,
                timestamp
            });

            this._emit(EVENT_TYPES.PLAYER_COOLDOWN_STARTED, {
                gameId,
                playerId,
                action,
                pressCount: state.pressCount,
                timestamp,
                cooldownUntil: state.cooldownUntil
            });

            if (state.pressCount >= inputRules.maxPressCycles) {

                state.locked = true;

                this._logger.info("Press Limit Reached");

                this._logger.info("Player Locked");

                this._emit(EVENT_TYPES.PLAYER_PRESS_LIMIT_REACHED, {
                    gameId,
                    playerId,
                    action,
                    pressCount: state.pressCount,
                    timestamp
                });

            }

        }

        // C3.7: accepted commands are enqueued only.
        // Physics is applied later, exclusively during a SimulationLoop tick
        // via processCommandQueue(gameId). Never apply physics from here.

        this._logInputDecision(true);

        this._emit(EVENT_TYPES.PLAYER_INPUT_ACCEPTED, {
            gameId,
            playerId,
            action,
            gameState,
            pressCount: state.pressCount,
            timestamp
        });

        return this._createPlayerSnapshot(state);

    }

    _validateInput(gameId, playerId, state, action, gameState) {

        if (gameState !== GAME_STATES.SPEED) {

            return {
                valid: false,
                reason: `Gameplay input is only allowed during ${GAME_STATES.SPEED}`
            };

        }

        if (!this._playerManager.hasPlayer(playerId)) {

            return {
                valid: false,
                reason: "Player does not exist"
            };

        }

        const runtime = this._playerManager.getRuntime(playerId);

        if (runtime.playerState !== PLAYER_STATE.PLAYING) {

            return {
                valid: false,
                reason: "Player is not in PLAYING state"
            };

        }

        if (state.locked) {

            return {
                valid: false,
                reason: "Player input is locked"
            };

        }

        if (action === INPUT_ACTIONS.PRESS) {

            if (state.buttonPressed) {

                return {
                    valid: false,
                    reason: "Duplicate press"
                };

            }

            if (Date.now() < state.cooldownUntil) {

                return {
                    valid: false,
                    reason: "Cooldown is active"
                };

            }

        }

        if (action === INPUT_ACTIONS.RELEASE) {

            if (!state.buttonPressed) {

                return {
                    valid: false,
                    reason: "Release without press"
                };

            }

        }

        return { valid: true };

    }

    _enqueueCommand(registry, command) {

        registry.sequenceNumber += 1;

        const queuedCommand = {
            commandId: `cmd_${randomUUID()}`,
            gameId: command.gameId,
            playerId: command.playerId,
            type: command.type,
            timestamp: command.timestamp,
            sequenceNumber: registry.sequenceNumber
        };

        registry.commandQueue.push(queuedCommand);

        registry.acceptedCommands.push({ ...queuedCommand });

    }

    processCommandQueue(gameId) {

        this._assertInitialized();

        const registry = this._registries.get(gameId);

        if (!registry || registry.commandQueue.length === 0) {

            return 0;

        }

        const inputRules = this._gameCatalog.getInputRules();

        this._logQueueStep("Processing Queue");

        let processed = 0;

        while (registry.commandQueue.length > 0) {

            const command = registry.commandQueue.shift();

            this._applyCommandToPhysics(command, inputRules);

            processed += 1;

        }

        return processed;

    }

    _applyCommandToPhysics(command, inputRules) {

        this._logQueueStep(`Player ${command.playerId}`);

        if (command.type === INPUT_COMMAND_TYPES.ACCELERATION_START) {

            this._logQueueStep(INPUT_COMMAND_TYPES.ACCELERATION_START);

            this._physicsEngine.applyAcceleration(
                command.gameId,
                inputRules.accelerationRadPerSecSq
            );

            this._logQueueStep("PhysicsEngine.applyAcceleration()");

        } else if (command.type === INPUT_COMMAND_TYPES.ACCELERATION_STOP) {

            this._logQueueStep(INPUT_COMMAND_TYPES.ACCELERATION_STOP);

            this._physicsEngine.applyAcceleration(command.gameId, 0);

            this._logQueueStep("PhysicsEngine.applyAcceleration()");

        }

    }

    _logQueueStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[InputAuthority] ${message}`);

    }

    _rejectInput({ gameId, playerId, action, gameState, reason }) {

        this._logInputDecision(false);

        this._emit(EVENT_TYPES.PLAYER_INPUT_REJECTED, {
            gameId,
            playerId,
            action,
            gameState,
            reason
        });

        return null;

    }

    _logInputStep(message) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(`[InputAuthority] ${message}`);

    }

    _logInputDecision(accepted) {

        if (!this._devMode) {

            return;

        }

        this._logger.debug(
            `[InputAuthority] ${accepted ? "Accepted" : "Rejected"}`
        );

    }

    _getOrCreateRegistry(gameId) {

        let registry = this._registries.get(gameId);

        if (!registry) {

            registry = {
                gameId,
                players: new Map(),
                commandQueue: [],
                acceptedCommands: [],
                sequenceNumber: 0
            };

            this._registries.set(gameId, registry);

        }

        return registry;

    }

    _removeGameRegistry(gameId) {

        this._registries.delete(gameId);

    }

    _createPlayerSnapshot(state) {

        return {
            playerId: state.playerId,
            pressCount: state.pressCount,
            buttonPressed: state.buttonPressed,
            lastPressTime: state.lastPressTime,
            cooldownUntil: state.cooldownUntil,
            locked: state.locked
        };

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.INPUT_AUTHORITY,
            type,
            payload
        });

    }

    _handleServerShutdown() {

        this._registries.clear();

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("InputAuthority is not initialized");

        }

    }

}
