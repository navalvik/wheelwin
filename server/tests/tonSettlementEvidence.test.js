import assert from "node:assert/strict";

import {
    TON_SETTLEMENT_EVIDENCE_POLICY,
    assessTonPaymentSettlementEvidence
} from "../payment/toncenter/index.js";

const nowMs = 1_700_000_000_000;
const context = {
    transactionId: "raw-transaction-hash",
    accountId: "0:room-wallet",
    nowMs
};

function validEvidence() {
    const block = { workchain: 0, shard: "8000000000000000", seqno: 10 };
    return {
        networkIdentity: {
            network: "testnet",
            globalId: -3,
            source: "toncenter-masterchain-info",
            observedAtMs: nowMs
        },
        transactionInclusion: {
            transactionId: context.transactionId,
            accountId: context.accountId,
            block
        },
        finality: {
            status: "finalized",
            source: "toncenter-streaming-v2",
            transactionId: context.transactionId,
            accountId: context.accountId,
            block,
            masterchainSeqno: 11,
            observedAtMs: nowMs
        }
    };
}

let assertions = 0;
function authorized(evidence, expected, message) {
    assert.equal(
        assessTonPaymentSettlementEvidence(evidence, context).authorized,
        expected,
        message
    );
    assertions += 1;
}

const valid = validEvidence();
authorized(valid, true, "documented Testnet finalized evidence satisfies policy");
authorized({ ...valid, networkIdentity: undefined }, false, "missing network identity fails closed");
authorized({
    ...valid,
    networkIdentity: { ...valid.networkIdentity, globalId: -239, network: "mainnet" }
}, false, "Mainnet identity is rejected");
authorized({
    ...valid,
    networkIdentity: { ...valid.networkIdentity, globalId: 1234, network: "unknown" }
}, false, "unknown network identity is rejected");
authorized({ ...valid, finality: undefined }, false, "missing finality is rejected");
authorized({ confirmed: true }, false, "self-asserted confirmed flag is not evidence");
authorized({
    ...valid,
    transactionInclusion: { ...valid.transactionInclusion, transactionId: "other" }
}, false, "contradictory transaction identity is rejected");
authorized({
    ...valid,
    transactionInclusion: { ...valid.transactionInclusion, accountId: "other" }
}, false, "inclusion for another account is rejected");
authorized({
    ...valid,
    finality: { ...valid.finality, status: "confirmed" }
}, false, "confirmed but not finalized is rejected");
authorized({
    ...valid,
    finality: { ...valid.finality, block: { ...valid.transactionInclusion.block, seqno: 12 } }
}, false, "finality for another block is contradictory");
authorized({
    ...valid,
    finality: { ...valid.finality, observedAtMs: nowMs - TON_SETTLEMENT_EVIDENCE_POLICY.maxAgeMs - 1 }
}, false, "stale finality evidence is rejected");
authorized({
    ...valid,
    networkIdentity: { ...valid.networkIdentity, observedAtMs: nowMs + 1 }
}, false, "future-dated network evidence is rejected");

process.stdout.write(`PASS ${assertions} TON settlement evidence assertions\n`);
