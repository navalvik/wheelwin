/**
 * R17.9L.25 — TEST-ONLY three-player testnet wallet loader.
 *
 * Secrets: L25_PLAYER_0_MNEMONIC / L25_PLAYER_1_MNEMONIC / L25_PLAYER_2_MNEMONIC
 * Public verification: L25_PLAYER_0_ADDRESS / L25_PLAYER_1_ADDRESS / L25_PLAYER_2_ADDRESS
 * Never logs mnemonics or private keys. Public addresses only in returned snapshots.
 */

import { Address } from "@ton/core";

import {
    FROZEN_TESTNET_DEPOSIT_DEPLOYER_ADDRESS,
    PRODUCTION_DEPLOY_WALLET
} from "../../../payment/ton/depositTestnetFixture.js";
import {
    resolveReservedDepositWallets
} from "../../../deposit/depositValidation.js";
import { canonicalizeTonWalletAddress } from "../../../models/TonWalletAddress.js";
import { L25_ERROR_CODES, L25TestError } from "./l25Errors.js";
import {
    createL25PlayerWalletContract,
    deriveL25PlayerKeyPair,
    L25_DEFAULT_PLAYER_WALLET_CONTRACT,
    resolveL25PlayerWalletContract
} from "./l25PlayerWalletDerivation.js";

export { L25_DEFAULT_PLAYER_WALLET_CONTRACT };

export const L25_PLAYER_MNEMONIC_ENV_KEYS = Object.freeze([
    "L25_PLAYER_0_MNEMONIC",
    "L25_PLAYER_1_MNEMONIC",
    "L25_PLAYER_2_MNEMONIC"
]);

export const L25_PLAYER_ADDRESS_ENV_KEYS = Object.freeze([
    "L25_PLAYER_0_ADDRESS",
    "L25_PLAYER_1_ADDRESS",
    "L25_PLAYER_2_ADDRESS"
]);

function normalizeMnemonic(raw) {

    if (typeof raw !== "string" || !raw.trim()) {

        return null;

    }

    const words = raw.trim().split(/\s+/).filter(Boolean);

    return words.length >= 12 ? words : null;

}

function formatAddress(address, { bounceable = true } = {}) {

    return address.toString({
        bounceable,
        urlSafe: true,
        testOnly: true
    });

}

/**
 * Normalize to raw workchain:accountHash identity for comparisons.
 */
export function resolveRawAddressIdentity(rawAddress) {

    if (typeof rawAddress !== "string" || !rawAddress.trim()) {

        return null;

    }

    try {

        return Address.parseFriendly(rawAddress.trim()).address.toRawString();

    } catch {

        try {

            return Address.parse(rawAddress.trim()).toRawString();

        } catch {

            return null;

        }

    }

}

/**
 * @returns {Promise<{
 *   seatIndex: number,
 *   label: string,
 *   address: string,
 *   addressCanonical: string,
 *   rawAddressIdentity: string,
 *   walletContractType: string,
 *   keyDerivationMethod: string,
 *   wallet: object,
 *   keyPair: { publicKey: Buffer, secretKey: Buffer }
 * }>}
 */
export async function derivePlayerWallet(seatIndex, words, env = process.env) {

    const { keyPair, keyDerivationMethod } = await deriveL25PlayerKeyPair(words, env);
    const walletContract = resolveL25PlayerWalletContract(env);
    const created = createL25PlayerWalletContract(keyPair.publicKey, env);

    const address = formatAddress(created.wallet.address, { bounceable: true });
    const addressCanonical = canonicalizeTonWalletAddress(address) ?? address;
    const rawAddressIdentity = resolveRawAddressIdentity(addressCanonical);

    return Object.freeze({
        seatIndex,
        label: `player${seatIndex}`,
        address,
        addressCanonical,
        rawAddressIdentity,
        walletContractType: created.walletContractType,
        keyDerivationMethod,
        wallet: created.wallet,
        keyPair
    });

}

/**
 * Validate three canonical addresses are distinct, non-zero, non-reserved.
 */
export function assertValidL25PlayerAddresses(addresses, env = process.env) {

    if (!Array.isArray(addresses) || addresses.length !== 3) {

        throw new L25TestError(
            "Exactly three player addresses are required",
            L25_ERROR_CODES.WALLET_INVALID,
            { count: addresses?.length ?? 0 }
        );

    }

    const reserved = resolveReservedDepositWallets(env);

    // Always pin historical fixtures even if env is sparse.
    for (const [raw, reason] of [
        [PRODUCTION_DEPLOY_WALLET, "PRODUCTION_DEPLOY_WALLET"],
        [FROZEN_TESTNET_DEPOSIT_DEPLOYER_ADDRESS, "TESTNET_DEPOSIT_DEPLOYER"]
    ]) {

        const canonical = canonicalizeTonWalletAddress(raw);

        if (canonical && !reserved.has(canonical)) {

            reserved.set(canonical, reason);

        }

    }

    const seen = new Set();

    for (let index = 0; index < 3; index += 1) {

        const canonical = canonicalizeTonWalletAddress(addresses[index])
            ?? null;

        if (!canonical) {

            throw new L25TestError(
                `Player ${index} address is invalid`,
                L25_ERROR_CODES.WALLET_INVALID,
                { seatIndex: index }
            );

        }

        if (reserved.has(canonical)) {

            throw new L25TestError(
                `Player ${index} address is reserved (${reserved.get(canonical)})`,
                L25_ERROR_CODES.WALLET_RESERVED,
                { seatIndex: index, reason: reserved.get(canonical) }
            );

        }

        if (seen.has(canonical)) {

            throw new L25TestError(
                "Player addresses must be distinct",
                L25_ERROR_CODES.WALLET_INVALID,
                { seatIndex: index, address: canonical }
            );

        }

        seen.add(canonical);

    }

    return true;

}

/**
 * Verify derived wallets match configured expected public addresses.
 */
export function assertExpectedPlayerAddresses(wallets, env = process.env) {

    for (const wallet of wallets ?? []) {

        const envKey = L25_PLAYER_ADDRESS_ENV_KEYS[wallet.seatIndex];
        const expectedRaw = String(env[envKey] ?? "").trim();

        if (!expectedRaw) {

            throw new L25TestError(
                `${envKey} is required for L25 wallet address verification`,
                L25_ERROR_CODES.READINESS_BLOCKED,
                { envKey, seatIndex: wallet.seatIndex }
            );

        }

        const derivedRaw = resolveRawAddressIdentity(wallet.addressCanonical);
        const expectedIdentity = resolveRawAddressIdentity(expectedRaw);

        if (!derivedRaw || !expectedIdentity || derivedRaw !== expectedIdentity) {

            throw new L25TestError(
                `Player ${wallet.seatIndex} derived address does not match ${envKey}`,
                L25_ERROR_CODES.ADDRESS_MISMATCH,
                {
                    seatIndex: wallet.seatIndex,
                    envKey,
                    derivedAddress: wallet.addressCanonical,
                    expectedAddress: canonicalizeTonWalletAddress(expectedRaw) ?? expectedRaw,
                    derivedRaw,
                    expectedRaw: expectedIdentity
                }
            );

        }

    }

    return true;

}

/**
 * Load and validate three signable L.25 player wallets from env.
 * Never returns mnemonic strings.
 *
 * @param {object} env
 * @param {{ requireExpectedAddresses?: boolean }} [options]
 */
export async function loadL25PlayerWallets(env = process.env, options = {}) {

    const { requireExpectedAddresses = false } = options;
    const wallets = [];

    for (let seatIndex = 0; seatIndex < 3; seatIndex += 1) {

        const envKey = L25_PLAYER_MNEMONIC_ENV_KEYS[seatIndex];
        const words = normalizeMnemonic(env[envKey]);

        if (!words) {

            throw new L25TestError(
                `${envKey} is required for L.25 live E2E`,
                L25_ERROR_CODES.ENV_MISSING,
                { envKey }
            );

        }

        wallets.push(await derivePlayerWallet(seatIndex, words, env));

    }

    assertValidL25PlayerAddresses(
        wallets.map((wallet) => wallet.addressCanonical),
        env
    );

    const hasAnyExpected = L25_PLAYER_ADDRESS_ENV_KEYS.some(
        (key) => String(env[key] ?? "").trim()
    );

    if (requireExpectedAddresses || hasAnyExpected) {

        assertExpectedPlayerAddresses(wallets, env);

    }

    return Object.freeze(wallets);

}

/**
 * Public-only snapshot suitable for diagnostics / reports.
 */
export function toPublicPlayerSnapshot(wallets) {

    return Object.freeze(
        (wallets ?? []).map((wallet) => Object.freeze({
            seatIndex: wallet.seatIndex,
            label: wallet.label,
            address: wallet.address,
            addressCanonical: wallet.addressCanonical,
            rawAddressIdentity: wallet.rawAddressIdentity,
            walletContractType: wallet.walletContractType,
            keyDerivationMethod: wallet.keyDerivationMethod
        }))
    );

}
