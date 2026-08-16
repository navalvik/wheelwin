/**
 * R17.8V.2P.O — Isolated Reimbursement Wallet adapter (no settlement / escrow paths).
 *
 * Loads reimbursement keys only. Never touches Owner or Deployer secrets.
 */

import { Address, beginCell, external, internal, storeMessage, toNano } from "@ton/core";
import { WalletContractV4 } from "@ton/ton";

import {
    REIMBURSEMENT_WALLET_WORKCHAIN,
    loadReimbursementWalletConfig,
    reimbursementAddressesEqual
} from "./ReimbursementWalletConfig.js";
import { nanotonToTonString, tonStringToNanoton } from "./nanoton.js";

export class ReimbursementWalletAdapter {

    /**
     * @param {{
     *   tonService?: {
     *     getSeqno: Function,
     *     getBalance: Function,
     *     broadcastTransaction: Function
     *   }|null,
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

        if (this._initialized && this._secretKey) {

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
        this._publicKey = loaded.publicKey;
        this._secretKey = loaded.secretKey;
        this._walletId = loaded.walletId;
        this._initialized = true;
        this._initError = null;

        this._logger?.info?.(
            `ReimbursementWalletAdapter ready | address=${this._address}`
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
     * @param {{ destination: string, amountTon: string }} params
     * @returns {Promise<{ ok: boolean, code: string, txHash?: string|null, errorReason?: string }>}
     */
    async sendTransfer({ destination, amountTon }) {

        if (!this._initialized || !this._secretKey || !this._publicKey) {

            const init = await this.initialize();

            if (!init.ok) {

                return {
                    ok: false,
                    code: "FAILED",
                    txHash: null,
                    errorReason: init.code ?? init.message ?? "wallet_not_initialized"
                };

            }

        }

        if (!this._tonService) {

            return {
                ok: false,
                code: "FAILED",
                txHash: null,
                errorReason: "ton_service_missing"
            };

        }

        const dest = String(destination ?? "").trim();
        const amount = String(amountTon ?? "").trim();
        const amountNano = tonStringToNanoton(amount);

        if (!dest || amountNano == null || amountNano <= 0n) {

            return {
                ok: false,
                code: "FAILED",
                txHash: null,
                errorReason: "invalid_transfer_params"
            };

        }

        try {

            Address.parse(dest);

        } catch {

            return {
                ok: false,
                code: "FAILED",
                txHash: null,
                errorReason: "invalid_destination"
            };

        }

        try {

            const balance = await this._tonService.getBalance(this._address);

            if (typeof balance === "bigint" && balance < amountNano) {

                return {
                    ok: false,
                    code: "FAILED",
                    txHash: null,
                    errorReason: "insufficient_balance",
                    balanceTon: nanotonToTonString(balance)
                };

            }

            const wallet = WalletContractV4.create({
                workchain: REIMBURSEMENT_WALLET_WORKCHAIN,
                publicKey: this._publicKey
            });

            if (!reimbursementAddressesEqual(wallet.address, this._address)) {

                return {
                    ok: false,
                    code: "FAILED",
                    txHash: null,
                    errorReason: "wallet_identity_drift"
                };

            }

            const seqno = await this._tonService.getSeqno(this._address);

            const transfer = wallet.createTransfer({
                seqno,
                secretKey: this._secretKey,
                messages: [
                    internal({
                        to: dest,
                        value: toNano(amount),
                        bounce: true
                    })
                ]
            });

            const externalMessage = external({
                to: wallet.address,
                body: transfer
            });

            const bocBase64 = beginCell()
                .store(storeMessage(externalMessage))
                .endCell()
                .toBoc()
                .toString("base64");

            const broadcast = await this._tonService.broadcastTransaction(bocBase64);

            const txHash = extractBroadcastTxHash(broadcast)
                ?? `reimb_seqno_${seqno}_${Date.now()}`;

            this._logger?.info?.(
                `ReimbursementWalletAdapter SENT | to=${dest} | amount=${amount} | `
                    + `txHash=${txHash}`
            );

            return {
                ok: true,
                code: "SENT",
                txHash
            };

        } catch (error) {

            this._logger?.error?.(
                `ReimbursementWalletAdapter send failed | ${error?.message ?? error}`
            );

            return {
                ok: false,
                code: "FAILED",
                txHash: null,
                errorReason: error?.message ?? "send_failed"
            };

        }

    }

    _clearSecrets() {

        this._publicKey = null;
        this._secretKey = null;

    }

}

/**
 * @param {unknown} broadcast
 * @returns {string|null}
 */
function extractBroadcastTxHash(broadcast) {

    if (!broadcast || typeof broadcast !== "object") {

        return null;

    }

    const candidates = [
        broadcast.hash,
        broadcast.txHash,
        broadcast.transactionHash,
        broadcast.result?.hash
    ];

    for (const value of candidates) {

        if (typeof value === "string" && value.trim()) {

            return value.trim();

        }

    }

    return null;

}
