import { toNano } from "@ton/core";

/** Minimum balance required to attempt a deploy (0.05 TON). */
export const DEPLOYER_BALANCE_MIN_DEPLOY_NANO = toNano("0.05");

/** Recommended operational reserve (0.2 TON). */
export const DEPLOYER_BALANCE_RECOMMENDED_NANO = toNano("0.2");

/**
 * @param {bigint|string|number} balanceNano
 * @returns {Readonly<{ status: "ERROR"|"WARNING"|"READY", reason: string, message: string }>}
 */
export function evaluateDeployerWalletReadiness(balanceNano) {

    const balance = typeof balanceNano === "bigint"
        ? balanceNano
        : BigInt(balanceNano);

    if (balance < DEPLOYER_BALANCE_MIN_DEPLOY_NANO) {

        return Object.freeze({
            status: "ERROR",
            reason: "INSUFFICIENT_DEPLOYER_BALANCE",
            message: "Deployer wallet balance is insufficient"
        });

    }

    if (balance < DEPLOYER_BALANCE_RECOMMENDED_NANO) {

        return Object.freeze({
            status: "WARNING",
            reason: "LOW_DEPLOYER_RESERVE",
            message: "Low deployer wallet reserve"
        });

    }

    return Object.freeze({
        status: "READY",
        reason: "DEPLOYER_WALLET_READY",
        message: "Deployer wallet ready"
    });

}
