/**
 * R17.9H — Read-only TON wallet balance monitor for Developer Console.
 *
 * Observability only: never signs, never stores mnemonics/private keys.
 */

import { fromNano } from "@ton/core";

import { OwnerConfiguration } from "../../config/OwnerConfiguration.js";
import { loadMainnetTonProfile } from "../../config/tonNetworkProfiles.js";
import { describeTonWalletIdentity } from "../../models/TonWalletAddress.js";
import { deriveDeployerWalletIdentity } from "../../payment/ton/deriveDeployerWalletIdentity.js";
import {
    deriveResiduesWalletIdentity,
    resolveResiduesMnemonic,
    resolveResiduesWalletDestination
} from "../../payment/roomWallet/ResiduesWalletConfig.js";

export const WALLET_BALANCE_TYPES = Object.freeze({
    OWNER_WALLET: "OWNER_WALLET",
    DEPLOYMENT_WALLET: "DEPLOYMENT_WALLET",
    RESIDUES_WALLET: "RESIDUES_WALLET",
    // Historical aliases — same role strings, not a second wallet.
    DEPLOY_WALLET: "DEPLOYMENT_WALLET",
    REIMBURSEMENT_WALLET: "RESIDUES_WALLET"
});

export const WALLET_BALANCE_STATUS = Object.freeze({
    OK: "OK",
    NOT_CONFIGURED: "NOT_CONFIGURED",
    RPC_ERROR: "RPC_ERROR",
    UNAVAILABLE: "UNAVAILABLE"
});

export const DEFAULT_WALLET_BALANCE_REFRESH_MS = 30_000;

/**
 * r18-s104 — Explicit wallet monitoring network profiles.
 *
 * APPLICATION = the network this service is bound to (runtimeConfig.ton.network).
 * MAINNET     = an independent read-only profile resolved from mainnet-only
 *               public address pins. It never inherits or falls back to the
 *               application-network configuration.
 */
export const WALLET_PROFILE_SOURCES = Object.freeze({
    APPLICATION: "APPLICATION",
    MAINNET: "MAINNET_PINS"
});

export const WALLET_MONITORING_NETWORKS = Object.freeze(["testnet", "mainnet"]);

const MAINNET_ONLY_ENV_KEYS = Object.freeze({
    OWNER_WALLET: "TON_MAINNET_OWNER_WALLET",
    RESIDUES_WALLET: "TON_MAINNET_RESIDUES_EXPECTED_ADDRESS"
});

const MONITORED_WALLET_TYPES = Object.freeze([
    WALLET_BALANCE_TYPES.OWNER_WALLET,
    WALLET_BALANCE_TYPES.DEPLOYMENT_WALLET,
    WALLET_BALANCE_TYPES.RESIDUES_WALLET
]);

/**
 * @param {unknown} address
 * @param {string|null} network
 * @returns {{ address: string|null, network: string|null, accountId: string|null }}
 */
function operatorIdentity(address, network) {

    return describeTonWalletIdentity(address, network);

}

/**
 * @param {bigint|null|undefined} nano
 * @returns {string|null}
 */
function balanceTonFromNano(nano) {

    if (typeof nano !== "bigint") {

        return null;

    }

    try {

        return fromNano(nano);

    } catch {

        return null;

    }

}

/**
 * @param {object} entry
 * @returns {object}
 */
function freezeWalletEntry(entry) {

    return Object.freeze({
        walletType: entry.walletType,
        address: entry.address ?? null,
        network: entry.network ?? null,
        accountId: entry.accountId ?? null,
        balance: entry.balance ?? null,
        unit: "TON",
        status: entry.status,
        lastUpdated: entry.lastUpdated ?? null,
        lastSuccessfulUpdate: entry.lastSuccessfulUpdate ?? null,
        error: entry.error ?? null
    });

}

export class WalletBalanceMonitor {

    /**
     * @param {{
     *   logger?: { info?: Function, warn?: Function, error?: Function }|null,
     *   tonService?: { getBalance?: Function, isConnected?: Function }|null,
     *   runtimeConfig?: { ton?: object }|null,
     *   env?: NodeJS.ProcessEnv,
     *   refreshIntervalMs?: number,
     *   setIntervalFn?: typeof setInterval,
     *   clearIntervalFn?: typeof clearInterval,
     *   nowFn?: () => number
     * }} [options]
     */
    constructor({
        logger = null,
        tonService = null,
        mainnetTonService = null,
        runtimeConfig = null,
        env = process.env,
        refreshIntervalMs = DEFAULT_WALLET_BALANCE_REFRESH_MS,
        setIntervalFn = setInterval,
        clearIntervalFn = clearInterval,
        nowFn = () => Date.now()
    } = {}) {

        this._logger = logger;
        this._tonService = tonService;
        this._mainnetTonService = mainnetTonService;
        this._runtimeConfig = runtimeConfig;
        this._env = env;
        this._refreshIntervalMs = Number.isFinite(refreshIntervalMs)
            && refreshIntervalMs > 0
            ? refreshIntervalMs
            : DEFAULT_WALLET_BALANCE_REFRESH_MS;
        this._setIntervalFn = setIntervalFn;
        this._clearIntervalFn = clearIntervalFn;
        this._nowFn = nowFn;

        this._timer = null;
        this._running = false;
        this._initialized = false;
        this._refreshInFlight = null;
        this._addressCache = Object.freeze({
            [WALLET_BALANCE_TYPES.OWNER_WALLET]: null,
            [WALLET_BALANCE_TYPES.DEPLOYMENT_WALLET]: null,
            [WALLET_BALANCE_TYPES.RESIDUES_WALLET]: null
        });

        this._mainnetAddressCache = Object.freeze({
            [WALLET_BALANCE_TYPES.OWNER_WALLET]: null,
            [WALLET_BALANCE_TYPES.DEPLOYMENT_WALLET]: null,
            [WALLET_BALANCE_TYPES.RESIDUES_WALLET]: null
        });

        this._wallets = new Map(
            MONITORED_WALLET_TYPES.map((walletType) => [
                walletType,
                freezeWalletEntry({
                    walletType,
                    status: WALLET_BALANCE_STATUS.UNAVAILABLE
                })
            ])
        );

        this._mainnetWallets = new Map(
            MONITORED_WALLET_TYPES.map((walletType) => [
                walletType,
                freezeWalletEntry({
                    walletType,
                    network: "mainnet",
                    status: WALLET_BALANCE_STATUS.UNAVAILABLE
                })
            ])
        );

    }

    /**
     * Late-bind ton service / config after bootstrap.
     */
    configure({
        tonService = undefined,
        runtimeConfig = undefined
    } = {}) {

        if (tonService !== undefined) {

            this._tonService = tonService;

        }

        if (runtimeConfig !== undefined) {

            this._runtimeConfig = runtimeConfig;

        }

    }

    async initialize() {

        if (this._initialized) {

            return this.getSnapshot();

        }

        await this._resolveAddresses();

        this._applyMainnetAddressCache();

        this._initialized = true;

        this._logger?.info?.(
            `WalletBalanceMonitor ready | intervalMs=${this._refreshIntervalMs}`
        );

        return this.getSnapshot();

    }

    start() {

        if (!this._initialized) {

            throw new Error("WalletBalanceMonitor is not initialized");

        }

        if (this._running) {

            return this.getSnapshot();

        }

        this._running = true;

        // Non-blocking initial refresh.
        void this.refresh();

        this._timer = this._setIntervalFn(() => {

            void this.refresh();

        }, this._refreshIntervalMs);

        this._logger?.info?.("WalletBalanceMonitor started");

        return this.getSnapshot();

    }

    stop() {

        if (this._timer != null) {

            this._clearIntervalFn(this._timer);

            this._timer = null;

        }

        this._running = false;

    }

    shutdown() {

        this.stop();

        this._initialized = false;

        this._logger?.info?.("WalletBalanceMonitor stopped");

    }

    isRunning() {

        return this._running === true;

    }

    /**
     * Cached snapshot for GET /console/wallets/balances.
     * Never includes secrets.
     *
     * r18-s104 — schemaVersion 2 adds explicit per-network profiles
     * (`networkProfiles`) while preserving the legacy application-network
     * fields (`network`, `wallets`) for backward compatibility.
     */
    getSnapshot() {

        const wallets = MONITORED_WALLET_TYPES.map((type) => this._wallets.get(type));
        const mainnetWallets = MONITORED_WALLET_TYPES.map((type) => this._mainnetWallets.get(type));
        const applicationNetwork = this._applicationNetwork();

        const applicationProfile = Object.freeze({
            network: applicationNetwork,
            source: WALLET_PROFILE_SOURCES.APPLICATION,
            enabled: true,
            wallets: Object.freeze(wallets)
        });

        const mainnetProfile = Object.freeze({
            network: "mainnet",
            source: WALLET_PROFILE_SOURCES.MAINNET,
            enabled: this._isMainnetMonitoringConfigured(),
            wallets: Object.freeze(mainnetWallets)
        });

        const networkProfiles = applicationNetwork === "mainnet"
            ? Object.freeze({ mainnet: applicationProfile })
            : Object.freeze({
                [applicationNetwork || "application"]: applicationProfile,
                mainnet: mainnetProfile
            });

        return Object.freeze({
            schemaVersion: 2,
            refreshIntervalMs: this._refreshIntervalMs,
            network: applicationNetwork,
            generatedAt: this._nowFn(),
            wallets: Object.freeze(wallets),
            applicationNetwork,
            networkProfiles
        });

    }

    /**
     * r18-s104 — The Mainnet profile is configured only when mainnet-only pins
     * (or an injected mainnet TonService) exist. No testnet inheritance.
     */
    _isMainnetMonitoringConfigured() {

        return Boolean(
            this._mainnetTonService
            || this._mainnetAddressCache[WALLET_BALANCE_TYPES.OWNER_WALLET]
            || this._mainnetAddressCache[WALLET_BALANCE_TYPES.DEPLOYMENT_WALLET]
            || this._mainnetAddressCache[WALLET_BALANCE_TYPES.RESIDUES_WALLET]
        );

    }

    /**
     * Refresh all wallet balances. Concurrent calls share one in-flight promise.
     */
    async refresh() {

        if (this._refreshInFlight) {

            return this._refreshInFlight;

        }

        this._refreshInFlight = this._refreshAll()
            .catch((error) => {

                this._logger?.warn?.(
                    `WalletBalanceMonitor refresh failed | ${error?.message ?? error}`
                );

                return this.getSnapshot();

            })
            .finally(() => {

                this._refreshInFlight = null;

            });

        return this._refreshInFlight;

    }

    _applicationNetwork() {

        const network = this._runtimeConfig?.ton?.network;

        if (network == null || String(network).trim() === "") {

            return null;

        }

        return String(network).trim().toLowerCase();

    }

    async _refreshAll() {

        await this._resolveAddresses();

        await Promise.all([
            Promise.all(
                MONITORED_WALLET_TYPES.map((type) => this._refreshOne(type))
            ),
            this._refreshMainnet()
        ]);

        return this.getSnapshot();

    }

    /**
     * r18-s104 — Independent MAINNET refresh.
     *
     * Reads ONLY mainnet-only public address pins and ONLY the injected
     * mainnet TonService. It never falls back to the application-network
     * service, addresses, or configuration. A Mainnet failure must not affect
     * the application-network entries and vice versa.
     */
    async _refreshMainnet() {

        this._applyMainnetAddressCache();

        await Promise.all(
            MONITORED_WALLET_TYPES.map((type) => this._refreshEntry(type, {
                wallets: this._mainnetWallets,
                address: this._mainnetAddressCache[type] ?? null,
                network: "mainnet",
                tonService: this._mainnetTonService,
                notConfiguredMessage: "Mainnet wallet address is not configured",
                serviceUnavailableMessage: "Mainnet TonService is unavailable"
            }))
        );

    }

    _applyMainnetAddressCache() {

        try {

            this._mainnetAddressCache = this._resolveMainnetAddressCache();

        } catch (error) {

            this._logger?.warn?.(
                `WalletBalanceMonitor mainnet address resolve failed | ${error?.message ?? error}`
            );

        }

    }

    _resolveMainnetAddressCache() {

        return Object.freeze({
            [WALLET_BALANCE_TYPES.OWNER_WALLET]: this._resolveMainnetOwnerAddress(),
            [WALLET_BALANCE_TYPES.DEPLOYMENT_WALLET]: this._resolveMainnetDeploymentAddress(),
            [WALLET_BALANCE_TYPES.RESIDUES_WALLET]: this._resolveMainnetResiduesAddress()
        });

    }

    /**
     * Mainnet Owner pin: TON_MAINNET_OWNER_WALLET only. OwnerConfiguration /
     * OWNER_WALLET belong to the application network and are never reused here.
     */
    _resolveMainnetOwnerAddress() {

        return operatorIdentity(
            this._env[MAINNET_ONLY_ENV_KEYS.OWNER_WALLET],
            "mainnet"
        ).address;

    }

    /**
     * Mainnet Deployment pin: TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS via the
     * existing mainnet network profile loader (no testnet/shared fallback).
     */
    _resolveMainnetDeploymentAddress() {

        const profile = loadMainnetTonProfile(this._env);

        return operatorIdentity(
            profile.deployerExpectedAddress,
            "mainnet"
        ).address;

    }

    /**
     * Mainnet Residues pin: TON_MAINNET_RESIDUES_EXPECTED_ADDRESS only. The
     * application-network Residues resolution (env aliases / mnemonic derive)
     * is never reused for Mainnet.
     */
    _resolveMainnetResiduesAddress() {

        return operatorIdentity(
            this._env[MAINNET_ONLY_ENV_KEYS.RESIDUES_WALLET],
            "mainnet"
        ).address;

    }

    async _resolveAddresses() {

        const owner = this._resolveOwnerAddress();
        const deploy = await this._resolveDeployAddress();
        const residues = await this._resolveResiduesAddress();

        this._addressCache = Object.freeze({
            [WALLET_BALANCE_TYPES.OWNER_WALLET]: owner,
            [WALLET_BALANCE_TYPES.DEPLOYMENT_WALLET]: deploy,
            [WALLET_BALANCE_TYPES.RESIDUES_WALLET]: residues
        });

    }

    _resolveOwnerAddress() {

        try {

            if (OwnerConfiguration.isLoaded()) {

                return operatorIdentity(
                    OwnerConfiguration.getOwnerWallet(),
                    this._applicationNetwork()
                ).address;

            }

        } catch {

            // fall through
        }

        return operatorIdentity(
            this._env.OWNER_WALLET,
            this._applicationNetwork()
        ).address;

    }

    async _resolveDeployAddress() {

        const expected = operatorIdentity(
            this._runtimeConfig?.ton?.deployerExpectedAddress,
            this._applicationNetwork()
        ).address;

        if (expected) {

            return expected;

        }

        const mnemonic = this._runtimeConfig?.ton?.deployerMnemonic;

        if (!mnemonic) {

            return null;

        }

        try {

            const identity = await deriveDeployerWalletIdentity({
                mnemonic,
                network: this._runtimeConfig?.ton?.network ?? null
            });

            return operatorIdentity(
                identity?.address,
                this._applicationNetwork()
            ).address;

        } catch (error) {

            this._logger?.warn?.(
                `WalletBalanceMonitor deploy address resolve failed | ${error?.message ?? error}`
            );

            return null;

        }

    }

    async _resolveResiduesAddress() {

        const destination = resolveResiduesWalletDestination(this._env);

        if (destination.ok) {

            return operatorIdentity(
                destination.address,
                this._applicationNetwork()
            ).address;

        }

        const resolved = resolveResiduesMnemonic(this._env);

        if (!resolved.mnemonic) {

            return null;

        }

        try {

            const identity = await deriveResiduesWalletIdentity(resolved.mnemonic);

            return operatorIdentity(
                identity?.address,
                this._applicationNetwork()
            ).address;

        } catch (error) {

            this._logger?.warn?.(
                `WalletBalanceMonitor residues address resolve failed | ${error?.message ?? error}`
            );

            return null;

        }

    }

    async _refreshOne(walletType) {

        await this._refreshEntry(walletType, {
            wallets: this._wallets,
            address: this._addressCache[walletType] ?? null,
            network: this._applicationNetwork(),
            tonService: this._tonService,
            notConfiguredMessage: "Wallet address is not configured",
            serviceUnavailableMessage: "TonService is unavailable"
        });

    }

    /**
     * r18-s104 — Network-profile-aware refresh entry. The context explicitly
     * binds ONE wallet map, ONE address, ONE network tag and ONE balance
     * service, so a profile can never query or inherit another network's data.
     */
    async _refreshEntry(walletType, context) {

        const previous = context.wallets.get(walletType);
        const identity = operatorIdentity(context.address, context.network);
        const nowIso = new Date(this._nowFn()).toISOString();

        if (!identity.address) {

            context.wallets.set(walletType, freezeWalletEntry({
                walletType,
                address: null,
                network: identity.network,
                accountId: null,
                balance: previous?.status === WALLET_BALANCE_STATUS.OK
                    ? previous.balance
                    : null,
                status: WALLET_BALANCE_STATUS.NOT_CONFIGURED,
                lastUpdated: nowIso,
                lastSuccessfulUpdate: previous?.lastSuccessfulUpdate ?? null,
                error: context.notConfiguredMessage
            }));

            return;

        }

        if (!context.tonService?.getBalance) {

            context.wallets.set(walletType, freezeWalletEntry({
                walletType,
                address: identity.address,
                network: identity.network,
                accountId: identity.accountId,
                balance: previous?.balance ?? null,
                status: WALLET_BALANCE_STATUS.UNAVAILABLE,
                lastUpdated: nowIso,
                lastSuccessfulUpdate: previous?.lastSuccessfulUpdate ?? null,
                error: context.serviceUnavailableMessage
            }));

            return;

        }

        try {

            const nano = await context.tonService.getBalance(identity.address);
            const balance = balanceTonFromNano(nano);

            context.wallets.set(walletType, freezeWalletEntry({
                walletType,
                address: identity.address,
                network: identity.network,
                accountId: identity.accountId,
                balance,
                status: WALLET_BALANCE_STATUS.OK,
                lastUpdated: nowIso,
                lastSuccessfulUpdate: nowIso,
                error: null
            }));

        } catch (error) {

            context.wallets.set(walletType, freezeWalletEntry({
                walletType,
                address: identity.address,
                network: identity.network,
                accountId: identity.accountId,
                // Keep previous successful balance on RPC failure.
                balance: previous?.lastSuccessfulUpdate
                    ? previous.balance
                    : (previous?.status === WALLET_BALANCE_STATUS.OK
                        ? previous.balance
                        : null),
                status: WALLET_BALANCE_STATUS.RPC_ERROR,
                lastUpdated: nowIso,
                lastSuccessfulUpdate: previous?.lastSuccessfulUpdate ?? null,
                error: error?.message ?? "RPC balance query failed"
            }));

        }

    }

}

/**
 * r18-s104 — Explicit, fallback-free network profile selection for the
 * /console/wallets/balances route. Returns null when the requested network
 * profile is absent; it never substitutes another network's data.
 *
 * @param {object|null} snapshot
 * @param {string|null} network
 * @returns {{ snapshot: object, profile: object }|null}
 */
export function selectWalletNetworkSnapshot(snapshot, network) {

    const normalized = typeof network === "string"
        ? network.trim().toLowerCase()
        : "";

    if (!WALLET_MONITORING_NETWORKS.includes(normalized)) {

        return null;

    }

    const profile = snapshot?.networkProfiles?.[normalized];

    if (!profile || profile.network !== normalized) {

        return null;

    }

    return Object.freeze({ snapshot, profile });

}
