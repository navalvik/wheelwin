/**
 * R7.70B — Testnet wallet readiness diagnostics (read-only, no secrets).
 * Does not deploy, stake, or settle on-chain.
 */
import { printDeployBlock } from "./DeployPipelineForensics.js";

/** @type {null | Record<string, unknown>} */
let _tonTestnetWalletReadiness = null;

/**
 * @param {Record<string, unknown>} fields
 */
export function setTonTestnetWalletReadiness(fields = {}) {

    _tonTestnetWalletReadiness = {
        network: fields.network ?? "testnet",
        mode: fields.mode ?? "GameEscrow",
        stakeGram: fields.stakeGram ?? 1,
        expectedTotalGram: fields.expectedTotalGram ?? 3,
        deployAddress: fields.deployAddress ?? null,
        deployWalletId: fields.deployWalletId ?? null,
        deployBalanceTon: fields.deployBalanceTon ?? null,
        oracleAddress: fields.oracleAddress ?? null,
        oracleSource: fields.oracleSource ?? null,
        ownerAddress: fields.ownerAddress ?? null,
        ownerBalanceTon: fields.ownerBalanceTon ?? null,
        playersConfigured: fields.playersConfigured ?? "tonconnect_runtime",
        playerSeatCount: fields.playerSeatCount ?? 3,
        status: fields.status ?? "UNKNOWN",
        reasons: Array.isArray(fields.reasons) ? [...fields.reasons] : [],
        timestamp: fields.timestamp ?? Date.now()
    };

    return getTonTestnetWalletReadiness();

}

export function getTonTestnetWalletReadiness() {

    if (!_tonTestnetWalletReadiness) {

        return null;

    }

    return Object.freeze({
        ..._tonTestnetWalletReadiness,
        reasons: Object.freeze([..._tonTestnetWalletReadiness.reasons])
    });

}

/**
 * @param {Record<string, unknown>|null} [fields]
 */
export function printTonTestnetWalletReadiness(fields = null) {

    const snapshot = fields
        ? Object.freeze({ ...fields })
        : getTonTestnetWalletReadiness();

    if (!snapshot) {

        return;

    }

    printDeployBlock("R7.70 WALLET READINESS", {
        network: snapshot.network,
        mode: snapshot.mode,
        stake: `${snapshot.stakeGram ?? 1} Gram`,
        expectedTotal: `${snapshot.expectedTotalGram ?? 3} Gram`,
        deployWallet: snapshot.deployAddress ?? null,
        deployWalletId: snapshot.deployWalletId ?? null,
        deployBalance: snapshot.deployBalanceTon ?? null,
        oracle: snapshot.oracleAddress ?? null,
        oracleSource: snapshot.oracleSource ?? null,
        owner: snapshot.ownerAddress ?? null,
        ownerBalance: snapshot.ownerBalanceTon ?? null,
        players: snapshot.playersConfigured ?? null,
        playerSeatCount: snapshot.playerSeatCount ?? 3,
        status: snapshot.status,
        reasons: snapshot.reasons,
        timestamp: snapshot.timestamp
    });

}

/**
 * Evaluate local Testnet wallet readiness for R7.70 settlement validation prep.
 * No on-chain mutations.
 *
 * @param {{
 *   network?: string|null,
 *   gameEscrowMode?: string|null,
 *   deployAddress?: string|null,
 *   deployWalletId?: number|null,
 *   deployBalanceTon?: number|null,
 *   oracleAddress?: string|null,
 *   oracleSource?: string|null,
 *   ownerAddress?: string|null,
 *   ownerBalanceTon?: number|null
 * }} input
 */
export function evaluateTonTestnetWalletReadiness(input = {}) {

    const reasons = [];
    const network = String(input.network ?? "").trim().toLowerCase() || "testnet";
    const mode = String(input.gameEscrowMode ?? "").trim().toLowerCase();

    if (network !== "testnet") {

        reasons.push(`Expected network=testnet | got=${network}`);

    }

    if (mode !== "game") {

        reasons.push(`Expected GameEscrow mode=game | got=${mode || "unset"}`);

    }

    if (!input.deployAddress) {

        reasons.push("Deploy wallet identity unavailable");

    }

    if (!input.oracleAddress) {

        reasons.push("Oracle address not configured");

    }

    if (!input.ownerAddress) {

        reasons.push("Owner wallet not configured");

    }

    if (
        input.deployBalanceTon != null
        && Number(input.deployBalanceTon) < 0.1
    ) {

        reasons.push("Deploy wallet balance too low for Testnet deploy/gas");

    }

    const status = reasons.length === 0 ? "READY" : "BLOCKED";

    return {
        network,
        mode: mode === "game" ? "GameEscrow" : (mode || "unknown"),
        stakeGram: 1,
        expectedTotalGram: 3,
        deployAddress: input.deployAddress ?? null,
        deployWalletId: input.deployWalletId ?? null,
        deployBalanceTon: input.deployBalanceTon ?? null,
        oracleAddress: input.oracleAddress ?? null,
        oracleSource: input.oracleSource ?? null,
        ownerAddress: input.ownerAddress ?? null,
        ownerBalanceTon: input.ownerBalanceTon ?? null,
        playersConfigured: "tonconnect_runtime",
        playerSeatCount: 3,
        status,
        reasons,
        timestamp: Date.now()
    };

}

export function resetTonTestnetWalletReadinessForTests() {

    _tonTestnetWalletReadiness = null;

}
