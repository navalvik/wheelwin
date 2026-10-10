import assert from "node:assert/strict";
import test from "node:test";
import { beginCell } from "@ton/core";

import { buildPartialPaymentRefundTargets } from "../gameplay/partialPaymentEscrowUnwind.js";
import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import { confirmPayoutOnChain, extractOutboundTransfers } from "../payment/roomWallet/roomWalletTerminalRecoveryChain.js";

const ROOM_WALLET = "EQDGQjwaP0OSExa9MfZih61De5TQuUITQPYiYZyfqAFzpvQB";
const PLAYER_WALLET = "EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM";
const GROSS_NANO = 1_000_000_000n;
const GAS_CHARGE_NANO = 2_000_000n;
const NET_NANO = GROSS_NANO - GAS_CHARGE_NANO;

function bodyFor(queryId) {
    return beginCell().storeUint(BigInt(queryId), 64).endCell().toBoc().toString("base64");
}

function transaction({ hash, destination, value, queryId = null, utime = Math.floor(Date.now() / 1000) }) {
    const message = {
        destination,
        value: String(value),
        msg_data: { "@type": "msg.dataRaw", body: queryId == null
            ? beginCell().endCell().toBoc().toString("base64")
            : bodyFor(queryId) }
    };
    return {
        transaction_id: { hash },
        utime,
        success: true,
        aborted: false,
        out_msgs: [message]
    };
}

function playerTransaction({ hash, source, value, queryId = null, utime = Math.floor(Date.now() / 1000) }) {
    return {
        transaction_id: { hash },
        utime,
        success: true,
        aborted: false,
        in_msg: {
            source,
            value: String(value),
            msg_data: { "@type": "msg.dataRaw", body: queryId == null
                ? beginCell().endCell().toBoc().toString("base64")
                : bodyFor(queryId) }
        }
    };
}

function createHarness({ sourceHistory = [], playerHistory = [] } = {}) {
    const sends = [];
    const roomWalletAdapter = {
        async estimateOutboundTransferFee({ amountNano, queryId }) {
            return {
                ok: true,
                feeSource: "estimateExternalMessageFee",
                amountNano,
                queryId,
                inFwdFeeNano: 400_000n,
                storageFeeNano: 100_000n,
                gasFeeNano: 300_000n,
                fwdFeeNano: 200_000n,
                totalNano: 1_000_000n
            };
        },
        async getBalance() { return 100_000_000_000n; },
        async canFundTransfer() { return { ok: true, balanceNano: 100_000_000_000n, requiredNano: 1n, shortfallNano: 0n }; },
        async getWalletAddress() { return ROOM_WALLET; },
        async getTransactions() { return sourceHistory; },
        async getAddressTransactions() { return playerHistory; },
        async sendTransfer(input) {
            sends.push(input);
            const hash = "new-refund-" + sends.length;
            const tx = transaction({ hash, destination: input.destination, value: input.amountNano, queryId: input.queryId });
            sourceHistory.unshift(tx);
            playerHistory.unshift(playerTransaction({
                hash: "player-" + hash,
                source: ROOM_WALLET,
                value: input.amountNano,
                queryId: input.queryId
            }));
            return { ok: true, code: "SENT", txHash: hash, amountNano: input.amountNano, destination: input.destination };
        }
    };
    return {
        adapter: new RoomWalletSettlementAdapter({ roomWalletAdapter }),
        sends,
        sourceHistory,
        playerHistory
    };
}

function refundTarget(queryId) {
    return {
        playerId: "player-1",
        playerIndex: 0,
        wallet: PLAYER_WALLET,
        queryId: String(queryId),
        amount: 1
    };
}

test("refund targets carry deterministic session-and-seat query IDs", () => {
    const base = {
        paymentSessionId: "pay-A",
        roomId: "room-A",
        createdAt: 100,
        participants: [{
            playerId: "player-1",
            playerIndex: 0,
            wallet: PLAYER_WALLET,
            status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED,
            paidAmount: 1,
            requiredGram: 1
        }]
    };
    const first = buildPartialPaymentRefundTargets(base).refunds[0].queryId;
    const second = buildPartialPaymentRefundTargets(base).refunds[0].queryId;
    const otherSession = buildPartialPaymentRefundTargets({
        ...base,
        paymentSessionId: "pay-B"
    }).refunds[0].queryId;

    assert.match(first, /^[0-9]+$/);
    assert.ok(BigInt(first) >= 0n && BigInt(first) < (1n << 64n));
    assert.equal(first, second);
    assert.notEqual(first, otherSession);
});

test("extracts the 64-bit query ID from a TON outbound message body", () => {
    const [transfer] = extractOutboundTransfers(transaction({
        hash: "tx-query-id",
        destination: PLAYER_WALLET,
        value: NET_NANO,
        queryId: "12345"
    }));
    assert.equal(transfer.queryId, "12345");
});

test("adopts a refund only when its session-scoped query ID matches", async () => {
    const sourceHistory = [transaction({
        hash: "same-session-refund",
        destination: PLAYER_WALLET,
        value: NET_NANO,
        queryId: "123"
    })];
    const harness = createHarness({ sourceHistory });
    const result = await harness.adapter.refundPayments({
        roomNumber: 1,
        cutoffUtime: Date.now() - 5_000,
        refunds: [refundTarget("123")]
    });

    assert.equal(result.ok, true);
    assert.equal(result.results[0].code, "REFUND_ADOPTED");
    assert.equal(result.results[0].txHash, "same-session-refund");
    assert.equal(harness.sends.length, 0);
});

test("blocks an untagged legacy lookalike instead of risking a duplicate refund", async () => {
    const cutoff = Math.floor(Date.now() / 1000) - 5;
    const sourceHistory = [transaction({
        hash: "legacy-lookalike",
        destination: PLAYER_WALLET,
        value: NET_NANO,
        utime: cutoff + 1
    })];
    const playerHistory = [playerTransaction({
        hash: "legacy-player-inbound",
        source: ROOM_WALLET,
        value: NET_NANO,
        utime: cutoff + 1
    })];
    const harness = createHarness({ sourceHistory, playerHistory });
    const result = await harness.adapter.refundPayments({
        roomNumber: 1,
        cutoffUtime: Date.now() - 5_000,
        refunds: [refundTarget("222")]
    });

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.results[0].code, "REFUND_IDEMPOTENCY_AMBIGUOUS");
    assert.equal(result.results[0].reason, "LEGACY_UNTAGGED_MATCH");
    assert.equal(harness.sends.length, 0);
});

test("does not misattribute another session's tagged transfer", async () => {
    const sourceHistory = [transaction({
        hash: "other-session-refund",
        destination: PLAYER_WALLET,
        value: NET_NANO,
        queryId: "100"
    })];
    const playerHistory = [playerTransaction({
        hash: "other-session-player-inbound",
        source: ROOM_WALLET,
        value: NET_NANO,
        queryId: "100"
    })];
    const harness = createHarness({ sourceHistory, playerHistory });
    const result = await harness.adapter.refundPayments({
        roomNumber: 1,
        cutoffUtime: Date.now() - 5_000,
        refunds: [refundTarget("200")]
    });

    assert.equal(result.ok, true);
    assert.equal(result.results[0].code, "REFUND_CONFIRMED");
    assert.equal(harness.sends.length, 1);
    assert.equal(harness.sends[0].queryId, "200");
    assert.equal(result.refundPlan.entries[0].queryId, "200");
});

test("confirmation with an unknown broadcast hash still requires the exact query ID", async () => {
    const transactions = [
        transaction({
            hash: "other-session-first",
            destination: PLAYER_WALLET,
            value: NET_NANO,
            queryId: "100"
        }),
        transaction({
            hash: "target-session-second",
            destination: PLAYER_WALLET,
            value: NET_NANO,
            queryId: "200"
        })
    ];
    const confirmed = await confirmPayoutOnChain({
        tonService: {
            async getTransactions() { return transactions; }
        },
        roomWalletAddress: ROOM_WALLET,
        expectedHash: null,
        expectedQueryId: "200",
        destination: PLAYER_WALLET,
        amountNano: NET_NANO,
        timeoutMs: 100,
        pollIntervalMs: 0
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.hash, "target-session-second");
});
