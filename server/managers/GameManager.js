import { randomUUID } from "node:crypto";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { ConfigurationValidationError } from "../engines/configuration/ConfigurationValidationError.js";
import { Game } from "../models/Game.js";
import { GAME_STATUS } from "../models/GameStatus.js";

export class GameManager {

    constructor({ logger, eventBus }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._games = new Map();

        this._gameListeners = new Map();

        this._infrastructureHandlers = [];

        this._bootstrapHandler = null;

        this._bootstrap = null;

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
                EVENT_TYPES.ROOM_FULL,
                this._bootstrapHandler
            );

            this._bootstrapHandler = null;

        }

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

            this._handleRoomFull(envelope);

        };

        this._eventBus.subscribe(
            EVENT_TYPES.ROOM_FULL,
            this._bootstrapHandler
        );

    }

    _handleRoomFull(envelope) {

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

            this._logBootstrap("ROOM_FULL received");

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

            const configurationRoom = {
                roomId: room.roomId,
                stake: this._resolveBootstrapStake()
            };

            const configurationPlayers = this._buildConfigurationPlayers(room);

            this._logBootstrap("Generating configuration...");

            let configuration = this._bootstrap.configurationEngine
                .buildConfiguration(
                    game.gameId,
                    configurationRoom,
                    configurationPlayers
                );

            this._bootstrap.configurationEngine.validateConfiguration(
                configuration
            );

            configuration = this._bootstrap.configurationEngine
                .freezeConfiguration(configuration);

            this._logBootstrap("Configuration frozen");

            this._bootstrap.configurationEngine.commitConfiguration(
                configuration
            );

            this._logBootstrap("CONFIGURATION_READY");

            this._logBootstrap("Initializing GameState...");

            this._bootstrap.gameStateEngine.initializeGameState(game.gameId);

            this._logBootstrap("Registering players...");

            this._bootstrap.inputAuthority.registerPlayers(
                game.gameId,
                room.players
            );

            this._logBootstrap("Creating physics simulation...");

            this._bootstrap.physicsEngine.createSimulation(game.gameId);

            this._logBootstrap("Starting physics simulation...");

            this._bootstrap.physicsEngine.startSimulation(game.gameId);

            this._logBootstrap("Starting GameClock...");

            this._bootstrap.gameClockEngine.createClock(game.gameId);

            this._bootstrap.gameClockEngine.startClock(game.gameId);

            this.initializeGame(game.gameId);

            this._logBootstrap("GAME_INITIALIZED");

        } catch (error) {

            if (error instanceof ConfigurationValidationError) {

                this._logger.error(
                    [
                        "Gameplay bootstrap failed",
                        `roomId=${roomId}`,
                        `reason=${error.reason}`
                    ].join(" | ")
                );

                return;

            }

            this._logger.error(
                `Gameplay bootstrap failed: ${error.message}`
            );

        }

    }

    _resolveBootstrapStake() {

        const stakes = this._bootstrap.gameCatalog.getStakes();

        return stakes[0] ?? 1;

    }

    _buildConfigurationPlayers(room) {

        const sectorCount = 2;

        return room.players.map((playerId) => ({
            playerId,
            sectorCount
        }));

    }

    _logBootstrap(message) {

        if (!this._bootstrap?.devMode) {

            return;

        }

        this._logger.info(`[GameplayBootstrap] ${message}`);

    }

}
