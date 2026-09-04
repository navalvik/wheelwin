/**
 * Isolated Reimbursement Wallet adapter.
 *
 * Residues role migration: sendTransfer is permanently retired and cannot
 * broadcast. Identity load remains for address pin checks only.
 */

import { loadReimbursementWalletConfig } from "./ReimbursementWalletConfig.js";

export class ReimbursementWalletAdapter {

    /**
     * @param {{
     *   tonService?: object|null,
     *   env?: NodeJS.ProcessEnv,
     *   logger?: object|null,
     *   walletConfigLoader?: Function
     * }} [options]
     */
    constructor({
        tonService = null,
        env = process.env,
        logger = null,
        walletConfigLoader = loadReimbursementWalletConfig
    } = {}) {

        this._tonService = tonService;
        this._env = env;
        this._logger = logger;
        this._walletConfigLoader = walletConfigLoader;

        this._initialized = false;
        this._address = null;
        this._publicKey = null;
        this._secretKey = null;
        this._walletId = null;
        this._initError = null;

    }

    /**
     * @returns {Promise<{ ok: boolean, code?: string, message?: string, address?: string|null }>}
     */
    async initialize() {

        if (this._initialized && this._address) {

            return {
                ok: true,
                address: this._address
            };

        }

        const loaded = await this._walletConfigLoader(this._env);

        if (!loaded.ok) {

            this._initError = loaded;
            this._initialized = false;
            this._clearSecrets();

            this._logger?.warn?.(
                `ReimbursementWalletAdapter init failed | code=${loaded.code}`
            );

            return {
                ok: false,
                code: loaded.code,
                message: loaded.message,
                address: null
            };

        }

        this._address = loaded.derivedAddress;
        this._walletId = loaded.walletId;
        this._initialized = true;
        this._initError = null;
        this._clearSecrets();

        this._logger?.info?.(
            `ReimbursementWalletAdapter ready | address=${this._address} | send retired`
        );

        return {
            ok: true,
            address: this._address
        };

    }

    shutdown() {

        this._clearSecrets();
        this._initialized = false;
        this._initError = null;
        this._address = null;
        this._walletId = null;

    }

    /**
     * @returns {string|null}
     */
    getAddress() {

        return this._address;

    }

    /**
     * @returns {{ ok: false, code: string, message: string }|null}
     */
    getInitError() {

        return this._initError;

    }

    /**
     * Permanently refuses to broadcast. Enabling historical reimbursement
     * flags cannot cause this method to spend.
     *
     * @param {{ destination?: string, amountTon?: string }} [params]
     * @returns {Promise<{ ok: boolean, code: string, txHash?: string|null, errorReason?: string }>}
     */
    async sendTransfer({ destination, amountTon } = {}) {

        void destination;
        void amountTon;
        void this._tonService;

        this._logger?.warn?.(
            "ReimbursementWalletAdapter sendTransfer refused | send permanently retired"
        );

        return {
            ok: false,
            code: "SEND_RETIRED",
            txHash: null,
            errorReason: "reimbursement_send_permanently_retired"
        };

    }

    _clearSecrets() {

        this._publicKey = null;
        this._secretKey = null;

    }

}
