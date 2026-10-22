import assert from "node:assert/strict";
import { test } from "node:test";
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { ToncenterFinalityEvidenceProvider } from "../payment/toncenter/ToncenterFinalityEvidenceProvider.js";
import { correlateGramReceiverFinality } from "../payment/toncenter/GramJettonReceiverFinalityCorrelation.js";

const recipientJettonWallet = "0:" + "e".repeat(64);
const roomWallet = "0:" + "c".repeat(64);
const recipientTransactionHash = "f".repeat(64);
const session = Object.freeze({});
const block = { workchain: 0, shard: "8000000000000000", seqno: 111 };
const query = { recipientJettonWallet, roomWallet, recipientTransactionHash, observationSession: session };

function evidence(override = {}) {
    return {
        networkIdentity: { network: "testnet", globalId: -3 },
        transactionInclusion: { transactionId: recipientTransactionHash, accountId: recipientJettonWallet, block },
        finality: { status: "finalized", source: "toncenter-streaming-v2",
            transactionId: recipientTransactionHash, accountId: recipientJettonWallet,
            block, masterchainSeqno: 222 },
        ...override
    };
}
function provider(response, valid = true) {
    const client = new ToncenterTransactionsClient({
        apiKeyProvider: () => "test-key",
        fetchImpl: async () => { throw Error("no external network"); }
    });
    const result = new ToncenterFinalityEvidenceProvider({ client });
    const calls = [];
    result.isObservationValid = value => valid && value === session;
    result.getSettlementEvidence = async value => {
        calls.push(value);
        return response;
    };
    return { result, calls };
}

test("receiver finalized event remains ADVISORY, cannot authorize GRAM credit", async () => {
    const p = provider(evidence());
    const result = await correlateGramReceiverFinality({
        ...query, finalityProvider: p.result
    });
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].accountId, recipientJettonWallet);
    assert.equal(p.calls[0].providerTransactionId, recipientTransactionHash);
    assert.equal(result.recipientWalletTransactionFinalized, true);
    assert.equal(result.recipientTransferDecodedAndVerified, false);
    assert.equal(result.jettonWalletMasterOwnershipVerified, false);
    assert.equal(result.senderReceiverTraceLinked, false);
    assert.equal(result.gramTransferVerified, false);
    assert.equal(result.paymentCreditAuthorized, false);
    assert.equal(result.kind, undefined);
});

test("wrong receiver transaction, account, network, status or finalized block fails closed", async () => {
    for (const modification of [
        { networkIdentity: { network: "mainnet", globalId: -239 } },
        { transactionInclusion: { ...evidence().transactionInclusion, accountId: roomWallet } },
        { finality: { ...evidence().finality, transactionId: "b".repeat(64) } },
        { finality: { ...evidence().finality, status: "confirmed" } },
        { finality: { ...evidence().finality, block: { ...block, seqno: 123 } } }
    ]) {
        assert.equal(await correlateGramReceiverFinality({
            ...query, finalityProvider: provider(evidence(modification)).result
        }), null);
    }
});

test("missing finality, invalidated session, forged provider and malformed wallet rejected", async () => {
    assert.equal(await correlateGramReceiverFinality({
        ...query, finalityProvider: provider(null).result
    }), null);
    assert.equal(await correlateGramReceiverFinality({
        ...query, finalityProvider: provider(evidence(), false).result
    }), null);
    await assert.rejects(correlateGramReceiverFinality({
        ...query, recipientJettonWallet: roomWallet,
        finalityProvider: provider(evidence()).result
    }), /Invalid receiving/);
    await assert.rejects(correlateGramReceiverFinality({
        ...query, recipientTransactionHash: "fake", finalityProvider: provider(evidence()).result
    }), /Invalid receiving/);
    await assert.rejects(correlateGramReceiverFinality({
        ...query, finalityProvider: {}
    }), /real Testnet/);
});
