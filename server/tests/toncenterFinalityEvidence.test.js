import assert from "node:assert/strict";
import {
    TONCENTER_TESTNET_BASE_URL,
    ToncenterFinalityEvidenceProvider,
    ToncenterIncomingProvider,
    RoomPaymentObservationService,
    hasTrustedRoomPaymentSettlementEvidence,
    ToncenterTransactionsClient
} from "../payment/toncenter/index.js";
import { assessTonPaymentSettlementEvidence } from "../payment/incoming/TonPaymentSettlementEvidence.js";

let assertions = 0;
function check(value, message) { assertions++; assert.ok(value, message); }
function equal(actual, expected, message) { assertions++; assert.equal(actual, expected, message); }

const account = `0:${"a".repeat(64)}`;
const otherAccount = `0:${"b".repeat(64)}`;
const apiKey = "test-api-key-that-must-not-leak";
const block = { workchain: 0, shard: "8000000000000000", seqno: 42 };

function fixture({ globalId = -3, acknowledge = true, preAckEvent = false, streamSilenceTimeoutMs = 2_000 } = {}) {
    let streamController;
    const requests = [];
    const client = new ToncenterTransactionsClient({
        baseUrl: TONCENTER_TESTNET_BASE_URL,
        apiKeyProvider: () => apiKey,
        fetchImpl: async (url, init) => {
            requests.push({ url, init });
            if (url.endsWith("/api/v3/masterchainInfo")) {
                return new Response(JSON.stringify({ last: { global_id: globalId, seqno: 123 } }), {
                    status: 200, headers: { "content-type": "application/json" }
                });
            }
            const body = new ReadableStream({
                start(controller) {
                    streamController = controller;
                    if (preAckEvent) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
                        type: "transactions", finality: "finalized", transactions: [transaction("late-tx")]
                    })}\n\n`));
                    if (acknowledge) controller.enqueue(new TextEncoder().encode('data: {"status":"subscribed"}\n\n'));
                }
            });
            return new Response(body, {
                status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }
            });
        }
    });
    const provider = new ToncenterFinalityEvidenceProvider({ client, evidenceWaitMs: 30, streamSilenceTimeoutMs });
    return {
        provider, requests,
        event(payload) { streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)); },
        close() { streamController.close(); }
    };
}

function transaction(hash, accountId = account, txBlock = block) {
    return { hash, account: accountId, block_ref: txBlock, mc_block_seqno: 123 };
}

const valid = fixture();
const session = await valid.provider.beginObservation({ accountId: account });
equal(valid.requests.length, 2, "masterchain identity then SSE subscription");
equal(valid.requests[0].url, `${TONCENTER_TESTNET_BASE_URL}/api/v3/masterchainInfo`, "identity endpoint is Testnet v3");
equal(valid.requests[1].url, `${TONCENTER_TESTNET_BASE_URL}/api/streaming/v2/sse`, "SSE endpoint is Testnet only");
equal(valid.requests[0].init.headers["X-API-Key"], apiKey, "existing API key header reused");
equal(valid.requests[1].init.headers["X-API-Key"], apiKey, "stream uses same API key header");
const subscription = JSON.parse(valid.requests[1].init.body);
equal(subscription.min_finality, "finalized", "subscription requests finalized events");
equal(subscription.types[0], "transactions", "subscription requests transaction events");
equal(subscription.addresses[0], account, "subscription is bound to expected account");

valid.event({ type: "transactions", finality: "finalized", transactions: [transaction("tx-1")] });
const evidence = await valid.provider.getSettlementEvidence({
    accountId: account, providerTransactionId: "tx-1", observationSession: session
});
check(evidence, "matching finalized transaction produces evidence");
check(assessTonPaymentSettlementEvidence(evidence, {
    accountId: account, transactionId: "tx-1", nowMs: Date.now()
}).authorized, "evidence satisfies private policy contract");
equal(evidence.transactionInclusion.block.seqno, 42, "actual inclusion block is retained");
equal(evidence.finality.masterchainSeqno, 123, "documented transaction masterchain sequence is bound directly");

valid.event({ type: "transactions", finality: "finalized", transactions: [transaction("tx-1")] });
const duplicate = await valid.provider.getSettlementEvidence({
    accountId: account, providerTransactionId: "tx-1", observationSession: session
});
equal(duplicate, evidence, "identical duplicate event is idempotent");
await valid.provider.endObservation(session);

for (const globalId of [-239, 0]) {
    const rejected = fixture({ globalId });
    await assert.rejects(rejected.provider.beginObservation({ accountId: account }), /identity/i);
    equal(rejected.requests.length, 1, "unknown or Mainnet identity rejects before opening stream");
}

const mismatch = fixture();
const mismatchSession = await mismatch.provider.beginObservation({ accountId: account });
mismatch.event({ type: "transactions", finality: "finalized", transactions: [transaction("other-tx")] });
equal(await mismatch.provider.getSettlementEvidence({
    accountId: account, providerTransactionId: "expected-tx", observationSession: mismatchSession
}), null, "incorrect transaction hash cannot authorize");
mismatch.event({ type: "transactions", finality: "finalized", transactions: [transaction("wrong-account-tx", otherAccount)] });
equal(await mismatch.provider.getSettlementEvidence({
    accountId: account, providerTransactionId: "wrong-account-tx", observationSession: mismatchSession
}), null, "incorrect account cannot authorize");
await mismatch.provider.endObservation(mismatchSession);

const unfinalized = fixture();
const unfinalizedSession = await unfinalized.provider.beginObservation({ accountId: account });
unfinalized.event({ type: "transactions", finality: "confirmed", transactions: [transaction("tx-confirmed")] });
equal(await unfinalized.provider.getSettlementEvidence({
    accountId: account, providerTransactionId: "tx-confirmed", observationSession: unfinalizedSession
}), null, "missing finalized semantics invalidate evidence window");
await unfinalized.provider.endObservation(unfinalizedSession);

const missingMcSeqno = fixture();
const missingMcSeqnoSession = await missingMcSeqno.provider.beginObservation({ accountId: account });
const txWithoutMcSeqno = transaction("tx-no-mc-seqno");
delete txWithoutMcSeqno.mc_block_seqno;
missingMcSeqno.event({ type: "transactions", finality: "finalized", transactions: [txWithoutMcSeqno] });
await new Promise((resolve) => setImmediate(resolve));
equal(await missingMcSeqno.provider.getSettlementEvidence({
    accountId: account, providerTransactionId: "tx-no-mc-seqno", observationSession: missingMcSeqnoSession
}), null, "missing documented masterchain sequence fails closed");
await missingMcSeqno.provider.endObservation(missingMcSeqnoSession);

const disconnect = fixture();
const disconnectSession = await disconnect.provider.beginObservation({ accountId: account });
disconnect.close();
await new Promise((resolve) => setImmediate(resolve));
equal(await disconnect.provider.getSettlementEvidence({
    accountId: account, providerTransactionId: "tx-after-gap", observationSession: disconnectSession
}), null, "disconnect invalidates evidence window without reconnect");

const gap = fixture({ streamSilenceTimeoutMs: 10 });
const gapSession = await gap.provider.beginObservation({ accountId: account });
await new Promise((resolve) => setTimeout(resolve, 20));
equal(await gap.provider.getSettlementEvidence({
    accountId: account, providerTransactionId: "tx-after-silent-gap", observationSession: gapSession
}), null, "silent SSE gap invalidates observation window");

const conflict = fixture();
const conflictSession = await conflict.provider.beginObservation({ accountId: account });
conflict.event({ type: "transactions", finality: "finalized", transactions: [transaction("tx-dup")] });
conflict.event({ type: "transactions", finality: "finalized", transactions: [transaction("tx-dup", account, { ...block, seqno: 43 })] });
await new Promise((resolve) => setImmediate(resolve));
equal(await conflict.provider.getSettlementEvidence({
    accountId: account, providerTransactionId: "tx-dup", observationSession: conflictSession
}), null, "conflicting duplicate inclusion invalidates ambiguous match");

const late = fixture({ preAckEvent: true });
await assert.rejects(late.provider.beginObservation({ accountId: account }), /before subscription acknowledgement/i);

const secretFailureClient = new ToncenterTransactionsClient({
    apiKeyProvider: () => apiKey,
    fetchImpl: async () => { throw new Error(apiKey); }
});
await assert.rejects(secretFailureClient.getMasterchainInfo(), (error) => {
    check(!JSON.stringify(error.toJSON()).includes(apiKey), "transport errors never expose the API key");
    return true;
});

check(!("signTransaction" in ToncenterFinalityEvidenceProvider.prototype), "provider has no signing operation");
check(!("broadcastTransaction" in ToncenterFinalityEvidenceProvider.prototype), "provider has no broadcast operation");
check(!("sendTransaction" in ToncenterTransactionsClient.prototype), "client has no transfer operation");
equal(valid.requests[0].init.headers["X-API-Key"], apiKey, "key is sent only as an HTTP header");

let integrationController;
const requestOrder = [];
const integrationClient = new ToncenterTransactionsClient({
    apiKeyProvider: () => apiKey,
    fetchImpl: async (url, init) => {
        requestOrder.push(new URL(url).pathname);
        if (url.endsWith("/api/v3/masterchainInfo")) {
            return new Response(JSON.stringify({ last: { global_id: -3, seqno: 500 } }), { status: 200 });
        }
        if (url.endsWith("/api/streaming/v2/sse")) {
            return new Response(new ReadableStream({
                start(controller) {
                    integrationController = controller;
                    controller.enqueue(new TextEncoder().encode('data: {"status":"subscribed"}\n\n'));
                }
            }), { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        return new Response(JSON.stringify({ transactions: [{
            hash: "tx-service", account,
            now: Math.floor(Date.now() / 1000),
            in_msg: {
                source: otherAccount, destination: account, value: "1000000000",
                message_content: { decoded: { type: "text_comment", comment: "" } }
            }
        }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
});
const integrationEvidence = new ToncenterFinalityEvidenceProvider({
    client: integrationClient, evidenceWaitMs: 100, streamSilenceTimeoutMs: 2_000
});
const observationService = new RoomPaymentObservationService({
    provider: new ToncenterIncomingProvider({ client: integrationClient }),
    settlementEvidenceProvider: integrationEvidence
});
const manualWindow = await observationService.beginSettlementEvidenceWindow({ walletAddress: account });
// Synthetic stand-in for the finalized event that would arrive after the
// operator initiates a Testnet payment while this explicit window is active.
integrationController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
    type: "transactions", finality: "finalized", transactions: [transaction("tx-service")]
})}\n\n`));
const second = Math.floor(Date.now() / 1000);
const observation = await observationService.checkRoomPayments({
    roomId: "room-finality-test", walletAddress: account, paymentIntents: [{
        network: "testnet", destinationWalletAddress: account,
        expectedSender: otherAccount, asset: "TON", amountAtomic: "1000000000"
    }],
    floorMs: (second - 2) * 1000, ceilingMs: (second + 2) * 1000,
    observationSession: manualWindow
});
equal(requestOrder.join(","), "/api/v3/masterchainInfo,/api/streaming/v2/sse,/api/v3/transactions",
    "service opens and acknowledges stream before its transaction snapshot");
equal(observation.settlementEvidenceAvailable, true, "service retains valid stream evidence on exact observed transaction");
check(hasTrustedRoomPaymentSettlementEvidence(observation, observation.transfers[0], Date.now()),
    "coordinator evidence gate accepts still-valid explicit stream session");
integrationController.close();
await new Promise((resolve) => setImmediate(resolve));
equal(hasTrustedRoomPaymentSettlementEvidence(observation, observation.transfers[0], Date.now()), false,
    "stream disconnect invalidates evidence before coordinator settlement");
await observationService.endSettlementEvidenceWindow(manualWindow);

console.log(`TON Center finality provider: ${assertions} assertions passed`);
