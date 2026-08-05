import { createHash, randomUUID } from "node:crypto";

import { Address } from "@ton/core";

import {
    markDeployStage,
    printDeployBlock,
    safeSerialize
} from "../diagnostics/DeployPipelineForensics.js";

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

        const stage = markDeployStage(
            snapshot?.roomId ?? contractId,
            "ADAPTER_STUB_DEPLOY_START"
        );

        printDeployBlock("ADAPTER DEPLOY START (GameContractDeployAdapter)", {
            AdapterImplementation: "GameContractDeployAdapter (stub)",
            Environment: process.env.NODE_ENV ?? "unknown",
            DeployMode: "stub",
            Network: this._testOnly ? "testnet (testOnly)" : "mainnet",
            Railway: Boolean(process.env.RAILWAY_ENVIRONMENT),
            Development: process.env.NODE_ENV !== "production",
            Mock: false,
            ContractId: contractId,
            RoomId: snapshot?.roomId ?? null,
            GameId: snapshot?.gameId ?? null,
            DeployDelayMs: this._deployDelayMs,
            ShouldFail: this._shouldFail,
            DurationSincePreviousStageMs: stage.elapsedMs,
            Timestamp: new Date(stage.now).toISOString()
        });

        if (!contractId || !snapshot) {

            const result = {
                ok: false,
                reason: "invalid_deploy_request"
            };

            printDeployBlock("ADAPTER DEPLOY RETURN (GameContractDeployAdapter)", {
                Case: "B — ok:false",
                ReturnedObject: safeSerialize(result),
                Timestamp: new Date().toISOString()
            });

            return result;

        }

        if (this._deployDelayMs > 0) {

            printDeployBlock("ADAPTER DEPLOY DELAY", {
                Adapter: "GameContractDeployAdapter",
                DeployDelayMs: this._deployDelayMs,
                Timestamp: new Date().toISOString()
            });

            await new Promise((resolve) => {

                setTimeout(resolve, this._deployDelayMs);

            });

        }

        if (this._shouldFail) {

            this._logger?.warn?.(
                `GameContract deploy stub failed | contractId=${contractId}`
            );

            const result = {
                ok: false,
                reason: "deploy_stub_failed"
            };

            printDeployBlock("ADAPTER DEPLOY RETURN (GameContractDeployAdapter)", {
                Case: "B — ok:false (shouldFail=true)",
                ReturnedObject: safeSerialize(result),
                Timestamp: new Date().toISOString()
            });

            return result;

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

            printDeployBlock("ADAPTER DEPLOY EXCEPTION (GameContractDeployAdapter)", {
                "Error.name": error?.name ?? "unknown",
                "Error.message": error?.message ?? String(error),
                "Error.stack": error?.stack ?? null,
                Timestamp: new Date().toISOString()
            });

            const result = {
                ok: false,
                reason: "invalid_stub_address"
            };

            printDeployBlock("ADAPTER DEPLOY RETURN (GameContractDeployAdapter)", {
                Case: "B — ok:false (address build failed)",
                ReturnedObject: safeSerialize(result),
                Timestamp: new Date().toISOString()
            });

            return result;

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

        printDeployBlock("ADAPTER DEPLOY RETURN (GameContractDeployAdapter)", {
            Case: "A — ok:true",
            ReturnedObject: safeSerialize(result),
            ReturnedPromise: "resolved (not rejected)",
            Timestamp: new Date().toISOString()
        });

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
