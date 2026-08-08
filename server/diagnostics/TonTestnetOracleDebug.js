/**
 * R7.70A.2 — Testnet oracle diagnostics (Railway-visible, no secrets).
 */
import { printDeployBlock } from "./DeployPipelineForensics.js";

/** @type {null | Record<string, unknown>} */
let _tonTestnetOracleDebug = null;

/**
 * @param {Record<string, unknown>} fields
 */
export function setTonTestnetOracleDebug(fields = {}) {

    _tonTestnetOracleDebug = {
        network: fields.network ?? "testnet",
        oracleConfigured: fields.oracleConfigured === true
            || Boolean(fields.oracleAddress),
        oracleAddress: fields.oracleAddress ?? null,
        oracleSource: fields.oracleSource ?? null,
        timestamp: fields.timestamp ?? Date.now()
    };

    return getTonTestnetOracleDebug();

}

export function getTonTestnetOracleDebug() {

    if (!_tonTestnetOracleDebug) {

        return null;

    }

    return Object.freeze({ ..._tonTestnetOracleDebug });

}

/**
 * @param {Record<string, unknown>|null} [fields]
 */
export function printTonTestnetOracleDebug(fields = null) {

    const snapshot = fields
        ? Object.freeze({ ...fields })
        : getTonTestnetOracleDebug();

    if (!snapshot) {

        return;

    }

    printDeployBlock("TON_TESTNET_ORACLE_DEBUG", {
        network: snapshot.network ?? "testnet",
        oracleConfigured: snapshot.oracleConfigured === true,
        oracleAddress: snapshot.oracleAddress ?? null,
        oracleSource: snapshot.oracleSource ?? null,
        timestamp: snapshot.timestamp ?? null
    });

}

export function resetTonTestnetOracleDebugForTests() {

    _tonTestnetOracleDebug = null;

}
