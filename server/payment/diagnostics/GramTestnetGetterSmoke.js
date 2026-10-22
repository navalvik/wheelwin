/**
 * Explicit read-only Testnet GRAM getter diagnostic.
 * NO payment confirmation, no signing, no wallet private keys, no mutation.
 * Never prints API keys or full provider responses.
 */
import { ToncenterGramJettonGetMethodsClient } from "../toncenter/ToncenterGramJettonGetMethodsClient.js";
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
    if (owner === tonAddressIdentityOrNull(master)) {
        throw new Error("Diagnostic owner cannot be the configured GRAM master");
    }
    // Toncenter Testnet v3 permits anonymous read-only calls at its public
    // rate limit. API keys remain required for the default payment client.
    const api = client ?? new ToncenterGramJettonGetMethodsClient({
        apiKeyProvider: () => key,
        allowAnonymousRead: true
    });
    if (!(api instanceof ToncenterGramJettonGetMethodsClient))
        throw new Error("Dedicated Testnet getter client required");

    // Getter inspection obtains the derived wallet directly from the pinned
    // Master and checks the receiver wallet. Exactly TWO read-only requests.
    const consistency = await inspectTestnetGramJettonWallet({
        client: api, jettonMaster: master, ownerWallet: owner,
        env, network: "testnet"
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
