import { randomUUID } from "node:crypto";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationValidationError } from "../engines/configuration/ConfigurationValidationError.js";
import { Game } from "../models/Game.js";
import { GAME_STATUS } from "../models/GameStatus.js";
import {
    areRoomPlayerProfilesComplete,
    isPlayerProfileComplete
} from "./playerProfileCompleteness.js";

export class GameManager {

    constructor({ logger, eventBus }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._games = new Map();

        this._gameListeners = new Map();

        this._infrastructureHandlers = [];

        this._bootstrapHandler = null;

        this._profilesReadyHandler = null;

        this._entryPaymentCompletedHandler = null;

        this._bootstrap = null;

        // roomId → gameId waiting for ENTRY_PAYMENT_COMPLETED (R1.1).
        this._pendingGameplayActivation = new Map();

        // R5.15 — roomId → gameId waiting for complete Page2 profiles.
        this._pendingConfigurationByRoom = new Map();

        this._initialized = false;

    }

    configureGameplayBootstrap({
        roomManager,
        playerManager,
        configurationEngine,
        gameStateEngine,
        inputAuthority,
        physicsEngine,
        gameClockEngine,
        gameCatalog,
        gameplayContextResolver = null,
        devMode = false
    }) {

        this._bootstrap = {
            roomManager,
            playerManager,
            configurationEngine,
            gameStateEngine,
            inputAuthority,
            physicsEngine,
            gameClockEngine,
            gameCatalog,
            gameplayContextResolver,
            devMode
        };

        if (!this._initialized) {

            return;

        }

        this._subscribeGameplayBootstrap();

    }

    linkGameplayContextResolver(gameplayContextResolver) {

        if (this._bootstrap) {

            this._bootstrap.gameplayContextResolver = gameplayContextResolver;

        }

    }

    initialize() {

        const shutdownHandler = (envelope) => {

            this._handleServerShutdown(envelope);

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

        this._subscribeGameplayBootstrap();

    }

    shutdown() {

        if (this._bootstrapHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.SETUP_SESSION_COMPLETED,
                this._bootstrapHandler
            );

            this._bootstrapHandler = null;

        }

        if (this._profilesReadyHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.ALL_PLAYER_PROFILES_READY,
                this._profilesReadyHandler
            );

            this._profilesReadyHandler = null;

        }

        if (this._entryPaymentCompletedHandler) {

            this._eventBus.unsubscribe(
                EVENT_TYPES.ENTRY_PAYMENT_COMPLETED,
                this._entryPaymentCompletedHandler
            );

            this._entryPaymentCompletedHandler = null;

        }

        this._pendingGameplayActivation.clear();

        this._pendingConfigurationByRoom.clear();

        for (const gameId of [...this._games.keys()]) {

            this.destroyGame(gameId);

        }

        for (const subscription of this._infrastructureHandlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._infrastructureHandlers = [];

        this._bootstrap = null;

        this._initialized = false;

    }

    createGame(roomId, { players = [] } = {}) {

        if (!roomId) {

            this._logger.error("Game creation failed: roomId is required");

            return null;

        }

        const gameId = this._generateGameId();

        if (this._games.has(gameId)) {

            this._logger.error(
                `Game creation failed: gameId already exists (${gameId})`
            );

            return null;

        }

        const game = new Game({
            gameId,
            roomId,
            createdAt: Date.now(),
            status: GAME_STATUS.CREATED,
            players: [...players],
            metadata: {}
        });

        this._games.set(gameId, game);

        this._logger.info(`Game Created: ${gameId}`);

        this._emit(EVENT_TYPES.GAME_CREATED, {
            gameId: game.gameId,
            roomId: game.roomId,
            status: game.status,
            players: [...game.players]
        });

        return game;

    }

    initializeGame(gameId) {

        const game = this._getGameOrLog(gameId, "initialize");

        if (!game) {

            return null;

        }

        if (game.status !== GAME_STATUS.CREATED) {

            this._logger.error(
                `Game initialize failed: ${gameId} is ${game.status}, expected ${GAME_STATUS.CREATED}`
            );

            return null;

        }

        game.status = GAME_STATUS.INITIALIZED;

        this._logger.info(`Game Initialized: ${gameId}`);

        this._emit(EVENT_TYPES.GAME_INITIALIZED, {
            gameId: game.gameId,
            roomId: game.roomId,
            status: game.status
        });

        game.status = GAME_STATUS.READY;

        return game;

    }

    startGame(gameId) {

        const game = this._getGameOrLog(gameId, "start");

        if (!game) {

            return null;

        }

        if (game.status !== GAME_STATUS.READY) {

            this._logger.error(
                `Game start failed: ${gameId} is ${game.status}, expected ${GAME_STATUS.READY}`
            );

            return null;

        }

        game.status = GAME_STATUS.RUNNING;

        this._logger.info(`Game Started: ${gameId}`);

        this._emit(EVENT_TYPES.GAME_STARTED, {
            gameId: game.gameId,
            roomId: game.roomId,
            status: game.status
        });

        return game;

    }

    finishGame(gameId) {

        const game = this._getGameOrLog(gameId, "finish");

        if (!game) {

            return null;

        }

        if (game.status !== GAME_STATUS.RUNNING) {

            this._logger.error(
                `Game finish failed: ${gameId} is ${game.status}, expected ${GAME_STATUS.RUNNING}`
            );

            return null;

        }

        game.status = GAME_STATUS.FINISHED;

        this._logger.info(`Game Finished: ${gameId}`);

        this._emit(EVENT_TYPES.GAME_FINISHED, {
            gameId: game.gameId,
            roomId: game.roomId,
            status: game.status
        });

        return game;

    }

    destroyGame(gameId) {

        const game = this._getGameOrLog(gameId, "destroy");

        if (!game) {

            return false;

        }

        if (game.status === GAME_STATUS.DESTROYED) {

            this._logger.error(
                `Game destroy failed: ${gameId} is already ${GAME_STATUS.DESTROYED}`
            );

            return false;

        }

        game.status = GAME_STATUS.DESTROYED;

        this._logger.info(`Game Destroyed: ${gameId}`);

        if (game.roomId) {

            this._pendingGameplayActivation.delete(game.roomId);

            this._pendingConfigurationByRoom.delete(game.roomId);

        }

        this._emit(EVENT_TYPES.GAME_DESTROYED, {
            gameId: game.gameId,
            roomId: game.roomId,
            status: game.status
        });

        this._clearGameListeners(gameId);

        this._games.delete(gameId);

        return true;

    }

    getGame(gameId) {

        const game = this._games.get(gameId);

        if (!game) {

            return null;

        }

        return game.toSnapshot();

    }

    getGames() {

        return [...this._games.values()].map((game) => game.toSnapshot());

    }

    hasGame(gameId) {

        return this._games.has(gameId);

    }

    getDebugSnapshot() {

        return {
            activeGames: this.getGames().map((game) => ({
                gameId: game.gameId,
                status: game.status,
                createdAt: game.createdAt
            }))
        };

    }

    _handleServerShutdown() {

        for (const gameId of [...this._games.keys()]) {

            this.destroyGame(gameId);

        }

    }

    _getGameOrLog(gameId, operation) {

        if (!gameId) {

            this._logger.error(`Game ${operation} failed: gameId is required`);

            return null;

        }

        const game = this._games.get(gameId);

        if (!game) {

            this._logger.error(
                `Game ${operation} failed: game not found (${gameId})`
            );

            return null;

        }

        return game;

    }

    _generateGameId() {

        return `game_${randomUUID()}`;

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.GAME_MANAGER,
            type,
            payload
        });

    }

    _clearGameListeners(gameId) {

        const subscriptions = this._gameListeners.get(gameId);

        if (!subscriptions) {

            return;

        }

        for (const subscription of subscriptions) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._gameListeners.delete(gameId);

    }

    _subscribeGameplayBootstrap() {

        if (!this._bootstrap || this._bootstrapHandler) {

            return;

        }

        this._bootstrapHandler = (envelope) => {

            this._handleSetupSessionCompleted(envelope);

        };

        this._eventBus.subscribe(
            EVENT_TYPES.SETUP_SESSION_COMPLETED,
            this._bootstrapHandler
        );

        this._profilesReadyHandler = (envelope) => {

            this._handleAllPlayerProfilesReady(envelope);

        };

        this._eventBus.subscribe(
            EVENT_TYPES.ALL_PLAYER_PROFILES_READY,
            this._profilesReadyHandler
        );

        this._entryPaymentCompletedHandler = (envelope) => {

            this._handleEntryPaymentCompleted(envelope);

        };

        this._eventBus.subscribe(
            EVENT_TYPES.ENTRY_PAYMENT_COMPLETED,
            this._entryPaymentCompletedHandler
        );

    }

    _handleSetupSessionCompleted(envelope) {

        const roomId = envelope.payload?.roomId;

        if (!roomId || !this._bootstrap) {

            return;

        }

        const room = this._bootstrap.roomManager.getRoom(roomId);

        if (!room) {

            this._logger.error(
                `Gameplay bootstrap failed: room not found (${roomId})`
            );

            return;

        }

        if (room.players.length !== room.maxPlayers) {

            this._logger.error(
                `Gameplay bootstrap failed: room is not full (${roomId})`
            );

            return;

        }

        try {

            this._logBootstrap("SETUP_SESSION_COMPLETED received");

            this._logBootstrap("Creating game...");

            const game = this.createGame(roomId, {
                players: room.players
            });

            if (!game) {

                return;

            }

            this._logBootstrap("GAME_CREATED");

            this._bootstrap.gameplayContextResolver?.activateRoomGame(
                roomId,
                game.gameId
            );

            this._logBootstrap("Registering players...");

            this._bootstrap.inputAuthority.registerPlayers(
                game.gameId,
                room.players
            );

            this._logBootstrap("Creating physics simulation...");

            this._bootstrap.physicsEngine.createSimulation(game.gameId);

            this._logBootstrap("Creating GameClock...");

            this._bootstrap.gameClockEngine.createClock(game.gameId);

            // R1.1 — Do not start simulation / clock / READY phases until
            // ENTRY_PAYMENT_COMPLETED. Prep only; gameplay waits.
            this._pendingGameplayActivation.set(roomId, game.gameId);

            // R5.15 — Configuration waits for complete Page2 profiles.
            this._pendingConfigurationByRoom.set(roomId, game.gameId);

            this._logBootstrap(
                "Gameplay prep ready — waiting for player profiles / ENTRY_PAYMENT"
            );

            this._tryGenerateConfiguration(roomId);

        } catch (error) {

            this._logger.error(
                `Gameplay bootstrap failed: ${error.message}`
            );

        }

    }

    _handleAllPlayerProfilesReady(envelope) {

        const roomId = envelope.payload?.roomId;

        if (!roomId || !this._bootstrap) {

            return;

        }

        this._logBootstrap(
            `ALL_PLAYER_PROFILES_READY | roomId=${roomId}`
        );

        this._tryGenerateConfiguration(roomId);

    }

    /**
     * R5.15 — Build/freeze/commit WHEEL_CONFIGURATION only when every seat
     * has a complete Page2 profile in PlayerManager. Idempotent.
     */
    _tryGenerateConfiguration(roomId) {

        if (!this._bootstrap || !roomId) {

            return;

        }

        const gameId = this._pendingConfigurationByRoom.get(roomId);

        if (!gameId) {

            return;

        }

        if (this._bootstrap.configurationEngine.getConfiguration(gameId)) {

            this._pendingConfigurationByRoom.delete(roomId);

            return;

        }

        const room = this._bootstrap.roomManager.getRoom(roomId);

        if (!room || room.players.length !== room.maxPlayers) {

            return;

        }

        if (!areRoomPlayerProfilesComplete(
            this._bootstrap.playerManager,
            room.players
        )) {

            this._logBootstrap(
                `Configuration deferred — incomplete profiles | roomId=${roomId}`
            );

            return;

        }

        try {

            const configurationRoom = {
                roomId: room.roomId,
                stake: this._resolveBootstrapStake()
            };

            const configurationPlayers = this._buildConfigurationPlayers(room);

            this._logBootstrap("Generating configuration...");

            let configuration = this._bootstrap.configurationEngine
                .buildConfiguration(
                    gameId,
                    configurationRoom,
                    configurationPlayers
                );

            this._bootstrap.configurationEngine.validateConfiguration(
                configuration
            );

            configuration = this._bootstrap.configurationEngine
                .freezeConfiguration(configuration);

            this._logBootstrap("Configuration frozen");

            // R5.13D — Temporary diagnostic only.
            this._logWheelConfigurationDiagnostic(
                configuration,
                configurationPlayers
            );

            this._bootstrap.configurationEngine.commitConfiguration(
                configuration
            );

            this._pendingConfigurationByRoom.delete(roomId);

            this._logBootstrap("CONFIGURATION_READY");

        } catch (error) {

            if (error instanceof ConfigurationValidationError) {

                this._logger.error(
                    [
                        "Gameplay configuration failed",
                        `roomId=${roomId}`,
                        `reason=${error.reason}`
                    ].join(" | ")
                );

                return;

            }

            this._logger.error(
                `Gameplay configuration failed: ${error.message}`
            );

        }

    }

    _handleEntryPaymentCompleted(envelope) {

        const roomId = envelope.payload?.roomId;

        if (!roomId || !this._bootstrap) {

            return;

        }

        const gameId = this._pendingGameplayActivation.get(roomId)
            ?? envelope.payload?.gameId
            ?? null;

        if (!gameId) {

            this._logger.error(
                `Gameplay activation failed: no pending game for room (${roomId})`
            );

            return;

        }

        // R5.15 — Do not activate PRE_GAME_READY without immutable wheel config.
        if (!this._bootstrap.configurationEngine.getConfiguration(gameId)) {

            this._logBootstrap(
                `ENTRY_PAYMENT_COMPLETED deferred — waiting for configuration | roomId=${roomId}`
            );

            this._tryGenerateConfiguration(roomId);

            if (!this._bootstrap.configurationEngine.getConfiguration(gameId)) {

                this._logger.error(
                    `Gameplay activation failed: configuration missing (${gameId})`
                );

                return;

            }

        }

        this._activateGameplaySession(roomId, gameId);

    }

    _activateGameplaySession(roomId, gameId) {

        if (!this._bootstrap || !gameId) {

            return;

        }

        const game = this.getGame(gameId);

        if (!game) {

            this._logger.error(
                `Gameplay activation failed: game not found (${gameId})`
            );

            return;

        }

        // Idempotent — already past CREATED means activation ran.
        if (game.status !== GAME_STATUS.CREATED) {

            return;

        }

        try {

            this._logBootstrap(
                `ENTRY_PAYMENT_COMPLETED — activating gameplay | roomId=${roomId}`
            );

            this._logBootstrap("Initializing GameState...");

            this._bootstrap.gameStateEngine.initializeGameState(gameId);

            // Physics stays CREATED through PRE_GAME_READY (static wheel/triangle).
            // ReadyPhaseBroadcaster starts the simulation when READY begins.

            this._logBootstrap("Starting GameClock (PRE_GAME_READY)...");

            this._bootstrap.gameClockEngine.startClock(gameId);

            this.initializeGame(gameId);

            this._pendingGameplayActivation.delete(roomId);

            this._logBootstrap("GAME_INITIALIZED");

        } catch (error) {

            this._logger.error(
                `Gameplay activation failed: ${error.message}`
            );

        }

    }

    _resolveBootstrapStake() {

        const stakes = this._bootstrap.gameCatalog.getStakes();

        return stakes[0] ?? 1;

    }

    _buildConfigurationPlayers(room) {

        return room.players.map((playerId) => {

            const identity = this._bootstrap.playerManager.getIdentity(playerId);

            if (!isPlayerProfileComplete(identity)) {

                throw new Error(
                    `Incomplete player profile for configuration (${playerId})`
                );

            }

            const sectorCount = identity.sectorCount === 2 ? 2 : 1;

            const colors = [identity.color];

            if (sectorCount === 2) {

                colors.push(identity.colorSector2);

            }

            return {
                playerId,
                nickname: identity.nickname,
                sectorCount,
                sectorArrangement: identity.sectorArrangement === "separate"
                    ? "separate"
                    : "together",
                colors,
                icon: identity.icon
            };

        });

    }

    /**
     * R5.13D — Temporary diagnostic dump of generated WHEEL_CONFIGURATION.
     * Does not alter configuration, gameplay, or protocol.
     */
    _logWheelConfigurationDiagnostic(configuration, configurationPlayers) {

        const lines = [];

        const push = (line = "") => {

            lines.push(line);

        };

        push("====================================================");
        push("WHEEL_CONFIGURATION GENERATED (R5.13D)");
        push(`Game ID: ${configuration?.gameId ?? "—"}`);
        push(`Room ID: ${configuration?.metadata?.roomId ?? "—"}`);
        push(`Trace Seed: ${configuration?.traceSeed ?? "—"}`);
        push("");
        push("INPUT to ConfigurationEngine (_buildConfigurationPlayers):");
        push("");

        const inputPlayers = Array.isArray(configurationPlayers)
            ? configurationPlayers
            : [];

        inputPlayers.forEach((player, index) => {

            push(`Input Player ${index + 1}`);
            push(`  playerId: ${player?.playerId ?? "—"}`);
            push(`  nickname: ${player?.nickname ?? "—"}`);
            push(`  sectorCount: ${player?.sectorCount ?? "—"}`);
            push(`  colors: ${JSON.stringify(player?.colors ?? [])}`);
            push(`  sectorArrangement: ${player?.sectorArrangement ?? "—"}`);
            push("");

        });

        push("----------------------------------------------------");
        push("Players (committed configuration.players):");
        push("");

        const players = Array.isArray(configuration?.players)
            ? configuration.players
            : [];

        players.forEach((player, index) => {

            push(`Player ${index + 1}`);
            push(`  ownerId: ${player?.playerId ?? "—"}`);
            push(`  nickname: ${player?.nickname ?? "—"}`);
            push(`  sectorCount: ${player?.sectorCount ?? "—"}`);
            push(`  color: ${player?.color ?? "—"}`);
            push(`  colors: ${JSON.stringify(player?.colors ?? [])}`);
            push(`  icon: ${player?.icon ?? "—"}`);
            push(`  sectorArrangement: ${player?.sectorArrangement ?? "—"}`);
            push("");

        });

        push("----------------------------------------------------");
        push("Generated Wheel");
        push("");

        const sectors = Array.isArray(configuration?.sectors)
            ? configuration.sectors
            : [];

        push(`Total sectors: ${sectors.length}`);
        push(`wheel.sectorCount: ${configuration?.wheel?.sectorCount ?? "—"}`);
        push("");

        sectors.forEach((sector, index) => {

            push(`Sector ${index + 1}`);
            push(`  sectorId: ${sector?.sectorId ?? "—"}`);
            push(`  ownerId: ${sector?.ownerId ?? "—"}`);
            push(`  nickname: ${sector?.nickname ?? "—"}`);
            push(`  color: ${sector?.color ?? "—"}`);
            push(`  colorId: ${sector?.colorId ?? "—"}`);
            push(`  icon: ${sector?.icon ?? "—"}`);
            push(
                `  sectorIndexForPlayer: ${
                    sector?.sectorIndexForPlayer ?? "—"
                }`
            );
            push(`  angleStart: ${sector?.angleStart ?? "—"}`);
            push(`  angleEnd: ${sector?.angleEnd ?? "—"}`);
            push("");

        });

        push("====================================================");

        const report = lines.join("\n");

        // Always print to server console for this diagnostic stage.
        console.log(report);

        this._logger.info(report);

    }

    _logBootstrap(message) {

        if (!this._bootstrap?.devMode) {

            return;

        }

        this._logger.info(`[GameplayBootstrap] ${message}`);

    }

}
