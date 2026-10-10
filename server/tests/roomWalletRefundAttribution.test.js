import assert from "node:assert/strict";
import test from "node:test";
import { beginCell } from "@ton/core";

import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";
import { buildPartialPaymentRefundTargets } from "../gameplay/partialPaymentEscrowUnwind.js";
import {
    PAYOUT_GAS_MODE,
    PAYOUT_GAS_POLICY_VERSION
} from "../payment/roomWallet/RoomWalletFinancialPolicy.js";
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import {
    confirmPayoutOnChain,
    extractMessageQueryId,
    extractOutboundTransfers
} from "../payment/roomWallet/roomWalletTerminalRecoveryChain.js";

const ROOM_WALLET = "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK";
const PLAYER_WALLET = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const NET_REFUND_NANO = 998_000_000n;

function makeBody(queryId = null) {
    const cell = queryId == null
        ? beginCell().endCell()
        : beginCell().storeUint(BigInt(queryId), 64).endCell();
    return cell.toBoc().toString("base64");
}

function matchingOutboundTx({ hash = "old-refund", queryId = null, utime = Math.floor(Date.now() / 1000) } = {}) {
    return {
        transaction_id: { hash, lt: "123456789" },
        utime,
        success: true,
        aborted: false,
        out_msgs: [{
            destination: PLAYER_WALLET,
            value: NET_REFUND_NANO.toString(),
            msg_data: { "@type": "msg.dataRaw", body: makeBody(queryId) }
        }]
    };
}

function legacyPlan({ playerId = "player-1", playerIndex = 0, wallet = PLAYER_WALLET } = {}) {
    return {
        mode: PAYOUT_GAS_MODE.RECIPIENT_PAYS_GAS,
        gasPolicyVersion: PAYOUT_GAS_POLICY_VERSION,
        feeSource: "estimateExternalMessageFee",
        marginBps: "2000",
        marginFloorNano: "1000000",
        entries: [{
            playerId,
            playerIndex,
            wallet,
            grossRefundNano: "1000000000",
            recipientGasChargeNano: "2000000",
            recipientTransferAmountNano: NET_REFUND_NANO.toString(),
            feeEvidence: {
                inFwdFeeNano: "400000",
                storageFeeNano: "100000",
                gasFeeNano: "300000",
                fwdFeeNano: "200000",
                totalNano: "1000000"
            }
        }]
    };
}

function makeSettlementAdapter({ sourceTransactions = [], playerTransactions = [] } = {}) {
    const sent = [];
    const roomWalletAdapter = {
        getGasReserveNano() {
            return 3_000_000n;
        },
        async getBalance() {
            return 100_000_000_000n;
        },
        async getWalletAddress() {
            return ROOM_WALLET;
        },
        async estimateOutboundTransferFee({ amountNano }) {
            return {
                ok: true,
                feeSource: "estimateExternalMessageFee",
                amountNano,
                inFwdFeeNano: 400_000n,
                storageFeeNano: 100_000n,
                gasFeeNano: 300_000n,
                fwdFeeNano: 200_000n,
                totalNano: 1_000_000n
            };
        },
        async getTransactions() {
            return sourceTransactions;
        },
        async getAddressTransactions() {
            return playerTransactions;
        },
        async sendTransfer(input) {
            sent.push(input);
            return {
                ok: true,
                code: "SENT",
                seqno: sent.length,
                txHash: "new-refund-" + sent.length
            };
        }
    };
    const adapter = new RoomWalletSettlementAdapter({
        roomWalletAdapter,
        confirmPayout: async ({ expectedHash, destination, amountNano }) => ({
            ok: true,
            hash: expectedHash,
            destination,
            amountNano
        })
    });
    return { adapter, sent };
}

test("refund queryId is stable across restoration and distinct across sessions", () => {
    const session = {
        roomId: "RGFT",
        paymentSessionId: "pay-test-stable",
        participants: [{
            playerId: "player-1",
            playerIndex: 0,
            wallet: PLAYER_WALLET,
            status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED,
            paidAmount: "1000000000"
        }]
    };
    const first = buildPartialPaymentRefundTargets(session).refunds[0].queryId;
    const restored = JSON.parse(JSON.stringify(session));
    const afterRestore = buildPartialPaymentRefundTargets(restored).refunds[0].queryId;
    const otherSession = {
        ...restored,
        paymentSessionId: "pay-test-other"
    };
    const other = buildPartialPaymentRefundTargets(otherSession).refunds[0].queryId;

    assert.match(first, /^\d+$/);
    assert.equal(BigInt(first) < (1n << 64n), true);
    assert.equal(afterRestore, first);
    assert.notEqual(other, first);
});

test("chain history parser extracts only an exact 64-bit message-body queryId", () => {
    const body = makeBody("1234567890123");
    assert.equal(extractMessageQueryId({ msg_data: { body } }), "1234567890123");
    assert.equal(extractMessageQueryId({ msg_data: { body: makeBody() } }), null);

    const transfers = extractOutboundTransfers(matchingOutboundTx({
        hash: "query-id-history",
        queryId: "1234567890123"
    }));
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].queryId, "1234567890123");
});

test("on-chain confirmation must not accept an otherwise matching transfer with a different queryId", async () => {
    const wrong = matchingOutboundTx({
        hash: "another-session",
        queryId: "111"
    });
    let clock = 0;
    const confirmed = await confirmPayoutOnChain({
        tonService: { async getTransactions() { return [wrong]; } },
        roomWalletAddress: ROOM_WALLET,
        expectedHash: null,
        destination: PLAYER_WALLET,
        amountNano: NET_REFUND_NANO,
        queryId: "222",
        timeoutMs: 2,
        pollIntervalMs: 2,
        now: () => clock,
        sleep: async (ms) => { clock += ms; }
    });

    assert.equal(confirmed.ok, false);
    assert.equal(confirmed.code, "PAYOUT_NOT_CONFIRMED");
});

test("on-chain confirmation selects the transfer with the exact queryId", async () => {
    const wrong = matchingOutboundTx({
        hash: "another-session",
        queryId: "111"
    });
    const right = matchingOutboundTx({
        hash: "current-session",
        queryId: "222",
        utime: Math.floor(Date.now() / 1000) + 1
    });
    const confirmed = await confirmPayoutOnChain({
        tonService: { async getTransactions() { return [wrong, right]; } },
        roomWalletAddress: ROOM_WALLET,
        expectedHash: null,
        destination: PLAYER_WALLET,
        amountNano: NET_REFUND_NANO,
        queryId: "222",
        timeoutMs: 50,
        pollIntervalMs: 1
    });

    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.hash, "current-session");
});

test("a same-amount transfer with a different queryId is not adopted for a new refund intent", async () => {
    const { adapter, sent } = makeSettlementAdapter({
        sourceTransactions: [matchingOutboundTx({
            hash: "another-intent-refund",
            queryId: "111"
        })]
    });

    const result = await adapter.refundPayments({
        roomNumber: 2,
        refundIntentId: "session-current",
        cutoffUtime: Date.now() - 10_000,
        refunds: [{
            playerId: "player-1",
            playerIndex: 0,
            wallet: PLAYER_WALLET,
            amount: 1,
            queryId: "222"
        }]
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].queryId, "222");
    assert.equal(result.ok, true);
    assert.equal(result.results[0].txHash, "new-refund-1");
});

test("a matching queryId is adopted even when second-level utime falls before the retry cutoff", async () => {
    const { adapter, sent } = makeSettlementAdapter({
        sourceTransactions: [matchingOutboundTx({
            hash: "same-intent-earlier-second",
            queryId: "222",
            utime: 1_700_000_000
        })]
    });

    const result = await adapter.refundPayments({
        roomNumber: 2,
        refundIntentId: "session-current",
        cutoffUtime: Date.now(),
        refunds: [{
            playerId: "player-1",
            playerIndex: 0,
            wallet: PLAYER_WALLET,
            amount: 1,
            queryId: "222"
        }]
    });

    assert.equal(sent.length, 0);
    assert.equal(result.ok, true);
    assert.equal(result.results[0].code, "REFUND_ADOPTED");
    assert.equal(result.results[0].txHash, "same-intent-earlier-second");
});

test("a legacy transaction hash already claimed by another session is not adopted or rebroadcast", async () => {
    const { adapter, sent } = makeSettlementAdapter({
        sourceTransactions: [matchingOutboundTx({ hash: "legacy-already-claimed" })]
    });

    const result = await adapter.refundPayments({
        roomNumber: 2,
        refundIntentId: "session-current",
        claimedRefunds: [{
            txHash: "legacy-already-claimed",
            intentId: "session-other",
            playerId: "player-1",
            playerIndex: 0,
            wallet: PLAYER_WALLET
        }],
        refundPlan: legacyPlan(),
        cutoffUtime: Date.now() - 10_000,
        refunds: [{
            playerId: "player-1",
            playerIndex: 0,
            wallet: PLAYER_WALLET,
            amount: 1,
            queryId: "222"
        }]
    });

    assert.equal(sent.length, 0);
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.results[0].code, "REFUND_TRANSACTION_ALREADY_CLAIMED");
});

test("a unique untagged historical transfer is not assigned to a session without queryId", async () => {
    const { adapter, sent } = makeSettlementAdapter({
        sourceTransactions: [matchingOutboundTx({ hash: "legacy-owner-unknown" })]
    });

    const result = await adapter.refundPayments({
        roomNumber: 2,
        refundIntentId: "session-current",
        refundPlan: legacyPlan(),
        cutoffUtime: Date.now() - 10_000,
        refunds: [{
            playerId: "player-1",
            playerIndex: 0,
            wallet: PLAYER_WALLET,
            amount: 1,
            queryId: "222"
        }]
    });

    assert.equal(sent.length, 0);
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.results[0].code, "LEGACY_REFUND_TRANSACTION_OWNER_UNPROVEN");
    assert.equal(result.results[0].txHash, "legacy-owner-unknown");
});

test("a legacy frozen refund plan with no matching chain evidence fails closed without a send", async () => {
    const { adapter, sent } = makeSettlementAdapter();

    const result = await adapter.refundPayments({
        roomNumber: 2,
        refundIntentId: "session-legacy",
        refundPlan: legacyPlan(),
        cutoffUtime: Date.now() - 10_000,
        refunds: [{
            playerId: "player-1",
            playerIndex: 0,
            wallet: PLAYER_WALLET,
            amount: 1,
            queryId: "222"
        }]
    });

    assert.equal(sent.length, 0);
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.results[0].code, "LEGACY_REFUND_NOT_FOUND_FAIL_CLOSED");
});

console.log("roomWalletRefundAttribution.test.js: OK");
