import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { resolvePlayerSetupColors } from "./configuration/colorCatalog.js";
import { ConfigurationValidationError } from "./configuration/ConfigurationValidationError.js";
import { deepFreezeConfiguration } from "./configuration/configurationFreeze.js";
import { CONFIGURATION_VERSION } from "./configuration/ConfigurationVersion.js";
import {
    generateWheelLayout,
    validateWheelLayout
} from "./configuration/wheelLayoutGenerator.js";

export class ConfigurationEngine {

    constructor({
        logger,
        eventBus,
        gameCatalog,
        randomService
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameCatalog = gameCatalog;

        this._randomService = randomService;

        this._configurations = new Map();

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

        for (const gameId of [...this._configurations.keys()]) {

            this.removeConfiguration(gameId);

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

    generateConfiguration(gameId, room, players) {

        this._assertInitialized();

        if (this._configurations.has(gameId)) {

            throw new ConfigurationValidationError({
                gameId,
                reason: "Configuration already exists for game"
            });

        }

        let configuration = null;

        let traceSeed = null;

        try {

            configuration = this.buildConfiguration(gameId, room, players);

            traceSeed = configuration.traceSeed;

            this.validateConfiguration(configuration);

            this._logger.info("Configuration Validated");

            configuration = this.freezeConfiguration(configuration);

            this._logger.info("Configuration Frozen");

            return this.commitConfiguration(configuration);

        } catch (error) {

            if (error instanceof ConfigurationValidationError) {

                this._logger.error(
                    [
                        "Configuration rejected",
                        `gameId=${error.gameId}`,
                        `traceSeed=${error.traceSeed ?? traceSeed ?? "none"}`,
                        `reason=${error.reason}`
                    ].join(" | ")
                );

                throw error;

            }

            throw new ConfigurationValidationError({
                gameId,
                reason: error.message,
                traceSeed
            });

        }

    }

    buildConfiguration(gameId, room, players) {

        this._assertInitialized();

        this._validateGenerationInput(gameId, room, players);

        const traceSeed = this._randomService.generateTraceSeed();

        const catalogColors = this._gameCatalog.getColors();

        const catalogIcons = this._gameCatalog.getIcons();

        const catalogTimers = this._gameCatalog.getTimers();

        const wheelRules = this._gameCatalog.getWheelRules();

        const iconIds = this._randomService.shuffle(
            catalogIcons.map((icon) => icon.id)
        );

        const resolvedPlayers = players.map((player, index) => {

            const colors = resolvePlayerSetupColors(
                player.colors,
                catalogColors
            );

            if (colors.length !== player.sectorCount) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: `Player ${player.playerId} color count does not match sectorCount`,
                    traceSeed
                });

            }

            return {
                playerId: player.playerId,
                nickname: player.nickname ?? null,
                icon: iconIds[index],
                sectorCount: player.sectorCount,
                sectorArrangement: player.sectorCount === 2
                    ? (player.sectorArrangement === "separate" ? "separate" : "together")
                    : null,
                colors
            };

        });

        const layout = generateWheelLayout({
            players: resolvedPlayers,
            randomService: this._randomService
        });

        validateWheelLayout({
            sectors: layout.sectors,
            players: resolvedPlayers,
            minSectors: wheelRules.minSectors,
            maxSectors: wheelRules.maxSectors
        });

        const playerConfigurations = resolvedPlayers.map((player) => ({

            playerId: player.playerId,

            nickname: player.nickname,

            color: player.colors[0].id,

            colors: player.colors.map((entry) => entry.id),

            icon: player.icon,

            sectorCount: player.sectorCount,

            sectorArrangement: player.sectorArrangement

        }));

        const configuration = {
            gameId,
            configurationVersion: CONFIGURATION_VERSION,
            createdAt: Date.now(),
            traceSeed,
            sectors: layout.sectors,
            players: playerConfigurations,
            wheel: {
                startAngle: this._randomService.nextInt(0, 359),
                minSectors: wheelRules.minSectors,
                maxSectors: wheelRules.maxSectors,
                sectorCount: layout.sectors.length,
                playerOrder: layout.playerOrder
            },
            triangle: {
                startAngle: this._randomService.nextInt(0, 359),
                ratio: {
                    height: wheelRules.defaultTriangleRatio.height,
                    width: wheelRules.defaultTriangleRatio.width
                }
            },
            timers: this._copyTimers(catalogTimers),
            stake: room.stake,
            metadata: {
                roomId: room.roomId,
                catalogVersion: this._gameCatalog.getCatalogVersion()
            }
        };

        this._logger.info("Configuration Generated");

        return configuration;

    }

    validateConfiguration(configuration) {

        const gameId = configuration?.gameId ?? null;

        const traceSeed = configuration?.traceSeed ?? null;

        if (!configuration || typeof configuration !== "object") {

            throw new ConfigurationValidationError({
                gameId,
                reason: "Configuration must be an object",
                traceSeed
            });

        }

        this._requireField(configuration, "gameId", gameId, traceSeed);

        this._requireField(
            configuration,
            "configurationVersion",
            gameId,
            traceSeed
        );

        this._requireField(configuration, "createdAt", gameId, traceSeed);

        this._requireField(configuration, "traceSeed", gameId, traceSeed);

        this._requireArray(configuration.players, "players", gameId, traceSeed);

        this._requireArray(configuration.sectors, "sectors", gameId, traceSeed);

        if (!configuration.wheel || typeof configuration.wheel !== "object") {

            throw new ConfigurationValidationError({
                gameId,
                reason: "Wheel configuration is required",
                traceSeed
            });

        }

        if (!configuration.triangle || typeof configuration.triangle !== "object") {

            throw new ConfigurationValidationError({
                gameId,
                reason: "Triangle configuration is required",
                traceSeed
            });

        }

        if (!configuration.timers || typeof configuration.timers !== "object") {

            throw new ConfigurationValidationError({
                gameId,
                reason: "Timer configuration is required",
                traceSeed
            });

        }

        const allowedStakes = this._gameCatalog.getStakes();

        if (!allowedStakes.includes(configuration.stake)) {

            throw new ConfigurationValidationError({
                gameId,
                reason: "Stake is not allowed by catalog",
                traceSeed
            });

        }

        const wheelRules = this._gameCatalog.getWheelRules();

        const allowedColors = new Set(
            this._gameCatalog.getColors().map((color) => color.id)
        );

        const allowedIcons = new Set(
            this._gameCatalog.getIcons().map((icon) => icon.id)
        );

        const playerIcons = new Set();

        let expectedSectorTotal = 0;

        const playersById = new Map();

        for (const player of configuration.players) {

            this._requireField(player, "playerId", gameId, traceSeed);

            this._requireField(player, "color", gameId, traceSeed);

            this._requireField(player, "icon", gameId, traceSeed);

            this._requireField(player, "sectorCount", gameId, traceSeed);

            if (!Number.isInteger(player.sectorCount) || player.sectorCount <= 0) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: "Each player must have a positive sectorCount",
                    traceSeed
                });

            }

            if (!allowedColors.has(player.color)) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: `Player color is not in catalog (${player.color})`,
                    traceSeed
                });

            }

            if (!allowedIcons.has(player.icon)) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: `Player icon is not in catalog (${player.icon})`,
                    traceSeed
                });

            }

            if (playerIcons.has(player.icon)) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: "Player icons must be unique",
                    traceSeed
                });

            }

            playerIcons.add(player.icon);

            expectedSectorTotal += player.sectorCount;

            playersById.set(player.playerId, player);

        }

        if (configuration.sectors.length !== expectedSectorTotal) {

            throw new ConfigurationValidationError({
                gameId,
                reason: "Sector count does not match player selections",
                traceSeed
            });

        }

        if (configuration.sectors.length < wheelRules.minSectors
            || configuration.sectors.length > wheelRules.maxSectors) {

            throw new ConfigurationValidationError({
                gameId,
                reason: "Sector count is outside catalog wheel limits",
                traceSeed
            });

        }

        const sectorIds = new Set();

        for (const sector of configuration.sectors) {

            this._requireField(sector, "sectorId", gameId, traceSeed);

            this._requireField(sector, "ownerId", gameId, traceSeed);

            this._requireField(sector, "color", gameId, traceSeed);

            this._requireField(sector, "icon", gameId, traceSeed);

            this._requireField(sector, "sectorIndexForPlayer", gameId, traceSeed);

            this._requireField(sector, "angleStart", gameId, traceSeed);

            this._requireField(sector, "angleEnd", gameId, traceSeed);

            if (sectorIds.has(sector.sectorId)) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: `Duplicate sectorId (${sector.sectorId})`,
                    traceSeed
                });

            }

            sectorIds.add(sector.sectorId);

            const owner = playersById.get(sector.ownerId);

            if (!owner) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: `Sector owner not found (${sector.ownerId})`,
                    traceSeed
                });

            }

            if (!allowedIcons.has(sector.icon)) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: `Sector icon is not in catalog (${sector.icon})`,
                    traceSeed
                });

            }

            if (sector.icon !== owner.icon) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: "Sector icon must match owner configuration",
                    traceSeed
                });

            }

        }

        const resolvedPlayers = configuration.players.map((player) => {

            const catalogColors = this._gameCatalog.getColors();

            const colorLabels = Array.isArray(player.colors)
                ? player.colors.map((colorId) => {

                    const entry = catalogColors.find((color) => color.id === colorId);

                    return {
                        id: colorId,
                        hex: entry?.hex ?? null
                    };

                })
                : [{
                    id: player.color,
                    hex: catalogColors.find((color) => color.id === player.color)?.hex ?? null
                }];

            return {
                playerId: player.playerId,
                sectorCount: player.sectorCount,
                sectorArrangement: player.sectorArrangement,
                colors: colorLabels.filter((entry) => entry.hex)
            };

        });

        try {

            validateWheelLayout({
                sectors: configuration.sectors,
                players: resolvedPlayers,
                minSectors: wheelRules.minSectors,
                maxSectors: wheelRules.maxSectors
            });

        } catch (error) {

            throw new ConfigurationValidationError({
                gameId,
                reason: error.message,
                traceSeed
            });

        }

        if (!Number.isFinite(configuration.wheel.startAngle)) {

            throw new ConfigurationValidationError({
                gameId,
                reason: "Wheel startAngle is required",
                traceSeed
            });

        }

        if (!Number.isFinite(configuration.triangle.startAngle)) {

            throw new ConfigurationValidationError({
                gameId,
                reason: "Triangle startAngle is required",
                traceSeed
            });

        }

        const catalogTimerKeys = Object.keys(this._gameCatalog.getTimers());

        for (const timerKey of catalogTimerKeys) {

            if (!configuration.timers[timerKey]) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: `Missing timer definition (${timerKey})`,
                    traceSeed
                });

            }

        }

        return true;

    }

    freezeConfiguration(configuration) {

        return deepFreezeConfiguration(configuration);

    }

    commitConfiguration(configuration) {

        this._assertInitialized();

        if (!configuration?.gameId) {

            throw new ConfigurationValidationError({
                gameId: null,
                reason: "Configuration gameId is required"
            });

        }

        if (this._configurations.has(configuration.gameId)) {

            throw new ConfigurationValidationError({
                gameId: configuration.gameId,
                reason: "Configuration already exists for game"
            });

        }

        this._configurations.set(configuration.gameId, configuration);

        this._logger.info("Configuration Ready");

        this._emit(EVENT_TYPES.CONFIGURATION_READY, {
            gameId: configuration.gameId,
            configurationVersion: configuration.configurationVersion,
            traceSeed: configuration.traceSeed,
            sectorCount: configuration.sectors.length,
            playerCount: configuration.players.length
        });

        return configuration;

    }

    getConfiguration(gameId) {

        return this._configurations.get(gameId) ?? null;

    }

    removeConfiguration(gameId) {

        const configuration = this._configurations.get(gameId);

        if (!configuration) {

            this._logger.error(
                `Configuration removal failed: not found (${gameId})`
            );

            return false;

        }

        this._configurations.delete(gameId);

        this._emit(EVENT_TYPES.CONFIGURATION_REMOVED, {
            gameId,
            traceSeed: configuration.traceSeed
        });

        return true;

    }

    getDebugSnapshot(gameId) {

        const configuration = this._configurations.get(gameId);

        if (!configuration) {

            return null;

        }

        return {
            gameId: configuration.gameId,
            configurationVersion: configuration.configurationVersion,
            playerCount: configuration.players.length,
            sectorCount: configuration.sectors.length,
            colors: configuration.players.map((player) => player.color),
            icons: configuration.players.map((player) => player.icon),
            wheel: configuration.wheel,
            triangle: configuration.triangle,
            traceSeed: configuration.traceSeed
        };

    }

    listConfigurationIds() {

        return [...this._configurations.keys()];

    }

    _validateGenerationInput(gameId, room, players) {

        if (!gameId) {

            throw new ConfigurationValidationError({
                gameId: null,
                reason: "gameId is required"
            });

        }

        if (!room?.roomId) {

            throw new ConfigurationValidationError({
                gameId,
                reason: "room.roomId is required"
            });

        }

        if (!this._gameCatalog.getStakes().includes(room.stake)) {

            throw new ConfigurationValidationError({
                gameId,
                reason: "room.stake is not allowed by catalog"
            });

        }

        if (!Array.isArray(players) || players.length === 0) {

            throw new ConfigurationValidationError({
                gameId,
                reason: "players must be a non-empty array"
            });

        }

        if (players.length > this._gameCatalog.getColors().length
            || players.length > this._gameCatalog.getIcons().length) {

            throw new ConfigurationValidationError({
                gameId,
                reason: "Not enough catalog colors or icons for players"
            });

        }

        const playerIds = new Set();

        for (const player of players) {

            if (!player?.playerId) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: "Each player must include playerId"
                });

            }

            if (playerIds.has(player.playerId)) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: `Duplicate playerId (${player.playerId})`
                });

            }

            playerIds.add(player.playerId);

            if (!Number.isInteger(player.sectorCount) || player.sectorCount <= 0) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: "Each player must include a positive sectorCount"
                });

            }

            if (!Array.isArray(player.colors) || player.colors.length !== player.sectorCount) {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: "Each player must include colors matching sectorCount"
                });

            }

            for (const colorLabel of player.colors) {

                if (typeof colorLabel !== "string" || !colorLabel.trim()) {

                    throw new ConfigurationValidationError({
                        gameId,
                        reason: "Each player color must be a non-empty string"
                    });

                }

            }

            if (player.sectorCount === 2
                && player.sectorArrangement !== "together"
                && player.sectorArrangement !== "separate") {

                throw new ConfigurationValidationError({
                    gameId,
                    reason: "Two-sector players must include together or separate arrangement"
                });

            }

        }

        const totalSectors = players.reduce(
            (sum, player) => sum + player.sectorCount,
            0
        );

        const wheelRules = this._gameCatalog.getWheelRules();

        if (totalSectors < wheelRules.minSectors
            || totalSectors > wheelRules.maxSectors) {

            throw new ConfigurationValidationError({
                gameId,
                reason: "Total sector count is outside catalog wheel limits"
            });

        }

    }

    _copyTimers(catalogTimers) {

        const timers = {};

        for (const [key, value] of Object.entries(catalogTimers)) {

            timers[key] = {
                phase: value.phase,
                durationMs: value.durationMs
            };

        }

        return timers;

    }

    _requireField(object, fieldName, gameId, traceSeed) {

        if (object[fieldName] === undefined || object[fieldName] === null) {

            throw new ConfigurationValidationError({
                gameId,
                reason: `Missing required field (${fieldName})`,
                traceSeed
            });

        }

    }

    _requireArray(value, label, gameId, traceSeed) {

        if (!Array.isArray(value) || value.length === 0) {

            throw new ConfigurationValidationError({
                gameId,
                reason: `${label} must be a non-empty array`,
                traceSeed
            });

        }

    }

    _handleServerShutdown() {

        for (const gameId of [...this._configurations.keys()]) {

            this.removeConfiguration(gameId);

        }

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.CONFIGURATION_ENGINE,
            type,
            payload
        });

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("ConfigurationEngine is not initialized");

        }

    }

}
