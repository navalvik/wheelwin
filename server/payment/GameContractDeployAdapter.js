import { createHash, randomUUID } from "node:crypto";

import { Address } from "@ton/core";

/**
 * P6.5 — Stub Game Smart Contract deployer.
 *
 * Prepares an authoritative deployment result from the immutable snapshot.
 * No real TON chain interaction in this stage; swap for a live SDK later.
 *
 * Stub addresses are CRC-valid user-friendly forms (@ton/core) so TonConnect
 * accepts them; they are not on-chain deployments.
 */

/**
 * Deterministic stub escrow address from contractId hash.
 * @param {string} contractId
 * @param {{ testOnly?: boolean }} [options]
 * @returns {string} bounceable url-safe friendly address
 */
export function buildStubContractAddress(contractId, { testOnly = false } = {}) {

    const hash = createHash("sha256")
        .update(`wheelwin:stub-escrow:${String(contractId)}`)
        .digest();

    const address = new Address(0, hash);

    const friendly = address.toString({
        bounceable: true,
        urlSafe: true,
        testOnly: testOnly === true
    });

    // Reject before PaymentSession / TonConnect if encoding is invalid.
    Address.parseFriendly(friendly);

    return friendly;

}

function resolveTestOnly({ network = null, testOnly = null } = {}) {

    if (testOnly === true || testOnly === false) {

        return testOnly;

    }

    return String(network ?? "").trim().toLowerCase() === "testnet";

}

export class GameContractDeployAdapter {

    constructor({
        logger = null,
        deployDelayMs = 0,
        shouldFail = false,
        network = null,
        testOnly = null
    } = {}) {

        this._logger = logger;

        this._deployDelayMs = Number.isFinite(deployDelayMs) && deployDelayMs >= 0
            ? deployDelayMs
            : 0;

        this._shouldFail = shouldFail === true;

        this._testOnly = resolveTestOnly({ network, testOnly });

    }

    /**
     * @param {{ contractId: string, snapshot: object }} request
     * @returns {Promise<{
     *   ok: boolean,
     *   contractAddress?: string,
     *   deploymentTxId?: string,
     *   deployedAt?: number,
     *   reason?: string
     * }>}
     */
    async deploy({ contractId, snapshot }) {

        if (!contractId || !snapshot) {

            return {
                ok: false,
                reason: "invalid_deploy_request"
            };

        }

        if (this._deployDelayMs > 0) {

            await new Promise((resolve) => {

                setTimeout(resolve, this._deployDelayMs);

            });

        }

        if (this._shouldFail) {

            this._logger?.warn?.(
                `GameContract deploy stub failed | contractId=${contractId}`
            );

            return {
                ok: false,
                reason: "deploy_stub_failed"
            };

        }

        let contractAddress;

        try {

            contractAddress = buildStubContractAddress(contractId, {
                testOnly: this._testOnly
            });

        } catch (error) {

            this._logger?.error?.(
                `GameContract deploy stub address invalid | contractId=${contractId} | `
                    + `${error?.message ?? error}`
            );

            return {
                ok: false,
                reason: "invalid_stub_address"
            };

        }

        const result = {
            ok: true,
            contractAddress,
            deploymentTxId: `deploy_tx_${randomUUID()}`,
            deployedAt: Date.now()
        };

        this._logger?.info?.(
            `GameContract deploy stub ok | contractId=${contractId} | `
                + `address=${contractAddress}`
        );

        return result;

    }

    /**
     * P6.8B — Submit settlement transfers via the smart contract.
     * Stub performs no real chain transfer; returns an immutable result.
     *
     * @param {object} settlementRequest
     * @returns {Promise<{
     *   ok: boolean,
     *   settlementTxId?: string,
     *   settledAt?: number,
     *   reason?: string
     * }>}
     */
    async settleContract(settlementRequest) {

        if (!settlementRequest?.contractId || !settlementRequest?.winnerWallet) {

            return {
                ok: false,
                reason: "invalid_settlement_request"
            };

        }

        if (this._deployDelayMs > 0) {

            await new Promise((resolve) => {

                setTimeout(resolve, this._deployDelayMs);

            });

        }

        if (this._shouldFail) {

            this._logger?.warn?.(
                `GameContract settle stub failed | contractId=${settlementRequest.contractId}`
            );

            return {
                ok: false,
                reason: "settle_stub_failed"
            };

        }

        const result = {
            ok: true,
            settlementTxId: `settle_tx_${randomUUID()}`,
            settledAt: Date.now()
        };

        this._logger?.info?.(
            `GameContract settle stub ok | contractId=${settlementRequest.contractId}`
        );

        return result;

    }

}
