import test from "node:test";
import assert from "node:assert/strict";
import { planLegacyRoomWalletRefund } from "../payment/refund/LegacyRefundPlanningBridge.js";
import { RefundObligation, createRefundObligationId } from "../payment/refund/RefundObligation.js";
const obligation = { networkName: "TESTNET", globalId: -3, state: "PENDING",
    roomNumber: 2, playerId: "bob", amountAtomic: 1000000000,
    refundDestination: "0:"+"a".repeat(64), payerAddress: "0:"+"a".repeat(64) };
test("durable refund maps to original planning shape without transfers", async () => {
    let called = 0;
    const result = await planLegacyRoomWalletRefund({obligation,settlement:{
        planRefunds: async request => {called++; assert.deepEqual(request,{
            roomNumber: 2, refunds: [{playerId:"bob",wallet:obligation.payerAddress,amountNano:1000000000n}]
        });return {ok:true};}
    }});
    assert.equal(called,1);assert.equal(result.ok,true);
});
test("refuses completed and misdirected refunds before planning", async () => {
    let called = 0;
    const settlement = {planRefunds: async () => {called++;}};
    assert.throws(() => planLegacyRoomWalletRefund({obligation:{...obligation,state:"COMPLETE"},settlement}));
    assert.throws(() => planLegacyRoomWalletRefund({obligation:{...obligation,refundDestination:"other"},settlement}));
    assert.throws(() => planLegacyRoomWalletRefund({obligation:{...obligation,networkName:"MAINNET"},settlement}));
    assert.equal(called,0);
});

const RAW_PAYER = "0:" + "9f1e2d3c4b5a69788796a5b4c3d2e1f0".repeat(2);
const EQ_PAYER = "EQCfHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8AKu";
const UQ_PAYER = "UQCfHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8F9r";
const KQ_PAYER = "kQCfHi08S1ppeIeWpbTD0uHwnx4tPEtaaXiHlqW0w9Lh8Lkk";

function durableAliasRefund() {
    const idempotencyKey = "TESTNET:alias-payment:alias-incoming";
    return {
        schemaVersion: 1,
        obligationId: createRefundObligationId(idempotencyKey),
        idempotencyKey,
        networkName: "TESTNET",
        globalId: -3,
        roomNumber: 2,
        roomId: "alias-room",
        playerId: "bob",
        paymentIntentId: "alias-payment",
        incomingTransactionId: "alias-incoming",
        amountAtomic: 1_000_000_000,
        denomination: "TON",
        payerAddress: EQ_PAYER,
        refundDestination: RAW_PAYER,
        closureReason: "setup_expired",
        createdAtMs: 1_800_000_000_000,
        state: "PENDING",
        attempts: [],
        outgoingTransactionId: null,
        finalizedEvidence: null,
        lastError: null
    };
}

test("equivalent TON payer aliases survive durable refund storage and planning", async () => {
    const obligation = RefundObligation.fromRecord(durableAliasRefund());
    const replay = RefundObligation.fromRecord(obligation.toRecord());
    let calls = 0;
    const result = await planLegacyRoomWalletRefund({
        obligation: replay,
        settlement: {
            async planRefunds({ roomNumber, refunds }) {
                calls++;
                assert.equal(roomNumber, 2);
                assert.deepEqual(refunds, [{
                    playerId: "bob", wallet: RAW_PAYER, amountNano: 1_000_000_000n
                }]);
                return { ok: true };
            }
        }
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);

    // The finality proof may use another valid display encoding of the
    // same account. It cannot authorize a different destination.
    const complete = RefundObligation.fromRecord({
        ...durableAliasRefund(),
        state: "COMPLETE",
        outgoingTransactionId: "outgoing-1",
        finalizedEvidence: {
            networkName: "TESTNET", globalId: -3,
            transactionId: "outgoing-1", amountAtomic: 1_000_000_000,
            destination: UQ_PAYER, finalized: true,
            observedAtMs: 1_800_000_000_100, blockId: "0:1:2"
        }
    });
    assert.equal(complete.state, "COMPLETE");
});

test("refund aliases reject invalid, different-account and different-workchain destinations", () => {
    const original = durableAliasRefund();
    const badDestinations = [
        "not-a-ton-address",
        "0:" + "f".repeat(64),
        "-1:" + RAW_PAYER.slice(2)
    ];
    for (const refundDestination of badDestinations) {
        assert.throws(() => RefundObligation.fromRecord({
            ...original, refundDestination
        }), /refund destination must match/);
    }
    assert.throws(() => RefundObligation.fromRecord({
        ...original, state: "COMPLETE",
        outgoingTransactionId: "outgoing-1",
        finalizedEvidence: {
            networkName: "TESTNET", globalId: -3,
            transactionId: "outgoing-1", amountAtomic: 1_000_000_000,
            destination: "0:" + "f".repeat(64),
            finalized: true, observedAtMs: 1_800_000_000_100, blockId: "0:1:2"
        }
    }), /finalized evidence does not match/);
    assert.doesNotThrow(() => RefundObligation.fromRecord({
        ...original, payerAddress: KQ_PAYER
    }));
});
