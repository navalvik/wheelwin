/**
 * Offline Deployer/Oracle identity verification (no RPC, no .env load).
 * Uses the same derivation as production: deriveDeployerWalletIdentity.
 * Never logs mnemonic, private keys, or secretKey.
 */

import {
    DEPLOYER_WALLET_CONTRACT_TYPE,
    DEPLOYER_WALLET_WORKCHAIN,
    deriveDeployerWalletIdentity
} from "../../payment/ton/deriveDeployerWalletIdentity.js";
import {
    assertDeployerWalletMatchesExpected,
    tonAddressesEqual
} from "../../diagnostics/TonWalletIdentityDebug.js";

/** @ton/ton WalletContractV4.create default walletId (V4R2). */
export const DEPLOYER_WALLET_DEFAULT_WALLET_ID = 698983191;

const SECRET_MARKERS = Object.freeze([
    "secretKey",
    "privateKey",
    "mnemonic",
    "seed"
]);

export function parseVerifyDeployerCliArgs(argv) {

    const unexpected = [];

    for (const token of argv) {

        if (token === "--help" || token === "-h") {
            continue;
        }

        unexpected.push(token);

    }

    if (unexpected.length > 0) {
        throw new Error(
            "this verifier does not accept command-line arguments "
                + "(do not pass a mnemonic on the command line)"
        );
    }

    return Object.freeze({});
}

export async function verifyDeployerIdentity({
    mnemonic,
    expectedAddress,
    oracleAddress = null
} = {}) {

    if (!mnemonic || typeof mnemonic !== "string" || !mnemonic.trim()) {
        throw new Error("TON_DEPLOYER_MNEMONIC is required in the process environment");
    }

    if (!expectedAddress || typeof expectedAddress !== "string" || !expectedAddress.trim()) {
        throw new Error("TON_MAINNET_DEPLOYER_EXPECTED_ADDRESS is required");
    }

    const identity = await deriveDeployerWalletIdentity({
        mnemonic: mnemonic.trim(),
        network: "mainnet"
    });

    if (identity.walletContractType !== DEPLOYER_WALLET_CONTRACT_TYPE) {
        throw new Error(
            `wallet type must be ${DEPLOYER_WALLET_CONTRACT_TYPE}`
        );
    }

    if (identity.workchain !== DEPLOYER_WALLET_WORKCHAIN) {
        throw new Error(`workchain must be ${DEPLOYER_WALLET_WORKCHAIN}`);
    }

    if (identity.walletId !== DEPLOYER_WALLET_DEFAULT_WALLET_ID) {
        throw new Error(
            `walletId must be ${DEPLOYER_WALLET_DEFAULT_WALLET_ID} (WalletContractV4 default)`
        );
    }

    assertDeployerWalletMatchesExpected(
        identity.address,
        expectedAddress.trim(),
        { network: "mainnet" }
    );

    const identityMatch = tonAddressesEqual(identity.address, expectedAddress.trim());

    let oracleMatch = null;

    if (oracleAddress && String(oracleAddress).trim()) {
        oracleMatch = tonAddressesEqual(identity.address, String(oracleAddress).trim());

        if (!oracleMatch) {
            throw new Error(
                "TON_MAINNET_ORACLE_ADDRESS must match the derived Deployer address"
            );
        }
    }

    return Object.freeze({
        ok: true,
        walletContractType: identity.walletContractType,
        workchain: identity.workchain,
        walletId: identity.walletId,
        address: identity.address,
        expectedAddress: expectedAddress.trim(),
        identityMatch,
        oracleAddress: oracleAddress && String(oracleAddress).trim()
            ? String(oracleAddress).trim()
            : null,
        oracleMatch,
        network: "mainnet"
    });
}

export function formatVerifyDeployerPublicLines(result) {

    const lines = [
        "Deployer identity verification PASS",
        `network=${result.network}`,
        `walletContractType=${result.walletContractType}`,
        `workchain=${result.workchain}`,
        `walletId=${result.walletId}`,
        `address=${result.address}`,
        `expectedAddress=${result.expectedAddress}`,
        `identityMatch=${result.identityMatch}`
    ];

    if (result.oracleAddress) {
        lines.push(`oracleAddress=${result.oracleAddress}`);
        lines.push(`oracleMatch=${result.oracleMatch}`);
    }

    const joined = lines.join("\n");

    for (const marker of SECRET_MARKERS) {
        if (joined.toLowerCase().includes(marker.toLowerCase())) {
            throw new Error("refusing to print output that contains secret markers");
        }
    }

    return lines;
}
