/**
 * Offline Testnet getter correlation. Never authenticates a provider's TVM
 * execution or authorizes GRAM transfers. Both methods are queried against
 * potentially different indexed states: do not treat their match as proof.
 */
import {
    decodeGramMasterWalletAddressStack,
    decodeGramWalletDataStack
} from "./GramJettonGetterStackDecoder.js";
import { inspectGramJettonMasterWalletBinding } from "./GramJettonMasterWalletBinding.js";
import { ToncenterGramJettonGetMethodsClient } from "./ToncenterGramJettonGetMethodsClient.js";

export async function inspectTestnetGramJettonWallet({
    client, jettonMaster, ownerWallet, observedJettonWallet
} = {}) {
    if (!(client instanceof ToncenterGramJettonGetMethodsClient))
        throw new Error("A dedicated Testnet getter client is required");
    // Decode and check the Master first; don't query a possibly malicious
    // Jetton Wallet contract until its derived identity matches the candidate.
    const masterRaw = await client.getWalletAddress({ jettonMaster, ownerWallet });
    const masterDecoded = decodeGramMasterWalletAddressStack(masterRaw);
    const preliminary = inspectGramJettonMasterWalletBinding({
        jettonMaster, ownerWallet, observedJettonWallet,
        masterGetter: {
            ...masterRaw,
            ownerArgument: ownerWallet,
            walletAddress: masterDecoded.walletAddress
        },
        walletGetter: {
            method: "get_wallet_data", exitCode: 0,
            contractAddress: observedJettonWallet,
            ownerAddress: ownerWallet,
            jettonMasterAddress: jettonMaster
        }
    });
    if (!preliminary) return null;
    const walletRaw = await client.getWalletData({ jettonWallet: observedJettonWallet });
    const walletDecoded = decodeGramWalletDataStack(walletRaw);
    return inspectGramJettonMasterWalletBinding({
        jettonMaster, ownerWallet, observedJettonWallet,
        masterGetter: {
            ...masterRaw,
            ownerArgument: ownerWallet,
            walletAddress: masterDecoded.walletAddress
        },
        walletGetter: {
            ...walletRaw,
            ownerAddress: walletDecoded.ownerAddress,
            jettonMasterAddress: walletDecoded.jettonMasterAddress
        }
    });
}
