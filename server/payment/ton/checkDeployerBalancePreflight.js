import { fromNano } from "@ton/core";

import { deriveDeployerWalletIdentity } from "./deriveDeployerWalletIdentity.js";
import {
    DEPLOYER_MIN_BALANCE_REQUIRED_NANO,
    DEPLOYER_MIN_BALANCE_REQUIRED_TON
} from "./deployerBalancePolicy.js";

/**
 * @param {{ getBalance?: Function, getAccount?: Function }} tonService
 * @param {string} deployerAddress
 * @returns {Promise<bigint>}
 */
export async function resolveDeployerBalanceNano(tonService, deployerAddress) {

    if (typeof tonService?.getBalance === "function") {

        return tonService.getBalance(deployerAddress);

    }

    if (typeof tonService?.getAccount === "function") {

        const account = await tonService.getAccount(deployerAddress);
        const balance = account?.balance ?? "0";

        return BigInt(balance);

    }

    throw new Error("deployer_balance_unavailable");

}

/**
 * R17.8M.2 — Deployer wallet balance preflight (read-only, no secrets).
 *
 * @param {{
 *   tonConfig?: { deployerMnemonic?: string|null, network?: string|null }|null,
 *   tonService?: object|null
 * }} params
 */
export async function checkDeployerBalancePreflight({
    tonConfig = null,
    tonService = null
} = {}) {

    const network = tonConfig?.network
        ?? tonService?.getActiveNetwork?.()
        ?? null;

    const identity = await deriveDeployerWalletIdentity({
        mnemonic: tonConfig?.deployerMnemonic,
        network
    });

    const balanceNano = await resolveDeployerBalanceNano(
        tonService,
        identity.address
    );

    const availableBalance = fromNano(balanceNano);
    const requiredBalance = DEPLOYER_MIN_BALANCE_REQUIRED_TON;

    const diagnostics = Object.freeze({
        deployerAddress: identity.address,
        network: identity.network ?? network ?? "unknown",
        availableBalance,
        requiredBalance
    });

    if (balanceNano < DEPLOYER_MIN_BALANCE_REQUIRED_NANO) {

        return Object.freeze({
            ok: false,
            reason: "INSUFFICIENT_DEPLOYER_BALANCE",
            ...diagnostics
        });

    }

    return Object.freeze({
        ok: true,
        ...diagnostics
    });

}
