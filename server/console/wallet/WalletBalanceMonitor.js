/**
 * R17.9H — Read-only TON wallet balance monitor for Developer Console.
 *
 * Observability only: never signs, never stores mnemonics/private keys.
 */

import { fromNano } from "@ton/core";

import { OwnerConfiguration } from "../../config/OwnerConfiguration.js";
import { deriveDeployerWalletIdentity } from "../../payment/ton/deriveDeployerWalletIdentity.js";
import {
    deriveResiduesWalletIdentity,
    resolveResiduesMnemonic,
    resolveResiduesWalletDestination
} from "../../payment/roomWallet/ResiduesWalletConfig.js";

export const WALLET_BALANCE_TYPES = Object.freeze({
    OWNER_WALLET: "OWNER_WALLET",
    DEPLOY_WALLET: "DEPLOY_WALLET",
    REIMBURSEMENT_WALLET: "REIMBURSEMENT_WALLET"
});

export const WALLET_BALANCE_STATUS = Object.freeze({
    OK: "OK",
    NOT_CONFIGURED: "NOT_CONFIGURED",
    RPC_ERROR: "RPC_ERROR",
    UNAVAILABLE: "UNAVAILABLE"
});

export const DEFAULT_WALLET_BALANCE_REFRESH_MS = 30_000;

/**
 * @param {unknown} address
 * @returns {string|null}
 */
function safeAddress(address) {

    const text = String(address ?? "").trim();

    return text || null;

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
        runtimeConfig = null,
        env = process.env,
        refreshIntervalMs = DEFAULT_WALLET_BALANCE_REFRESH_MS,
        setIntervalFn = setInterval,
        clearIntervalFn = clearInterval,
        nowFn = () => Date.now()
    } = {}) {

        this._logger = logger;
        this._tonService = tonService;
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
            [WALLET_BALANCE_TYPES.DEPLOY_WALLET]: null,
            [WALLET_BALANCE_TYPES.REIMBURSEMENT_WALLET]: null
        });

        this._wallets = new Map([
            [
                WALLET_BALANCE_TYPES.OWNER_WALLET,
                freezeWalletEntry({
                    walletType: WALLET_BALANCE_TYPES.OWNER_WALLET,
                    status: WALLET_BALANCE_STATUS.UNAVAILABLE
                })
            ],
            [
                WALLET_BALANCE_TYPES.DEPLOY_WALLET,
                freezeWalletEntry({
                    walletType: WALLET_BALANCE_TYPES.DEPLOY_WALLET,
                    status: WALLET_BALANCE_STATUS.UNAVAILABLE
                })
            ],
            [
                WALLET_BALANCE_TYPES.REIMBURSEMENT_WALLET,
                freezeWalletEntry({
                    walletType: WALLET_BALANCE_TYPES.REIMBURSEMENT_WALLET,
                    status: WALLET_BALANCE_STATUS.UNAVAILABLE
                })
            ]
        ]);

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
     */
    getSnapshot() {

        const wallets = [
            WALLET_BALANCE_TYPES.OWNER_WALLET,
            WALLET_BALANCE_TYPES.DEPLOY_WALLET,
            WALLET_BALANCE_TYPES.REIMBURSEMENT_WALLET
        ].map((type) => this._wallets.get(type));

        return Object.freeze({
            schemaVersion: 1,
            refreshIntervalMs: this._refreshIntervalMs,
            network: this._runtimeConfig?.ton?.network ?? null,
            generatedAt: this._nowFn(),
            wallets: Object.freeze(wallets)
        });

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

    async _refreshAll() {

        await this._resolveAddresses();

        await Promise.all([
            this._refreshOne(WALLET_BALANCE_TYPES.OWNER_WALLET),
            this._refreshOne(WALLET_BALANCE_TYPES.DEPLOY_WALLET),
            this._refreshOne(WALLET_BALANCE_TYPES.REIMBURSEMENT_WALLET)
        ]);

        return this.getSnapshot();

    }

    async _resolveAddresses() {

        const owner = this._resolveOwnerAddress();
        const deploy = await this._resolveDeployAddress();
        const reimbursement = await this._resolveReimbursementAddress();

        this._addressCache = Object.freeze({
            [WALLET_BALANCE_TYPES.OWNER_WALLET]: owner,
            [WALLET_BALANCE_TYPES.DEPLOY_WALLET]: deploy,
            [WALLET_BALANCE_TYPES.REIMBURSEMENT_WALLET]: reimbursement
        });

    }

    _resolveOwnerAddress() {

        try {

            if (OwnerConfiguration.isLoaded()) {

                return safeAddress(OwnerConfiguration.getOwnerWallet());

            }

        } catch {

            // fall through
        }

        return safeAddress(this._env.OWNER_WALLET);

    }

    async _resolveDeployAddress() {

        const expected = safeAddress(
            this._runtimeConfig?.ton?.deployerExpectedAddress
        );

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

            return safeAddress(identity?.address);

        } catch (error) {

            this._logger?.warn?.(
                `WalletBalanceMonitor deploy address resolve failed | ${error?.message ?? error}`
            );

            return null;

        }

    }

    async _resolveReimbursementAddress() {

        const destination = resolveResiduesWalletDestination(this._env);

        if (destination.ok) {

            return safeAddress(destination.address);

        }

        const resolved = resolveResiduesMnemonic(this._env);

        if (!resolved.mnemonic) {

            return null;

        }

        try {

            const identity = await deriveResiduesWalletIdentity(resolved.mnemonic);

            return safeAddress(identity?.address);

        } catch (error) {

            this._logger?.warn?.(
                `WalletBalanceMonitor residues address resolve failed | ${error?.message ?? error}`
            );

            return null;

        }

    }

    async _refreshOne(walletType) {

        const previous = this._wallets.get(walletType);
        const address = this._addressCache[walletType] ?? null;
        const nowIso = new Date(this._nowFn()).toISOString();

        if (!address) {

            this._wallets.set(walletType, freezeWalletEntry({
                walletType,
                address: null,
                balance: previous?.status === WALLET_BALANCE_STATUS.OK
                    ? previous.balance
                    : null,
                status: WALLET_BALANCE_STATUS.NOT_CONFIGURED,
                lastUpdated: nowIso,
                lastSuccessfulUpdate: previous?.lastSuccessfulUpdate ?? null,
                error: "Wallet address is not configured"
            }));

            return;

        }

        if (!this._tonService?.getBalance) {

            this._wallets.set(walletType, freezeWalletEntry({
                walletType,
                address,
                balance: previous?.balance ?? null,
                status: WALLET_BALANCE_STATUS.UNAVAILABLE,
                lastUpdated: nowIso,
                lastSuccessfulUpdate: previous?.lastSuccessfulUpdate ?? null,
                error: "TonService is unavailable"
            }));

            return;

        }

        try {

            const nano = await this._tonService.getBalance(address);
            const balance = balanceTonFromNano(nano);

            this._wallets.set(walletType, freezeWalletEntry({
                walletType,
                address,
                balance,
                status: WALLET_BALANCE_STATUS.OK,
                lastUpdated: nowIso,
                lastSuccessfulUpdate: nowIso,
                error: null
            }));

        } catch (error) {

            this._wallets.set(walletType, freezeWalletEntry({
                walletType,
                address,
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
