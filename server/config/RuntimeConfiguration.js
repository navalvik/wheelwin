/**
 * R7.0C — Immutable runtime configuration snapshot.
 *
 * After construction the object graph is frozen. Components may read values
 * but must never mutate configuration. Secrets are present for services that
 * need them but are excluded from toSafeSummary().
 */

import { CONFIGURATION_CATEGORIES } from "./schemas/environmentSchema.js";
import { redactSecretsFromObject } from "./secrets.js";

function deepFreeze(value) {

    if (!value || typeof value !== "object" || Object.isFrozen(value)) {

        return value;

    }

    for (const child of Object.values(value)) {

        deepFreeze(child);

    }

    return Object.freeze(value);

}

export class RuntimeConfiguration {

    /**
     * @param {{
     *   profile: string,
     *   server: object,
     *   production: object,
     *   rooms: object,
     *   ton: object,
     *   socket: object,
     *   eventBus: object,
     *   gameplayPhases: object,
     *   owner: object,
     *   developer: object,
     *   validatedCategories: string[],
     *   version?: string
     * }} input
     */
    constructor(input) {

        this.profile = input.profile;

        this.server = input.server;

        this.production = input.production;

        this.rooms = input.rooms;

        this.ton = input.ton;

        this.socket = input.socket;

        this.eventBus = input.eventBus;

        this.gameplayPhases = input.gameplayPhases;

        this.owner = input.owner;

        this.developer = input.developer;

        this.validatedCategories = Object.freeze([...(input.validatedCategories ?? [])]);

        this.version = input.version ?? "unknown";

        this.loadedAt = Date.now();

        deepFreeze(this);

    }

    /**
     * Safe projection for logs, health, and Developer Console.
     * Never includes secrets, wallets, mnemonics, or password hashes.
     */
    toSafeSummary() {

        return Object.freeze({
            profile: this.profile,
            environment: this.server.nodeEnv,
            version: this.version,
            categories: this.validatedCategories,
            features: Object.freeze({
                metricsEnabled: this.production.metricsEnabled === true,
                developerAuthEnabled: this.developer.enabled === true,
                developerAuthConfigured: this.developer.configured === true,
                startupDemonstrations:
                    this.production.runStartupDemonstrations === true,
                debugSimulationLoop:
                    this.production.debugSimulationLoop === true,
                tonDeployMode: this.ton.deployMode,
                eventBusLogging: this.eventBus.logEvents === true
            }),
            server: Object.freeze({
                port: this.server.port,
                host: this.server.host,
                clientOrigin: this.server.clientOrigin,
                nodeEnv: this.server.nodeEnv
            }),
            lifecycle: Object.freeze({
                gracefulShutdownTimeoutMs:
                    this.production.gracefulShutdownTimeoutMs
            }),
            logging: Object.freeze({
                logLevel: this.production.logLevel
            }),
            rooms: Object.freeze({
                maxPlayers: this.rooms.maxPlayers,
                maxConcurrentRooms: this.rooms.maxConcurrentRooms
            }),
            ton: Object.freeze({
                network: this.ton.network,
                deployMode: this.ton.deployMode,
                pollIntervalMs: this.ton.pollIntervalMs,
                endpointConfigured: Boolean(this.ton.endpoint),
                apiKeyConfigured: Boolean(this.ton.apiKey),
                mnemonicConfigured: Boolean(this.ton.deployerMnemonic)
            }),
            developerConsole: Object.freeze({
                authEnabled: this.developer.enabled === true,
                authConfigured: this.developer.configured === true,
                environmentLabel: this.developer.environment,
                accessTokenTtlSeconds: this.developer.accessTokenTtlSeconds,
                refreshTokenTtlSeconds: this.developer.refreshTokenTtlSeconds
            }),
            owner: Object.freeze({
                loaded: this.owner.loaded === true,
                configPathSet: Boolean(this.owner.configPath)
            }),
            payments: Object.freeze({
                ownerConfigured: this.owner.loaded === true
            }),
            metrics: Object.freeze({
                enabled: this.production.metricsEnabled === true
            })
        });

    }

    /**
     * Debug helper — still redacts secrets if somehow serialized.
     */
    toRedactedObject() {

        return Object.freeze(redactSecretsFromObject({
            profile: this.profile,
            server: this.server,
            production: this.production,
            rooms: this.rooms,
            ton: this.ton,
            owner: {
                loaded: this.owner.loaded,
                configPath: this.owner.configPath
            },
            developer: {
                enabled: this.developer.enabled,
                configured: this.developer.configured,
                username: this.developer.username,
                environment: this.developer.environment
            },
            validatedCategories: this.validatedCategories
        }));

    }

}

export { CONFIGURATION_CATEGORIES };
