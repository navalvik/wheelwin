/**
 * Dual-network TON service registry for room/payment blockchain I/O.
 *
 * Keeps the process-global TonService untouched while providing one independent
 * TonService instance per authoritative payment network.
 */

import { TonService } from "./TonService.js";
import { resolveActiveTonProfile } from "../config/tonNetworkProfiles.js";

const SUPPORTED_NETWORKS = Object.freeze(["testnet", "mainnet"]);

export class TonNetworkRegistryError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "TonNetworkRegistryError";
        this.details = Object.freeze({ ...details });
    }
}

export function assertRegistryNetwork(network) {
    const normalized = String(network ?? "").trim().toLowerCase();
    if (!SUPPORTED_NETWORKS.includes(normalized)) {
        throw new TonNetworkRegistryError(
            `Unsupported TON payment network: ${JSON.stringify(network)}`,
            { network: network ?? null, supported: SUPPORTED_NETWORKS }
        );
    }
    return normalized;
}

export function buildTonServiceConfigForNetwork(network, env = process.env) {
    const normalized = assertRegistryNetwork(network);
    const profile = resolveActiveTonProfile(normalized, env);

    const pollIntervalMs = env.TON_POLL_INTERVAL_MS === undefined
        ? 2000
        : Number(env.TON_POLL_INTERVAL_MS);

    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 200) {
        throw new TonNetworkRegistryError(
            "Invalid TON_POLL_INTERVAL_MS environment variable",
            { network: normalized }
        );
    }

    const deployMode = String(env.TON_DEPLOY_MODE || "stub").trim().toLowerCase();

    return Object.freeze({
        network: normalized,
        apiKey: env.TON_API_KEY || null,
        endpoint: profile.endpoint,
        deployerMnemonic: typeof env.TON_DEPLOYER_MNEMONIC === "string"
            && env.TON_DEPLOYER_MNEMONIC.trim()
            ? env.TON_DEPLOYER_MNEMONIC.trim()
            : null,
        deployerExpectedAddress: profile.deployerExpectedAddress,
        expectedWalletAddress: profile.expectedWalletAddress ?? null,
        oracleAddress: profile.oracleWallet,
        oracleSource: profile.oracleSource ?? null,
        artifactSha256Expected: profile.artifactSha256,
        grmJettonMaster: typeof env.TON_GRM_JETTON_MASTER === "string"
            && env.TON_GRM_JETTON_MASTER.trim()
            ? env.TON_GRM_JETTON_MASTER.trim()
            : null,
        pollIntervalMs,
        deployMode: deployMode === "live" ? "live" : "stub",
        gameEscrowMode: profile.gameEscrowMode,
        escrowMode: profile.escrowMode ?? profile.gameEscrowMode
    });
}

function defaultCreateService({ tonConfig, logger }) {
    const service = new TonService({ logger, tonConfig });
    service.initialize();
    return service;
}

export class TonNetworkServiceRegistry {
    constructor({ env = process.env, logger = null, createService = null } = {}) {
        this._env = env;
        this._logger = logger;
        this._createService = typeof createService === "function"
            ? createService
            : defaultCreateService;
        this._services = new Map();
        this._configs = new Map();
    }

    get(network) {
        const normalized = assertRegistryNetwork(network);
        let service = this._services.get(normalized);

        if (!service) {
            const tonConfig = buildTonServiceConfigForNetwork(normalized, this._env);
            service = this._createService({
                network: normalized,
                tonConfig,
                logger: this._logger
            });

            if (!service) {
                throw new TonNetworkRegistryError(
                    `TON service factory returned no service for network "${normalized}"`,
                    { network: normalized }
                );
            }

            this._services.set(normalized, service);
            this._configs.set(normalized, tonConfig);

            this._logger?.info?.(
                `TonNetworkServiceRegistry: initialized | network=${normalized} | endpoint=${tonConfig.endpoint}`
            );
        }

        return service;
    }

    getConfig(network) {
        const normalized = assertRegistryNetwork(network);
        if (!this._configs.has(normalized)) {
            this.get(normalized);
        }
        return this._configs.get(normalized);
    }

    resolve(network, fallbackService = null) {
        if (network == null || String(network).trim() === "") {
            return fallbackService;
        }
        return this.get(network);
    }

    has(network) {
        return this._services.has(String(network ?? "").trim().toLowerCase());
    }

    listNetworks() {
        return Object.freeze([...this._services.keys()]);
    }

    snapshot() {
        return Object.freeze({
            networks: this.listNetworks(),
            supported: SUPPORTED_NETWORKS
        });
    }
}
