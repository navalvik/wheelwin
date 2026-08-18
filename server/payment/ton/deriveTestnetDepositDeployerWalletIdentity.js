/**
 * R17.9L.14D — Dedicated TESTNET Deposit deployer WalletContractV5R1 identity.
 *
 * Uses 12-word multichain BIP39 derivation (m/44'/607'/0') only.
 * Never reads TON_DEPLOYER_MNEMONIC. Never logs or returns mnemonic/keys.
 */
import crypto from "node:crypto";

import { deriveEd25519Path } from "@ton/crypto";
import { WalletContractV5R1 } from "@ton/ton";
import nacl from "tweetnacl";

export const TESTNET_DEPOSIT_DEPLOYER_WALLET_CONTRACT_TYPE = "WalletContractV5R1";

export const TESTNET_DEPOSIT_DEPLOYER_NETWORK_GLOBAL_ID = -3;

export const TESTNET_DEPOSIT_DEPLOYER_WORKCHAIN = 0;

export const TESTNET_DEPOSIT_DEPLOYER_SUBWALLET_NUMBER = 0;

export const TESTNET_DEPOSIT_DEPLOYER_STORED_WALLET_ID = 2147483645;

export const MULTICHAIN_MNEMONIC_WORD_COUNT = 12;

export const MULTICHAIN_TON_DERIVATION_PATH = Object.freeze([44, 607, 0]);

const BIP39_PBKDF2_ITERATIONS = 2048;

const BIP39_PBKDF2_SALT = "mnemonic";

function normalizeWords(mnemonic) {

    if (!mnemonic || typeof mnemonic !== "string") {

        return [];

    }

    return mnemonic.trim().split(/\s+/).filter(Boolean);

}

function deriveBip39Seed(normalizedMnemonic) {

    return crypto.pbkdf2Sync(
        normalizedMnemonic.normalize("NFKD"),
        BIP39_PBKDF2_SALT,
        BIP39_PBKDF2_ITERATIONS,
        64,
        "sha512"
    );

}

function formatTestnetAddress(address, { bounceable = false } = {}) {

    return address.toString({
        bounceable,
        urlSafe: true,
        testOnly: true
    });

}

/**
 * @param {string[]} words
 * @returns {Promise<{ publicKey: Buffer, secretKey: Buffer }>}
 */
export async function deriveMultichainTonKeyPair(words) {

    if (words.length !== MULTICHAIN_MNEMONIC_WORD_COUNT) {

        throw new Error(
            `Dedicated testnet deployer requires a ${MULTICHAIN_MNEMONIC_WORD_COUNT}-word multichain mnemonic`
        );

    }

    const seed = deriveBip39Seed(words.join(" "));
    const privateKeySeed = await deriveEd25519Path(seed, [...MULTICHAIN_TON_DERIVATION_PATH]);
    const keyPair = nacl.sign.keyPair.fromSeed(new Uint8Array(privateKeySeed));

    return {
        publicKey: Buffer.from(keyPair.publicKey),
        secretKey: Buffer.from(keyPair.secretKey)
    };

}

/**
 * @param {Buffer} publicKey
 * @returns {import("@ton/ton").WalletContractV5R1}
 */
export function createTestnetDepositDeployerV5Wallet(publicKey) {

    return WalletContractV5R1.create({
        publicKey,
        walletId: {
            networkGlobalId: TESTNET_DEPOSIT_DEPLOYER_NETWORK_GLOBAL_ID,
            context: {
                workchain: TESTNET_DEPOSIT_DEPLOYER_WORKCHAIN,
                walletVersion: "v5r1",
                subwalletNumber: TESTNET_DEPOSIT_DEPLOYER_SUBWALLET_NUMBER
            }
        }
    });

}

/**
 * @param {{ mnemonic: string, network?: string|null }} params
 */
export async function deriveTestnetDepositDeployerWalletIdentity({
    mnemonic,
    network = null
} = {}) {

    const words = normalizeWords(mnemonic);

    if (!words.length) {

        throw new Error("TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC is required");

    }

    const keyPair = await deriveMultichainTonKeyPair(words);
    const wallet = createTestnetDepositDeployerV5Wallet(keyPair.publicKey);

    return Object.freeze({
        walletContractType: TESTNET_DEPOSIT_DEPLOYER_WALLET_CONTRACT_TYPE,
        workchain: wallet.address.workChain,
        walletId: TESTNET_DEPOSIT_DEPLOYER_STORED_WALLET_ID,
        networkGlobalId: TESTNET_DEPOSIT_DEPLOYER_NETWORK_GLOBAL_ID,
        subwalletNumber: TESTNET_DEPOSIT_DEPLOYER_SUBWALLET_NUMBER,
        accountId: wallet.address.hash.toString("hex"),
        address: formatTestnetAddress(wallet.address, { bounceable: false }),
        addressNonBounceable: formatTestnetAddress(wallet.address, { bounceable: false }),
        addressBounceable: formatTestnetAddress(wallet.address, { bounceable: true }),
        network: network == null ? null : String(network)
    });

}

/**
 * Signing helper for dedicated testnet Deposit deployment only.
 * Never expose returned key material outside the signing path.
 *
 * @param {string} mnemonic
 */
export async function deriveTestnetDepositDeployerSigningWallet(mnemonic) {

    const words = normalizeWords(mnemonic);

    if (!words.length) {

        throw new Error("TON_TESTNET_DEPOSIT_DEPLOYER_MNEMONIC is required");

    }

    const keyPair = await deriveMultichainTonKeyPair(words);
    const wallet = createTestnetDepositDeployerV5Wallet(keyPair.publicKey);
    const identity = await deriveTestnetDepositDeployerWalletIdentity({ mnemonic });

    return Object.freeze({
        wallet,
        keyPair,
        identity
    });

}
