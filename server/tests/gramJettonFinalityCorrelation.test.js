import assert from "node:assert/strict";
import { test } from "node:test";
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { ToncenterFinalityEvidenceProvider } from "../payment/toncenter/ToncenterFinalityEvidenceProvider.js";
import { correlateGramCandidateFinality } from "../payment/toncenter/GramJettonFinalityCorrelation.js";

const wallet = "0:" + "d".repeat(64);
const transactionHash = "a".repeat(64);
const session = Object.freeze({});
const candidate = Object.freeze({
    sourceJettonWallet: wallet,
    transactionHash,
    finalized: false,
    verifiedForSettlement: false,
    referenceHintMatched: true,
    paymentReference: null
});
const block = { workchain: 0, shard: "8000000000000000", seqno: 1337 };
function finalizedEvidence(override = {}) {
    return {
        networkIdentity: { network: "testnet", globalId: -3 },
        transactionInclusion: { transactionId: transactionHash, accountId: wallet, block },
        finality: {
            status: "finalized", source: "toncenter-streaming-v2",
            transactionId: transactionHash, accountId: wallet, block,
            masterchainSeqno: 1400
        },
        ...override
    };
}
function provider(evidence, valid = true) {
    const client = new ToncenterTransactionsClient({
        fetchImpl: async () => { throw Error("unexpected network request"); },
        apiKeyProvider: () => "test-key"
    });
    const instance = new ToncenterFinalityEvidenceProvider({ client });
    let seen = null;
    instance.isObservationValid = observed => observed === session && valid;
    instance.getSettlementEvidence = async args => {
        seen = args;
        return evidence;
    };
    return { instance, lastRequest: () => seen };
}
test("matching finalized source wallet transaction remains advisory, never credits GRAM", async () => {
    const p = provider(finalizedEvidence());
    const result = await correlateGramCandidateFinality({
        candidate, observationSession: session, finalityProvider: p.instance
    });
    assert.equal(p.lastRequest().accountId, wallet);
    assert.equal(p.lastRequest().providerTransactionId, transactionHash);
    assert.equal(result.sourceWalletTransactionFinalized, true);
    assert.equal(result.receivingJettonNotificationVerified, false);
    assert.equal(result.gramTransferVerified, false);
    assert.equal(result.paymentCreditAuthorized, false);
    assert.equal(result.kind, undefined);
    assert.equal(result.finalized, undefined);
});
test("wrong network, account, transaction, block and non-finalized events fail closed", async () => {
    const mutations = [
        { networkIdentity: { network: "mainnet", globalId: -239 } },
        { finality: { ...finalizedEvidence().finality, status: "confirmed" } },
        { finality: { ...finalizedEvidence().finality, accountId: "0:" + "f".repeat(64) } },
        { transactionInclusion: { ...finalizedEvidence().transactionInclusion, transactionId: "f".repeat(64) } },
        { finality: { ...finalizedEvidence().finality, block: { ...block, seqno: 999 } } },
        { finality: { ...finalizedEvidence().finality, masterchainSeqno: -1 } }
    ];
    for (const mutation of mutations) {
        const p = provider(finalizedEvidence(mutation));
        assert.equal(await correlateGramCandidateFinality({
            candidate, observationSession: session, finalityProvider: p.instance
        }), null);
    }
});
test("invalidated session, missing evidence and unverified indexer candidates cannot be promoted", async () => {
    assert.equal(await correlateGramCandidateFinality({
        candidate, observationSession: session, finalityProvider: provider(null).instance
    }), null);
    assert.equal(await correlateGramCandidateFinality({
        candidate, observationSession: session, finalityProvider: provider(finalizedEvidence(), false).instance
    }), null);
    for (const mutation of [
        { sourceJettonWallet: "invalid" },
        { finalized: true },
        { verifiedForSettlement: true },
        { referenceHintMatched: false },
        { paymentReference: "some-ref" },
        { transactionHash: "invalid" }
    ]) {
        await assert.rejects(correlateGramCandidateFinality({
            candidate: { ...candidate, ...mutation },
            observationSession: session,
            finalityProvider: provider(finalizedEvidence()).instance
        }), /unverified/);
    }
    await assert.rejects(correlateGramCandidateFinality({
        candidate, observationSession: session, finalityProvider: {}
    }), /real Testnet/);
});
