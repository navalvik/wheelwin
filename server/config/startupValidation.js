import { LifecycleError } from "../errors/LifecycleError.js";

const REQUIRED_CATALOG_ACCESSORS = [
    "getColors",
    "getIcons",
    "getStakes",
    "getTimers",
    "getWheelRules",
    "getInputRules",
    "getWinnerRules",
    "getCatalogVersion"
];

export function validateEnvironmentVariables({
    serverConfig,
    roomConfig
}) {

    const errors = [];

    if (!Number.isFinite(serverConfig.port) || serverConfig.port <= 0) {

        errors.push("PORT must be a positive number");

    }

    if (!serverConfig.host) {

        errors.push("HOST is required");

    }

    if (!serverConfig.clientOrigin
        || (Array.isArray(serverConfig.clientOrigin)
            && serverConfig.clientOrigin.length === 0)) {

        errors.push("CLIENT_ORIGIN is required");

    }

    if (!Number.isInteger(roomConfig.maxPlayers) || roomConfig.maxPlayers <= 0) {

        errors.push("ROOM_MAX_PLAYERS must be a positive integer");

    }

    if (roomConfig.maxConcurrentRooms !== undefined
        && (!Number.isInteger(roomConfig.maxConcurrentRooms)
            || roomConfig.maxConcurrentRooms <= 0)) {

        errors.push("ROOM_MAX_CONCURRENT must be a positive integer");

    }

    if (errors.length > 0) {

        throw new LifecycleError({
            phase: "startup",
            component: "Environment",
            reason: errors.join("; ")
        });

    }

}

export function validateCatalogConsistency(gameCatalog) {

    if (!gameCatalog) {

        throw new LifecycleError({
            phase: "startup",
            component: "GameCatalog",
            reason: "Game catalog is not initialized"
        });

    }

    for (const accessor of REQUIRED_CATALOG_ACCESSORS) {

        if (typeof gameCatalog[accessor] !== "function") {

            throw new LifecycleError({
                phase: "startup",
                component: "GameCatalog",
                reason: `Missing catalog accessor (${accessor})`
            });

        }

    }

    const colors = gameCatalog.getColors();

    const icons = gameCatalog.getIcons();

    const stakes = gameCatalog.getStakes();

    const timers = gameCatalog.getTimers();

    const wheelRules = gameCatalog.getWheelRules();

    if (!Array.isArray(colors) || colors.length === 0) {

        throw new LifecycleError({
            phase: "startup",
            component: "GameCatalog",
            reason: "Colors catalog is empty"
        });

    }

    if (!Array.isArray(icons) || icons.length === 0) {

        throw new LifecycleError({
            phase: "startup",
            component: "GameCatalog",
            reason: "Icons catalog is empty"
        });

    }

    if (!Array.isArray(stakes) || stakes.length === 0) {

        throw new LifecycleError({
            phase: "startup",
            component: "GameCatalog",
            reason: "Stakes catalog is empty"
        });

    }

    if (!timers || Object.keys(timers).length === 0) {

        throw new LifecycleError({
            phase: "startup",
            component: "GameCatalog",
            reason: "Timers catalog is empty"
        });

    }

    if (!wheelRules?.minSectors || !wheelRules?.maxSectors) {

        throw new LifecycleError({
            phase: "startup",
            component: "GameCatalog",
            reason: "Wheel rules are invalid"
        });

    }

}

export function validateEngineDependencies(dependencies) {

    const required = [
        ["logger", "LoggerService"],
        ["eventBus", "EventBus"],
        ["gameCatalog", "GameCatalog"],
        ["configurationEngine", "ConfigurationEngine"],
        ["gameStateEngine", "GameStateEngine"],
        ["gameClockEngine", "GameClockEngine"],
        ["physicsEngine", "PhysicsEngine"],
        ["winnerEngine", "WinnerEngine"],
        ["inputAuthority", "InputAuthority"],
        ["recoveryEngine", "RecoveryEngine"],
        ["auditEngine", "AuditEngine"]
    ];

    const missing = [];

    for (const [key, label] of required) {

        if (!dependencies[key]) {

            missing.push(label);

        }

    }

    if (missing.length > 0) {

        throw new LifecycleError({
            phase: "startup",
            component: "Dependencies",
            reason: `Missing engine dependencies: ${missing.join(", ")}`
        });

    }

}

export function validateStartupConfiguration({
    serverConfig,
    roomConfig,
    gameCatalog
}) {

    validateEnvironmentVariables({ serverConfig, roomConfig });

    if (gameCatalog) {

        validateCatalogConsistency(gameCatalog);

    }

}
