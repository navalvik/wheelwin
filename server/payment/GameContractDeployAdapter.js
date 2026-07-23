import { randomUUID } from "node:crypto";

/**
 * P6.5 — Stub Game Smart Contract deployer.
 *
 * Prepares an authoritative deployment result from the immutable snapshot.
 * No real TON chain interaction in this stage; swap for a live SDK later.
 */
export class GameContractDeployAdapter {

    constructor({
        logger = null,
        deployDelayMs = 0,
        shouldFail = false
    } = {}) {

        this._logger = logger;

        this._deployDelayMs = Number.isFinite(deployDelayMs) && deployDelayMs >= 0
            ? deployDelayMs
            : 0;

        this._shouldFail = shouldFail === true;

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

        // Deterministic-looking stub address for this game escrow.
        const suffix = String(contractId).replace(/[^a-zA-Z0-9]/g, "").slice(-32)
            .padEnd(32, "0");

        const contractAddress = `EQ${suffix}`;

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
