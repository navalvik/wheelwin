import assert from "node:assert/strict";
import test from "node:test";

import { beginCell } from "@ton/core";

import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";
import { buildPartialPaymentRefundTargets } from "../gameplay/partialPaymentEscrowUnwind.js";
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import {
    extractInbound,
    extractOutboundTransfers,
    extractMessageQueryId
} from "../payment/roomWallet/roomWalletTerminalRecoveryChain.js";

const ROOM_WALLET = "EQDGQjwaP0OSExa9MfZih61De5TQuUITQPYiYZyfqAFzpvQB";
const PLAYER_WALLET = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const GROSS_NANO = 1_000_000_000n;

function makeBody(queryId) {
    return beginCell().storeUint(BigInt(queryId), 64).endCell().toBoc().toString("base64");
}

function makeSession(paymentSessionId) {
    return {
        paymentSessionId,
        participants: [{
            playerId: "player-1",
            playerIndex: 0,
            wallet: PLAYER_WALLET,
            status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED,
            paidAmount: 1
        }]
    };
}

function makeTaggedTransfer({ hash, destination, amountNano, queryId, utime = Math.floor(Date.now() / 1000) }) {
    return {
        transaction_id: { hash },
        utime,
        success: true,
        out_msgs: [{
            destination,
            value: String(amountNano),
            msg_data: { "@type": "msg.dataRaw", body: makeBody(queryId) }
        }]
    };
}

function makeAdapter({ queryTransactions = [] } = {}) {
    const calls = [];
    let transactions = queryTransactions;
    const roomWalletAdapter = {
        async getBalance() {
            return 100n * GROSS_NANO;
        },
        async estimateOutboundTransferFee({ amountNano }) {
            return {
                ok: true,
                feeSource: "estimateExternalMessageFee",
                amountNano,
                inFwdFeeNano: 100_000n,
                storageFeeNano: 100_000n,
                gasFeeNano: 300_000n,
                fwdFeeNano: 500_000n,
                totalNano: 1_000_000n
            };
        },
        async getWalletAddress() {
            return ROOM_WALLET;
        },
        async getTransactions() {
            return transactions;
        },
        async getAddressTransactions() {
            return [];
        },
        async sendTransfer(input) {
            calls.push(input);
            // Mirror a successful send into the mocked source-wallet history so
            // the production confirmation helper can independently observe it.
            transactions = [
                ...transactions,
                makeTaggedTransfer({
                    hash: "new-refund-tx",
                    destination: input.destination,
                    amountNano: input.amountNano,
                    queryId: input.queryId
                })
            ];
            return { ok: true, code: "SENT", txHash: "new-refund-tx", seqno: 7 };
        }
    };
    const adapter = new RoomWalletSettlementAdapter({
        roomWalletAdapter,
        confirmPayout: async ({ expectedHash, destination, amountNano, queryId }) => ({
            ok: true,
            hash: expectedHash ?? "confirmed-refund-tx",
            destination,
            amountNano,
            queryId
        })
    });
    return {
        adapter,
        calls,
        setTransactions(next) { transactions = next; }
    };
}

test("refund query IDs are stable per session and seat, and fit uint64", () => {
    const targetA = buildPartialPaymentRefundTargets(makeSession("pay-session-a")).refunds[0];
    const targetARepeat = buildPartialPaymentRefundTargets(makeSession("pay-session-a")).refunds[0];
    const targetB = buildPartialPaymentRefundTargets(makeSession("pay-session-b")).refunds[0];

    assert.equal(targetA.queryId, targetARepeat.queryId);
    assert.notEqual(targetA.queryId, targetB.queryId);
    assert.match(targetA.queryId, /^\d+$/);
    assert.ok(BigInt(targetA.queryId) >= 0n);
    assert.ok(BigInt(targetA.queryId) <= 0xffffffffffffffffn);
});

test("TON transaction message query IDs are parsed from BOC for inbound/outbound history", () => {
    const queryId = "18446744073709551615";
    const body = makeBody(queryId);
    const message = { msg_data: { body } };

    assert.equal(extractMessageQueryId(message), queryId);
    assert.equal(extractMessageQueryId({ msg_data: { body: beginCell().endCell().toBoc().toString("base64") } }), null);
    assert.equal(extractMessageQueryId({ msg_data: { body: "not-a-boc" } }), null);

    const outbound = extractOutboundTransfers({
        transaction_id: { hash: "outbound-hash" },
        utime: 1_800_000_000,
        out_msgs: [{ destination: PLAYER_WALLET, value: String(GROSS_NANO), msg_data: { body } }]
    });
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].queryId, queryId);

    const inbound = extractInbound({
        transaction_id: { hash: "inbound-hash" },
        utime: 1_800_000_000,
        in_msg: { source: ROOM_WALLET, value: String(GROSS_NANO), msg_data: { body } }
    });
    assert.equal(inbound.queryId, queryId);
});

test("same destination and amount with a different query ID is not adopted", async () => {
    const target = buildPartialPaymentRefundTargets(makeSession("pay-current")).refunds[0];
    const { adapter, calls, setTransactions } = makeAdapter();

    const planResult = await adapter.planRefunds({ roomNumber: 7, refunds: [target] });
    assert.equal(planResult.ok, true);
    const entry = planResult.refundPlan.entries[0];
    assert.equal(entry.queryId, target.queryId);

    setTransactions([makeTaggedTransfer({
        hash: "old-other-refund",
        destination: PLAYER_WALLET,
        amountNano: entry.recipientTransferAmountNano,
        queryId: buildPartialPaymentRefundTargets(makeSession("pay-other")).refunds[0].queryId
    })]);

    const result = await adapter.refundPayments({
        roomNumber: 7,
        paymentSessionId: "pay-current",
        refunds: [target],
        refundPlan: planResult.refundPlan,
        cutoffUtime: Date.now() - 5_000
    });

    assert.equal(result.ok, true);
    assert.equal(result.results[0].code, "REFUND_CONFIRMED");
    assert.equal(calls.length, 1, "a different refund identity must not suppress this participant's refund");
    assert.equal(String(calls[0].queryId), target.queryId);
});

test("an existing transfer with the exact query ID is adopted without a second send", async () => {
    const target = buildPartialPaymentRefundTargets(makeSession("pay-current-match")).refunds[0];
    const { adapter, calls, setTransactions } = makeAdapter();

    const planResult = await adapter.planRefunds({ roomNumber: 7, refunds: [target] });
    assert.equal(planResult.ok, true);
    const entry = planResult.refundPlan.entries[0];

    setTransactions([makeTaggedTransfer({
        hash: "already-paid-refund",
        destination: PLAYER_WALLET,
        amountNano: entry.recipientTransferAmountNano,
        queryId: target.queryId
    })]);

    const result = await adapter.refundPayments({
        roomNumber: 7,
        paymentSessionId: "pay-current-match",
        refunds: [target],
        refundPlan: planResult.refundPlan,
        cutoffUtime: Date.now() - 5_000
    });

    assert.equal(result.ok, true);
    assert.equal(result.results[0].code, "REFUND_ADOPTED");
    assert.equal(result.results[0].txHash, "already-paid-refund");
    assert.equal(calls.length, 0);
});
