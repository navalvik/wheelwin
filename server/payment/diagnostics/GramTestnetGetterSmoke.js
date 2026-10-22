/**
 * Explicit read-only Testnet GRAM getter diagnostic.
 * NO payment confirmation, no signing, no wallet private keys, no mutation.
 * Never prints API keys or full provider responses.
 */
import { ToncenterGramJettonGetMethodsClient } from "../toncenter/ToncenterGramJettonGetMethodsClient.js";
import { decodeGramMasterWalletAddressStack } from "../toncenter/GramJettonGetterStackDecoder.js";
import { inspectTestnetGramJettonWallet } from "../toncenter/GramJettonGetterBindingInspection.js";
import { requireGramJettonMaster } from "../incoming/GramJettonMasterConfig.js";
import { tonAddressIdentityOrNull } from "../incoming/TonAddressIdentity.js";

export async function runGramTestnetGetterSmoke({
    env = process.env, client, report = () => {}
} = {}) {
    // Validate required, public contract identities before any API traffic.
    const master = requireGramJettonMaster({ env, network: "testnet" });
    const owner = tonAddressIdentityOrNull(env?.GRAM_TESTNET_DIAGNOSTIC_OWNER);
    const key = env?.TON_API_KEY;
    if (!owner) throw new Error("GRAM_TESTNET_DIAGNOSTIC_OWNER must be a valid public TON address");
    if (typeof key !== "string" || !key.trim()) throw new Error("TON_API_KEY is required for the read-only diagnostic");
    const api = client ?? new ToncenterGramJettonGetMethodsClient({
        apiKeyProvider: () => key
    });
    if (!(api instanceof ToncenterGramJettonGetMethodsClient))
        throw new Error("Dedicated Testnet getter client required");

    // Derive from authoritative Master first. No Jetton Wallet address is
    // accepted from external caller or configured as an arbitrary override.
    const initial = await api.getWalletAddress({ jettonMaster: master, ownerWallet: owner });
    const derived = decodeGramMasterWalletAddressStack(initial).walletAddress;
    const consistency = await inspectTestnetGramJettonWallet({
        client: api, jettonMaster: master, ownerWallet: owner,
        observedJettonWallet: derived, env, network: "testnet"
    });
    if (!consistency || consistency.getterAddressesConsistent !== true ||
        consistency.paymentCreditAuthorized !== false) {
        throw new Error("Testnet GRAM master and wallet getters did not agree");
    }
    report("Testnet GRAM getter addresses agree (indexed observations only).");
    return Object.freeze({
        network: "testnet",
        getterAddressesConsistent: true,
        providerStateIndependentlyAuthenticated: false,
        transferFinalityVerified: false,
        paymentCreditAuthorized: false
    });
}
