/**
 * R7.67B — TON_WALLET_IDENTITY_DEBUG (Railway-visible, no secrets).
 */
import { Address } from "@ton/core";

import { printDeployBlock } from "./DeployPipelineForensics.js";

/** @type {null | Record<string, unknown>} */
let _tonWalletIdentityDebug = null;

/**
 * @param {Record<string, unknown>} fields
 */
export function setTonWalletIdentityDebug(fields = {}) {

    _tonWalletIdentityDebug = {
        walletContractType: fields.walletContractType ?? null,
        workchain: fields.workchain ?? null,
        walletId: fields.walletId ?? null,
        address: fields.address ?? null,
        network: fields.network ?? null,
        balanceTon: fields.balanceTon ?? null,
        balanceNano: fields.balanceNano ?? null,
        lastCheckedAt: fields.lastCheckedAt ?? null,
        expectedAddress: fields.expectedAddress ?? null,
        identityMatch: fields.identityMatch ?? null,
        mnemonicConfigured: fields.mnemonicConfigured !== false,
        balanceError: fields.balanceError ?? null,
        timestamp: Date.now()
    };

    return getTonWalletIdentityDebug();

}

/**
 * @returns {object|null}
 */
export function getTonWalletIdentityDebug() {

    if (!_tonWalletIdentityDebug) {

        return null;

    }

    return Object.freeze({ ..._tonWalletIdentityDebug });

}

/**
 * Print TON_WALLET_IDENTITY_DEBUG block to stdout (Railway-visible).
 */
export function printTonWalletIdentityDebug(fields = null) {

    const snapshot = fields
        ? Object.freeze({ ...fields })
        : getTonWalletIdentityDebug();

    if (!snapshot) {

        return;

    }

    printDeployBlock("TON_WALLET_IDENTITY_DEBUG", {
        walletContractType: snapshot.walletContractType,
        workchain: snapshot.workchain,
        walletId: snapshot.walletId,
        address: snapshot.address,
        network: snapshot.network,
        balanceTon: snapshot.balanceTon,
        balanceNano: snapshot.balanceNano,
        lastCheckedAt: snapshot.lastCheckedAt,
        expectedAddress: snapshot.expectedAddress,
        identityMatch: snapshot.identityMatch,
        mnemonicConfigured: snapshot.mnemonicConfigured,
        balanceError: snapshot.balanceError ?? null
    });

}

export function resetTonWalletIdentityDebugForTests() {

    _tonWalletIdentityDebug = null;

}

/**
 * Compare TON addresses (bounceable / non-bounceable / raw forms).
 * @param {string|null|undefined} left
 * @param {string|null|undefined} right
 * @returns {boolean}
 */
export function tonAddressesEqual(left, right) {

    if (!left || !right) {

        return false;

    }

    try {

        return Address.parse(String(left)).equals(Address.parse(String(right)));

    } catch {

        return String(left).trim() === String(right).trim();

    }

}

/**
 * R8.1B — Validate TON address format (no guessing / rewriting).
 *
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
export function isValidTonAddress(value) {

    if (value === undefined || value === null) {

        return false;

    }

    const trimmed = String(value).trim();

    if (!trimmed) {

        return false;

    }

    try {

        Address.parse(trimmed);

        return true;

    } catch {

        return false;

    }

}

/**
 * Fail when derived mnemonic address does not match expected pin.
 *
 * @param {string} derivedAddress
 * @param {string} expectedAddress
 * @param {{ network?: string|null }} [options]
 */
export function assertDeployerWalletMatchesExpected(
    derivedAddress,
    expectedAddress,
    options = {}
) {

    if (!expectedAddress) {

        return;

    }

    const network = options.network == null ? null : String(options.network);
    const networkSuffix = network ? ` | network=${network}` : "";

    if (!derivedAddress) {

        throw new Error(
            "TON deployer wallet identity mismatch | derived address missing | "
                + `expected=${expectedAddress}${networkSuffix}`
        );

    }

    if (!tonAddressesEqual(derivedAddress, expectedAddress)) {

        throw new Error(
            "TON deployer wallet identity mismatch | "
                + `derived=${derivedAddress} | expected=${expectedAddress}`
                + networkSuffix
        );

    }

}
