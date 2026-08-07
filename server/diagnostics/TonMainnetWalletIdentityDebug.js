/**
 * R8.1B — TON_MAINNET_WALLET_IDENTITY_DEBUG (Railway-visible, no secrets).
 * Does not enable Mainnet GameEscrow. Never logs mnemonic.
 */
import { printDeployBlock } from "./DeployPipelineForensics.js";

/** @type {null | Record<string, unknown>} */
let _tonMainnetWalletIdentityDebug = null;

/**
 * @param {string|null|undefined} raw
 * @returns {boolean}
 */
export function isTonMainnetWalletIdentityDebugEnabled(
    raw = process.env.TON_MAINNET_WALLET_IDENTITY_DEBUG
) {

    if (raw === undefined || raw === null) {

        return false;

    }

    const normalized = String(raw).trim().toLowerCase();

    return normalized === "1"
        || normalized === "true"
        || normalized === "yes"
        || normalized === "on";

}

/**
 * @param {Record<string, unknown>} fields
 */
export function setTonMainnetWalletIdentityDebug(fields = {}) {

    const timestamp = fields.timestamp
        ?? fields.validationTimestamp
        ?? Date.now();

    _tonMainnetWalletIdentityDebug = {
        network: fields.network ?? "mainnet",
        walletType: fields.walletType ?? null,
        workchain: fields.workchain ?? null,
        walletId: fields.walletId ?? null,
        derivedAddress: fields.derivedAddress
            ?? fields.walletAddress
            ?? null,
        expectedAddress: fields.expectedAddress ?? null,
        oracleAddress: fields.oracleAddress ?? null,
        identityMatch: fields.identityMatch ?? null,
        balance: fields.balance ?? fields.balanceTon ?? null,
        balanceTon: fields.balanceTon ?? fields.balance ?? null,
        balanceNano: fields.balanceNano ?? null,
        seqno: fields.seqno ?? null,
        timestamp,
        validationTimestamp: timestamp
    };

    return getTonMainnetWalletIdentityDebug();

}

export function getTonMainnetWalletIdentityDebug() {

    if (!_tonMainnetWalletIdentityDebug) {

        return null;

    }

    return Object.freeze({ ..._tonMainnetWalletIdentityDebug });

}

/**
 * Print TON_MAINNET_WALLET_IDENTITY_DEBUG when enabled.
 *
 * @param {Record<string, unknown>|null} [fields]
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 */
export function printTonMainnetWalletIdentityDebug(
    fields = null,
    env = process.env
) {

    if (!isTonMainnetWalletIdentityDebugEnabled(
        env.TON_MAINNET_WALLET_IDENTITY_DEBUG
    )) {

        return;

    }

    const snapshot = fields
        ? Object.freeze({ ...fields })
        : getTonMainnetWalletIdentityDebug();

    if (!snapshot) {

        return;

    }

    printDeployBlock("TON_MAINNET_WALLET_IDENTITY_DEBUG", {
        network: snapshot.network ?? "mainnet",
        walletType: snapshot.walletType ?? null,
        workchain: snapshot.workchain ?? null,
        walletId: snapshot.walletId ?? null,
        derivedAddress: snapshot.derivedAddress
            ?? snapshot.walletAddress
            ?? null,
        expectedAddress: snapshot.expectedAddress ?? null,
        oracleAddress: snapshot.oracleAddress ?? null,
        balance: snapshot.balanceTon ?? snapshot.balance ?? null,
        seqno: snapshot.seqno ?? null,
        timestamp: snapshot.timestamp
            ?? snapshot.validationTimestamp
            ?? null
    });

}

export function resetTonMainnetWalletIdentityDebugForTests() {

    _tonMainnetWalletIdentityDebug = null;

}
