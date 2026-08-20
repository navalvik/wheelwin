/**
 * R17.9L.25.D — TEST-ONLY L25 player wallet derivation (W5R1 default).
 *
 * Reuses the repository's established W5R1 testnet parameters from
 * deriveTestnetDepositDeployerWalletIdentity.js. Never logs secrets.
 */

import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import {
    createTestnetDepositDeployerV5Wallet,
    deriveMultichainTonKeyPair,
    MULTICHAIN_MNEMONIC_WORD_COUNT,
    TESTNET_DEPOSIT_DEPLOYER_NETWORK_GLOBAL_ID,
    TESTNET_DEPOSIT_DEPLOYER_SUBWALLET_NUMBER,
    TESTNET_DEPOSIT_DEPLOYER_WALLET_CONTRACT_TYPE,
    TESTNET_DEPOSIT_DEPLOYER_WORKCHAIN
} from "../../../payment/ton/deriveTestnetDepositDeployerWalletIdentity.js";
import { L25_ERROR_CODES, L25TestError } from "./l25Errors.js";

export const L25_DEFAULT_PLAYER_WALLET_CONTRACT = "W5R1";

export const L25_PLAYER_WALLET_CONTRACT_TYPES = Object.freeze({
    W5R1: "W5R1",
    V4R2: "V4R2"
});

export const L25_KEY_DERIVATION_METHODS = Object.freeze({
    AUTO: "auto",
    TON_NATIVE: "ton_native",
    MULTICHAIN: "multichain"
});

export const L25_TON_NATIVE_MNEMONIC_WORD_COUNT = 24;

/**
 * Resolve wallet contract type from env. Default W5R1; V4R2 requires explicit opt-in.
 */
export function resolveL25PlayerWalletContract(env = process.env) {

    const raw = String(
        env.L25_PLAYER_WALLET_CONTRACT ?? L25_DEFAULT_PLAYER_WALLET_CONTRACT
    ).trim().toUpperCase();

    if (raw === "W5R1" || raw === "V5R1") {

        return L25_PLAYER_WALLET_CONTRACT_TYPES.W5R1;

    }

    if (raw === "V4R2" || raw === "V4") {

        return L25_PLAYER_WALLET_CONTRACT_TYPES.V4R2;

    }

    throw new L25TestError(
        `Unsupported L25_PLAYER_WALLET_CONTRACT: ${raw}`,
        L25_ERROR_CODES.WALLET_INVALID,
        { configured: raw }
    );

}

/**
 * Resolve key derivation method from env or mnemonic word count.
 */
export function resolveL25KeyDerivationMethod(words, env = process.env) {

    const configured = String(
        env.L25_PLAYER_KEY_DERIVATION ?? L25_KEY_DERIVATION_METHODS.AUTO
    ).trim().toLowerCase();

    if (configured === L25_KEY_DERIVATION_METHODS.TON_NATIVE) {

        return L25_KEY_DERIVATION_METHODS.TON_NATIVE;

    }

    if (configured === L25_KEY_DERIVATION_METHODS.MULTICHAIN) {

        return L25_KEY_DERIVATION_METHODS.MULTICHAIN;

    }

    if (configured !== L25_KEY_DERIVATION_METHODS.AUTO) {

        throw new L25TestError(
            `Unsupported L25_PLAYER_KEY_DERIVATION: ${configured}`,
            L25_ERROR_CODES.DERIVATION_UNCONFIRMED,
            { configured }
        );

    }

    if (words.length === MULTICHAIN_MNEMONIC_WORD_COUNT) {

        return L25_KEY_DERIVATION_METHODS.MULTICHAIN;

    }

    if (words.length === L25_TON_NATIVE_MNEMONIC_WORD_COUNT) {

        return L25_KEY_DERIVATION_METHODS.TON_NATIVE;

    }

    throw new L25TestError(
        "Unable to select L25 key derivation automatically for mnemonic word count",
        L25_ERROR_CODES.DERIVATION_UNCONFIRMED,
        { wordCount: words.length }
    );

}

/**
 * Derive key pair using an established repository derivation path only.
 *
 * @param {string[]} words
 * @param {object} env
 */
export async function deriveL25PlayerKeyPair(words, env = process.env) {

    const method = resolveL25KeyDerivationMethod(words, env);

    if (method === L25_KEY_DERIVATION_METHODS.MULTICHAIN) {

        if (words.length !== MULTICHAIN_MNEMONIC_WORD_COUNT) {

            throw new L25TestError(
                "Multichain derivation requires a 12-word mnemonic",
                L25_ERROR_CODES.DERIVATION_UNCONFIRMED,
                { wordCount: words.length, method }
            );

        }

        return Object.freeze({
            keyPair: await deriveMultichainTonKeyPair(words),
            keyDerivationMethod: L25_KEY_DERIVATION_METHODS.MULTICHAIN
        });

    }

    if (words.length < MULTICHAIN_MNEMONIC_WORD_COUNT) {

        throw new L25TestError(
            "TON-native derivation requires at least 12 words",
            L25_ERROR_CODES.DERIVATION_UNCONFIRMED,
            { wordCount: words.length, method }
        );

    }

    const keyPair = await mnemonicToPrivateKey(words);

    return Object.freeze({
        keyPair,
        keyDerivationMethod: L25_KEY_DERIVATION_METHODS.TON_NATIVE
    });

}

/**
 * Create a signable wallet contract for L25 player signing helpers.
 */
export function createL25PlayerWalletContract(publicKey, env = process.env) {

    const contract = resolveL25PlayerWalletContract(env);

    if (contract === L25_PLAYER_WALLET_CONTRACT_TYPES.V4R2) {

        const wallet = WalletContractV4.create({
            workchain: TESTNET_DEPOSIT_DEPLOYER_WORKCHAIN,
            publicKey
        });

        return Object.freeze({
            walletContractType: L25_PLAYER_WALLET_CONTRACT_TYPES.V4R2,
            wallet,
            networkGlobalId: null,
            subwalletNumber: null,
            walletId: wallet.walletId
        });

    }

    const wallet = createTestnetDepositDeployerV5Wallet(publicKey);

    return Object.freeze({
        walletContractType: TESTNET_DEPOSIT_DEPLOYER_WALLET_CONTRACT_TYPE,
        wallet,
        networkGlobalId: TESTNET_DEPOSIT_DEPLOYER_NETWORK_GLOBAL_ID,
        subwalletNumber: TESTNET_DEPOSIT_DEPLOYER_SUBWALLET_NUMBER,
        walletId: null
    });

}
