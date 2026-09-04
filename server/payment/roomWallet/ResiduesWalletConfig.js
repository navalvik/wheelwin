/**
 * Residues Wallet configuration — one physical WalletContractV4 identity.
 *
 * Canonical env:
 *   TON_RESIDUES_MNEMONIC
 *   TON_RESIDUES_EXPECTED_ADDRESS
 *
 * Staged compatibility (same identity only; not a second wallet):
 *   TON_REIMBURSEMENT_MNEMONIC
 *   TON_REIMBURSEMENT_EXPECTED_ADDRESS
 *
 * Prefer Residues keys. Dual pins or dual mnemonics must resolve to the
 * same public address. Never logs mnemonic or private keys. Does not
 * generate wallets, deploy, or transfer funds.
 */

import { Address } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";

export const TON_RESIDUES_MNEMONIC_ENV = "TON_RESIDUES_MNEMONIC";
export const TON_RESIDUES_EXPECTED_ADDRESS_ENV = "TON_RESIDUES_EXPECTED_ADDRESS";
export const TON_REIMBURSEMENT_MNEMONIC_COMPAT_ENV = "TON_REIMBURSEMENT_MNEMONIC";
export const TON_REIMBURSEMENT_EXPECTED_ADDRESS_COMPAT_ENV =
    "TON_REIMBURSEMENT_EXPECTED_ADDRESS";

export const RESIDUES_WALLET_CONTRACT_TYPE = "WalletContractV4R2";
export const RESIDUES_WALLET_WORKCHAIN = 0;

function trimEnv(env, key) {
    return String(env?.[key] ?? "").trim();
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function residuesAddressesEqual(left, right) {
    if (!left || !right) {
        return false;
    }

    try {
        const a = typeof left === "string" ? Address.parse(left) : left;
        const b = typeof right === "string" ? Address.parse(right) : right;
        return a.equals(b);
    } catch {
        const canonicalLeft = canonicalizeTonWalletAddress(String(left ?? ""));
        const canonicalRight = canonicalizeTonWalletAddress(String(right ?? ""));
        return Boolean(canonicalLeft && canonicalRight && canonicalLeft === canonicalRight);
    }
}

/**
 * Same V4R2 / workchain 0 derivation previously used for the Reimbursement
 * Wallet. Does not log secrets.
 *
 * @param {string} mnemonic
 * @returns {Promise<{ address: string, publicKey: Buffer, secretKey: Buffer, walletId: number }>}
 */
export async function deriveResiduesWalletIdentity(mnemonic) {
    const words = String(mnemonic ?? "").trim().split(/\s+/).filter(Boolean);

    if (words.length < 12) {
        throw new Error("Residues wallet mnemonic is empty or invalid");
    }

    const keyPair = await mnemonicToPrivateKey(words);
    const wallet = WalletContractV4.create({
        workchain: RESIDUES_WALLET_WORKCHAIN,
        publicKey: keyPair.publicKey
    });

    return Object.freeze({
        address: wallet.address.toString({
            bounceable: true,
            urlSafe: true
        }),
        publicKey: keyPair.publicKey,
        secretKey: keyPair.secretKey,
        walletId: wallet.walletId,
        contractType: RESIDUES_WALLET_CONTRACT_TYPE,
        workchain: RESIDUES_WALLET_WORKCHAIN
    });
}

/**
 * Public Residues receive pin. Prefer TON_RESIDUES_EXPECTED_ADDRESS.
 * Fall back to TON_REIMBURSEMENT_EXPECTED_ADDRESS only when Residues pin
 * is unset. Dual pins must canonicalize to the same address.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: boolean, code: string, address: string|null, source: string|null, compatibility: boolean }}
 */
export function resolveResiduesWalletDestination(env = process.env) {
    const residuesRaw = trimEnv(env, TON_RESIDUES_EXPECTED_ADDRESS_ENV);
    const legacyRaw = trimEnv(env, TON_REIMBURSEMENT_EXPECTED_ADDRESS_COMPAT_ENV);

    if (residuesRaw) {
        const residuesAddress = canonicalizeTonWalletAddress(residuesRaw);

        if (!residuesAddress) {
            return Object.freeze({
                ok: false,
                code: "RESIDUES_DESTINATION_INVALID",
                address: null,
                source: TON_RESIDUES_EXPECTED_ADDRESS_ENV,
                compatibility: false
            });
        }

        if (legacyRaw) {
            const legacyAddress = canonicalizeTonWalletAddress(legacyRaw);

            if (!legacyAddress || residuesAddress !== legacyAddress) {
                return Object.freeze({
                    ok: false,
                    code: "RESIDUES_ADDRESS_CONFLICT",
                    address: null,
                    source: TON_RESIDUES_EXPECTED_ADDRESS_ENV,
                    compatibility: false
                });
            }
        }

        return Object.freeze({
            ok: true,
            code: "OK",
            address: residuesAddress,
            source: TON_RESIDUES_EXPECTED_ADDRESS_ENV,
            compatibility: false
        });
    }

    if (legacyRaw) {
        const legacyAddress = canonicalizeTonWalletAddress(legacyRaw);

        if (!legacyAddress) {
            return Object.freeze({
                ok: false,
                code: "RESIDUES_DESTINATION_INVALID",
                address: null,
                source: TON_REIMBURSEMENT_EXPECTED_ADDRESS_COMPAT_ENV,
                compatibility: true
            });
        }

        return Object.freeze({
            ok: true,
            code: "OK",
            address: legacyAddress,
            source: TON_REIMBURSEMENT_EXPECTED_ADDRESS_COMPAT_ENV,
            compatibility: true
        });
    }

    return Object.freeze({
        ok: false,
        code: "RESIDUES_DESTINATION_MISSING",
        address: null,
        source: null,
        compatibility: false
    });
}

/**
 * Resolve mnemonic without returning the secret to callers who only need
 * the source key name. Returns the mnemonic only to trusted identity loaders.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ mnemonic: string|null, source: string|null }}
 */
export function resolveResiduesMnemonic(env = process.env) {
    const residues = trimEnv(env, TON_RESIDUES_MNEMONIC_ENV);
    const legacy = trimEnv(env, TON_REIMBURSEMENT_MNEMONIC_COMPAT_ENV);

    if (residues) {
        return {
            mnemonic: residues,
            source: TON_RESIDUES_MNEMONIC_ENV
        };
    }

    if (legacy) {
        return {
            mnemonic: legacy,
            source: TON_REIMBURSEMENT_MNEMONIC_COMPAT_ENV
        };
    }

    return {
        mnemonic: null,
        source: null
    };
}

/**
 * Derive Residues identity and verify against the expected public pin.
 * Dual mnemonics must produce the same address (copy during migration).
 * Never logs the mnemonic.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{
 *   ok: boolean,
 *   code: string,
 *   derivedAddress: string|null,
 *   expectedAddress: string|null,
 *   mnemonicSource: string|null,
 *   addressSource: string|null,
 *   contractType: string,
 *   workchain: number
 * }>}
 */
export async function verifyResiduesWalletIdentity(env = process.env) {
    const destination = resolveResiduesWalletDestination(env);
    const residuesMnemonic = trimEnv(env, TON_RESIDUES_MNEMONIC_ENV);
    const legacyMnemonic = trimEnv(env, TON_REIMBURSEMENT_MNEMONIC_COMPAT_ENV);
    const resolved = resolveResiduesMnemonic(env);

    if (residuesMnemonic && legacyMnemonic) {
        let residuesIdentity;
        let legacyIdentity;

        try {
            residuesIdentity = await deriveResiduesWalletIdentity(residuesMnemonic);
            legacyIdentity = await deriveResiduesWalletIdentity(legacyMnemonic);
        } catch {
            return Object.freeze({
                ok: false,
                code: "MNEMONIC_INVALID",
                derivedAddress: null,
                expectedAddress: destination.address,
                mnemonicSource: TON_RESIDUES_MNEMONIC_ENV,
                addressSource: destination.source,
                contractType: RESIDUES_WALLET_CONTRACT_TYPE,
                workchain: RESIDUES_WALLET_WORKCHAIN
            });
        }

        if (!residuesAddressesEqual(residuesIdentity.address, legacyIdentity.address)) {
            return Object.freeze({
                ok: false,
                code: "RESIDUES_MNEMONIC_CONFLICT",
                derivedAddress: null,
                expectedAddress: destination.address,
                mnemonicSource: TON_RESIDUES_MNEMONIC_ENV,
                addressSource: destination.source,
                contractType: RESIDUES_WALLET_CONTRACT_TYPE,
                workchain: RESIDUES_WALLET_WORKCHAIN
            });
        }
    }

    if (!resolved.mnemonic) {
        if (!destination.ok) {
            return Object.freeze({
                ok: false,
                code: destination.code,
                derivedAddress: null,
                expectedAddress: null,
                mnemonicSource: null,
                addressSource: destination.source,
                contractType: RESIDUES_WALLET_CONTRACT_TYPE,
                workchain: RESIDUES_WALLET_WORKCHAIN
            });
        }

        return Object.freeze({
            ok: true,
            code: "PIN_ONLY",
            derivedAddress: null,
            expectedAddress: destination.address,
            mnemonicSource: null,
            addressSource: destination.source,
            contractType: RESIDUES_WALLET_CONTRACT_TYPE,
            workchain: RESIDUES_WALLET_WORKCHAIN
        });
    }

    let identity;

    try {
        identity = await deriveResiduesWalletIdentity(resolved.mnemonic);
    } catch {
        return Object.freeze({
            ok: false,
            code: "MNEMONIC_INVALID",
            derivedAddress: null,
            expectedAddress: destination.ok ? destination.address : null,
            mnemonicSource: resolved.source,
            addressSource: destination.source,
            contractType: RESIDUES_WALLET_CONTRACT_TYPE,
            workchain: RESIDUES_WALLET_WORKCHAIN
        });
    }

    if (destination.ok && !residuesAddressesEqual(identity.address, destination.address)) {
        return Object.freeze({
            ok: false,
            code: "ADDRESS_MISMATCH",
            derivedAddress: identity.address,
            expectedAddress: destination.address,
            mnemonicSource: resolved.source,
            addressSource: destination.source,
            contractType: RESIDUES_WALLET_CONTRACT_TYPE,
            workchain: RESIDUES_WALLET_WORKCHAIN
        });
    }

    if (!destination.ok && destination.code !== "RESIDUES_DESTINATION_MISSING") {
        return Object.freeze({
            ok: false,
            code: destination.code,
            derivedAddress: identity.address,
            expectedAddress: null,
            mnemonicSource: resolved.source,
            addressSource: destination.source,
            contractType: RESIDUES_WALLET_CONTRACT_TYPE,
            workchain: RESIDUES_WALLET_WORKCHAIN
        });
    }

    return Object.freeze({
        ok: true,
        code: destination.ok ? "OK" : "DERIVED_UNPINNED",
        derivedAddress: identity.address,
        expectedAddress: destination.ok ? destination.address : identity.address,
        mnemonicSource: resolved.source,
        addressSource: destination.source,
        contractType: RESIDUES_WALLET_CONTRACT_TYPE,
        workchain: RESIDUES_WALLET_WORKCHAIN
    });
}

/**
 * Sweep source (Room Wallet) must not equal Residues destination.
 *
 * @param {unknown} sourceAddress
 * @param {unknown} destinationAddress
 * @returns {{ ok: boolean, code: string }}
 */
export function assertSweepSourceDiffersFromDestination(sourceAddress, destinationAddress) {
    const source = canonicalizeTonWalletAddress(String(sourceAddress ?? ""));
    const destination = canonicalizeTonWalletAddress(String(destinationAddress ?? ""));

    if (!source || !destination) {
        return Object.freeze({
            ok: false,
            code: "SWEEP_ADDRESS_MISSING"
        });
    }

    if (source === destination) {
        return Object.freeze({
            ok: false,
            code: "SOURCE_EQUALS_DESTINATION"
        });
    }

    return Object.freeze({
        ok: true,
        code: "OK"
    });
}
