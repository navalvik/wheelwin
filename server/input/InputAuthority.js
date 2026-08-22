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
        lastReleaseAt: null,
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

        // P5.6B — after SPEED_COMPLETED, reject all PRESS/RELEASE for the game.
        this._speedInputClosed = new Set();

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

        this._speedInputClosed.clear();

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

    /**
     * R17.9T.6-D2 — Atomic safe-default registry attachment for recovery.
     *
     * Attaches a whole input registry for an eligible pre-motion phase
     * (PRE_GAME_READY / READY) with default player states and empty queues.
     * Does NOT mutate PlayerManager, emit input events, or accept historical
     * commands that are absent from authoritative persistence.
     *
     * @param {{ gameId: string, playerIds: string[], players?: object, speedInputClosed?: boolean, commandQueue?: Array, acceptedCommands?: Array, sequenceNumber?: number }} input
     * @returns {object|null} The attached registry snapshot, or null on failure.
     */
    attachRegistry({
        gameId,
        playerIds,
        players = null,
        speedInputClosed = false,
        commandQueue = [],
        acceptedCommands = [],
        sequenceNumber = 0
    }) {

        this._assertInitialized();

        if (!gameId) {

            this._logger.error("Registry attach failed: gameId is required");

            return null;

        }

        if (!Array.isArray(playerIds) || playerIds.length === 0) {

            this._logger.error("Registry attach failed: playerIds must be a non-empty array");

            return null;

        }

        // Validate no duplicate player IDs.
        const uniquePlayerIds = new Set(playerIds);

        if (uniquePlayerIds.size !== playerIds.length) {

            this._logger.error("Registry attach failed: duplicate playerIds are not allowed");

            return null;

        }

        // Validate every player exists in the already-attached PlayerManager identity boundary.
        for (const playerId of playerIds) {

            if (!this._playerManager.hasPlayer(playerId)) {

                this._logger.error(
                    `Registry attach failed: player does not exist (${playerId})`
                );

                return null;

            }

        }

        // Validate commandQueue is empty (current D2 contract provides no active input history).
        if (!Array.isArray(commandQueue) || commandQueue.length !== 0) {

            this._logger.error("Registry attach failed: commandQueue must be empty");

            return null;

        }

        // Validate acceptedCommands is empty unless authoritative persisted data exists.
        if (!Array.isArray(acceptedCommands) || acceptedCommands.length !== 0) {

            this._logger.error("Registry attach failed: acceptedCommands must be empty");

            return null;

        }

        // Validate sequenceNumber according to the safe default policy.
        if (!Number.isInteger(sequenceNumber) || sequenceNumber < 0) {

            this._logger.error("Registry attach failed: sequenceNumber must be a non-negative integer");

            return null;

        }

        // Duplicate handling.
        if (this._registries.has(gameId)) {

            const existing = this._registries.get(gameId);

            const existingPlayerIds = [...existing.players.keys()].sort();

            const expectedPlayerIds = [...playerIds].sort();

            const equivalent = existingPlayerIds.length === expectedPlayerIds.length
                && existingPlayerIds.every((id, index) => id === expectedPlayerIds[index]);

            if (equivalent) {

                this._logger.info(
                    `Registry attach: equivalent registry already attached (${gameId})`
                );

                return this._createRegistrySnapshot(existing);

            }

            this._logger.error(
                `Registry attach failed: conflicting registry already exists (${gameId})`
            );

            return null;

        }

        // Build the registry atomically before insertion.
        const registry = {
            gameId,
            players: new Map(),
            commandQueue: [],
            acceptedCommands: [],
            sequenceNumber: 0
        };

        for (const playerId of playerIds) {

            registry.players.set(playerId, createDefaultPlayerInputState(playerId));

        }

        if (speedInputClosed) {

            this._speedInputClosed.add(gameId);

        }

        this._registries.set(gameId, registry);

        this._logger.info("Registry Attached");

        return this._createRegistrySnapshot(registry);

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

    /**
     * P5.6B — Close SPEED input when the authoritative SPEED timer ends.
     * Rejects all future PRESS/RELEASE for this game until registry removal.
     */
    closeSpeedInput(gameId) {

        if (!gameId) {

            return;

        }

        this._speedInputClosed.add(gameId);

    }

    clearSpeedInputClosed(gameId) {

        if (!gameId) {

            return;

        }

        this._speedInputClosed.delete(gameId);

    }

    isSpeedInputClosed(gameId) {

        return this._speedInputClosed.has(gameId);

    }

    /**
     * P5.6A — Number of players currently holding PRESS in this game.
     */
    countHeldButtons(gameId) {

        const registry = this._registries.get(gameId);

        if (!registry) {

            return 0;

        }

        let held = 0;

        for (const state of registry.players.values()) {

            if (state.buttonPressed) {

                held += 1;

            }

        }

        return held;

    }

    removeGame(gameId) {

        this._assertInitialized();

        if (!this._registries.has(gameId)) {

            return false;

        }

        this._removeGameRegistry(gameId);

        this._speedInputClosed.delete(gameId);

        return true;

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
            completedCycles: state.pressCount,
            buttonPressed: state.buttonPressed,
            pressed: state.buttonPressed,
            lastPressTime: state.lastPressTime,
            lastReleaseAt: state.lastReleaseAt,
            cooldownActive: now < state.cooldownUntil,
            cooldownUntil: state.cooldownUntil,
            locked: state.locked,
            buttonLocked: state.locked
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

            state.lastReleaseAt = timestamp;

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
            ...this._createPlayerSnapshot(state),
            timestamp
        });

        return this._createPlayerSnapshot(state);

    }

    _validateInput(gameId, playerId, state, action, gameState) {

        if (this._speedInputClosed.has(gameId)) {

            return {
                valid: false,
                reason: "SPEED input is closed"
            };

        }

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

    _createRegistrySnapshot(registry) {

        return {
            gameId: registry.gameId,
            playerIds: [...registry.players.keys()],
            commandQueueLength: registry.commandQueue.length,
            acceptedCommandsLength: registry.acceptedCommands.length,
            sequenceNumber: registry.sequenceNumber
        };

    }

    _createPlayerSnapshot(state) {

        const inputRules = this._gameCatalog.getInputRules();

        const remainingPresses = Math.max(
            0,
            inputRules.maxPressCycles - state.pressCount
        );

        return {
            playerId: state.playerId,
            pressCount: state.pressCount,
            completedCycles: state.pressCount,
            buttonPressed: state.buttonPressed,
            pressed: state.buttonPressed,
            lastPressTime: state.lastPressTime,
            lastReleaseAt: state.lastReleaseAt,
            cooldownUntil: state.cooldownUntil,
            locked: state.locked,
            buttonLocked: state.locked,
            remainingPresses
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

        this._speedInputClosed.clear();

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("InputAuthority is not initialized");

        }

    }

}
