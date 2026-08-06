/**
 * R7.67B — Derive deployer WalletContractV4R2 identity from mnemonic.
 * Does not change wallet type. Never logs or returns the mnemonic/keys.
 */
import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

/** @ton/ton WalletContractV4 is V4R2. */
export const DEPLOYER_WALLET_CONTRACT_TYPE = "WalletContractV4R2";

export const DEPLOYER_WALLET_WORKCHAIN = 0;

/**
 * @param {{ mnemonic: string, network?: string|null }} params
 * @returns {Promise<{
 *   walletContractType: string,
 *   workchain: number,
 *   walletId: number,
 *   address: string,
 *   addressNonBounceable: string,
 *   network: string|null
 * }>}
 */
export async function deriveDeployerWalletIdentity({
    mnemonic,
    network = null
} = {}) {

    if (!mnemonic || typeof mnemonic !== "string" || !mnemonic.trim()) {

        throw new Error("TON_DEPLOYER_MNEMONIC is required to derive wallet identity");

    }

    const words = mnemonic.split(/\s+/).filter(Boolean);
    const keyPair = await mnemonicToPrivateKey(words);

    // Keep WalletContractV4 / V4R2 — do not change wallet type.
    const wallet = WalletContractV4.create({
        workchain: DEPLOYER_WALLET_WORKCHAIN,
        publicKey: keyPair.publicKey
    });

    return Object.freeze({
        walletContractType: DEPLOYER_WALLET_CONTRACT_TYPE,
        workchain: wallet.address.workChain,
        walletId: wallet.walletId,
        address: wallet.address.toString({
            bounceable: true,
            urlSafe: true
        }),
        addressNonBounceable: wallet.address.toString({
            bounceable: false,
            urlSafe: true
        }),
        network: network == null ? null : String(network)
    });

}
