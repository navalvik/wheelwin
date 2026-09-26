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
        mode: fields.mode ?? "RoomWallet",
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
 *   paymentArchitecture?: string|null,
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
    const mode = "room_wallet";

    if (network !== "testnet") {

        reasons.push(`Expected network=testnet | got=${network}`);

    }

    const status = reasons.length === 0 ? "READY" : "BLOCKED";

    return {
        network,
        mode: "RoomWallet",
        stakeGram: 1,
        expectedTotalGram: 3,
        deployAddress: null,
        deployWalletId: null,
        deployBalanceTon: null,
        oracleAddress: null,
        oracleSource: null,
        ownerAddress: null,
        ownerBalanceTon: null,
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
