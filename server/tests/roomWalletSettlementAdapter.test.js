import assert from "node:assert/strict";
import test from "node:test";

import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import { GRAM_NANO } from "../payment/roomWallet/RoomWalletFinancialPolicy.js";

// Deterministic recipient-pays-gas stub estimate shared by every mock room
// wallet adapter in this file. Components sum exactly to STUB_FEE_TOTAL_NANO.
// Default policy margin (20%, floor 1000000) -> recipient gas charge is
// STUB_GAS_CHARGE_NANO, so the on-chain transfer value is gross - 2000000n.
const STUB_FEE_TOTAL_NANO = 1_000_000n;
const STUB_GAS_CHARGE_NANO = 2_000_000n;

function createAdapter({
    balanceNano = 100n * GRAM_NANO,
    sendTransfer = null,
    inspectHistory = null,
    getWalletAddress = null,
    getTransactions = null,
    getAddressTransactions = null,
    logger = null
} = {}) {
    const calls = [];
    const balanceCalls = [];
    const gasReserveNano = 3_000_000n;
    const roomWalletAdapter = {
        getGasReserveNano() {
            return gasReserveNano;
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
                totalNano: STUB_FEE_TOTAL_NANO
            };
        },
        async getBalance(roomNumber) {
            balanceCalls.push(roomNumber);
            return balanceNano;
        },
        async canFundTransfer({ amountNano }) {
            return {
                ok: balanceNano >= amountNano + gasReserveNano,
                balanceNano,
                requiredNano: amountNano + gasReserveNano,
                shortfallNano: balanceNano >= amountNano + gasReserveNano
                    ? 0n
                    : amountNano + gasReserveNano - balanceNano
            };
        },
        async sendTransfer(input) {
            calls.push(input);
            if (typeof sendTransfer === "function") {
                return sendTransfer(input, calls);
            }
            return {
                ok: true,
                code: "SENT",
                txHash: `tx-${calls.length}`
            };
        },
        ...(typeof getWalletAddress === "function" ? { getWalletAddress } : {}),
        ...(typeof getTransactions === "function" ? { getTransactions } : {}),
        ...(typeof getAddressTransactions === "function" ? { getAddressTransactions } : {})
    };

    return {
        adapter: new RoomWalletSettlementAdapter({
            roomWalletAdapter,
            ...(inspectHistory ? { inspectHistory } : {}),
            ...(logger ? { logger } : {})
        }),
        calls,
        balanceCalls,
        gasReserveNano
    };
}

test("owner payout retains exactly 0.01 Gram from owner gross share", async () => {
    const { adapter, calls, balanceCalls } = createAdapter();

    const result = await adapter.settleContract({
        gameId: "game-1",
        roomNumber: "01",
        winnerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        ownerWallet: "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        prizeAmountNano: 9_500_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(result.ok, true);
    assert.equal(result.roomNumber, 1);
    assert.equal(result.ownerGrossNano, 150_000_000n);
    assert.equal(result.ownerPayoutNano, 140_000_000n);
    assert.equal(result.ownerRetainedNano, 10_000_000n);
    assert.equal(calls.length, 2);
    // RECIPIENT_PAYS_GAS: on-chain transfer value is gross minus the frozen
    // recipient gas charge (stub estimate 1000000 + 20%/floor margin 1000000).
    assert.equal(calls[0].amountNano, 9_500_000_000n - STUB_GAS_CHARGE_NANO);
    assert.equal(calls[1].amountNano, 140_000_000n - STUB_GAS_CHARGE_NANO);
    assert.equal(result.winnerTransfer.recipientCreditNano, 9_500_000_000n - STUB_GAS_CHARGE_NANO);
    assert.equal(result.winnerTransfer.gasNano, STUB_FEE_TOTAL_NANO);
    assert.equal(
        result.winnerTransfer.sourceDebitNano,
        9_500_000_000n - STUB_GAS_CHARGE_NANO + STUB_FEE_TOTAL_NANO
    );
    assert.equal(result.ownerTransfer.recipientCreditNano, 140_000_000n - STUB_GAS_CHARGE_NANO);
    assert.equal(result.ownerTransfer.gasNano, STUB_FEE_TOTAL_NANO);
    assert.equal(
        result.ownerTransfer.sourceDebitNano,
        140_000_000n - STUB_GAS_CHARGE_NANO + STUB_FEE_TOTAL_NANO
    );
    assert.deepEqual(balanceCalls, [1]);
});

test("owner payout preserves the existing gross share when it is above the minimum", async () => {
    const { adapter, calls } = createAdapter();

    const result = await adapter.settleContract({
        gameId: "game-2",
        roomNumber: "02",
        winnerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        ownerWallet: "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        prizeAmountNano: 95_000_000_000n,
        organizerAmountNano: 5_000_000_000n
    });

    assert.equal(result.ok, true);
    assert.equal(result.ownerPayoutNano, 4_990_000_000n);
    assert.equal(result.ownerRetainedNano, 10_000_000n);
    // Owner net transfer = gross share - retention - recipient gas charge.
    assert.equal(calls[1].amountNano, 4_990_000_000n - STUB_GAS_CHARGE_NANO);
});

test("settlement does not send anything when the Room Wallet cannot fund the payout plus gas reserve", async () => {
    const { adapter, calls, balanceCalls } = createAdapter({ balanceNano: 100_000_000n });

    const result = await adapter.settleContract({
        gameId: "game-3",
        roomNumber: "03",
        winnerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        ownerWallet: "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        prizeAmountNano: 95_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "INSUFFICIENT_ROOM_WALLET_BALANCE");
    assert.equal(calls.length, 0);
    assert.equal(result.preflight.ok, false);
    assert.equal(result.preflight.balanceNano, 100_000_000n);
    // Preflight now gates the NET recipient transfers plus the fee budget.
    assert.equal(result.preflight.winner.amountNano, 95_000_000n - STUB_GAS_CHARGE_NANO);
    assert.equal(result.preflight.owner.amountNano, 140_000_000n - STUB_GAS_CHARGE_NANO);
    assert.equal(result.preflight.totalGasReserveNano, STUB_FEE_TOTAL_NANO * 2n);
    assert.deepEqual(balanceCalls, [3]);
});

test("preflight uses getBalance and requires net payouts plus estimated source fee budget", async () => {
    const { adapter } = createAdapter({ balanceNano: 100n * GRAM_NANO });

    const preflight = await adapter.preflight({
        gameId: "game-4",
        roomNumber: "04",
        winnerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        ownerWallet: "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        prizeAmountNano: 9_500_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(preflight.ok, true);
    assert.equal(preflight.balanceNano, 100n * GRAM_NANO);
    assert.equal(preflight.winner.grossPayoutNano, 9_500_000_000n);
    assert.equal(preflight.winner.amountNano, 9_500_000_000n - STUB_GAS_CHARGE_NANO);
    assert.equal(preflight.winner.recipientGasChargeNano, STUB_GAS_CHARGE_NANO);
    assert.equal(preflight.winner.feeBudgetNano, STUB_FEE_TOTAL_NANO);
    assert.equal(preflight.owner.grossPayoutNano, 140_000_000n);
    assert.equal(preflight.owner.amountNano, 140_000_000n - STUB_GAS_CHARGE_NANO);
    assert.equal(preflight.owner.retainedNano, 10_000_000n);
    assert.equal(
        preflight.totalPayoutNano,
        9_500_000_000n - STUB_GAS_CHARGE_NANO + 140_000_000n - STUB_GAS_CHARGE_NANO
    );
    assert.equal(preflight.totalGasReserveNano, STUB_FEE_TOTAL_NANO * 2n);
    assert.equal(
        preflight.requiredNano,
        preflight.totalPayoutNano + preflight.totalGasReserveNano
    );
});

test("owner payout failure after winner transfer is reported as partial settlement", async () => {
    const { adapter, calls } = createAdapter({
        sendTransfer(_input, recordedCalls) {
            if (recordedCalls.length === 1) {
                return { ok: true, code: "SENT", txHash: "tx-winner" };
            }
            return { ok: false, code: "OWNER_SEND_FAILED" };
        }
    });

    const result = await adapter.settleContract({
        gameId: "game-5",
        roomNumber: "05",
        winnerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        ownerWallet: "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        prizeAmountNano: 9_500_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(result.ok, false);
    assert.equal(result.partial, true);
    assert.equal(result.code, "OWNER_SEND_FAILED");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].amountNano, 9_500_000_000n - STUB_GAS_CHARGE_NANO);
    assert.equal(calls[1].amountNano, 140_000_000n - STUB_GAS_CHARGE_NANO);
    assert.equal(result.winner.txHash, "tx-winner");
    assert.equal(result.ownerTransfer.recipientCreditNano, 140_000_000n - STUB_GAS_CHARGE_NANO);
    assert.equal(result.roomNumber, 5);
});

test("settlement requires authoritative roomNumber and never uses gameplay roomId", async () => {
    const { adapter, balanceCalls } = createAdapter();

    await assert.rejects(
        () => adapter.settleContract({
            gameId: "game-keah",
            roomId: "Keah",
            winnerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
            ownerWallet: "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK",
            prizeAmountNano: 9_500_000_000n,
            organizerAmountNano: 150_000_000n
        }),
        /roomNumber is required/
    );

    await assert.rejects(
        () => adapter.preflight({
            gameId: "game-keah",
            roomId: "Keah",
            prizeAmountNano: 9_500_000_000n,
            organizerAmountNano: 150_000_000n
        }),
        /roomNumber is required/
    );

    const result = await adapter.settleContract({
        gameId: "game-keah",
        roomId: "Keah",
        roomNumber: 17,
        winnerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        ownerWallet: "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        prizeAmountNano: 9_500_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(result.ok, true);
    assert.equal(result.roomNumber, 17);
    assert.deepEqual(balanceCalls, [17]);
    assert.notEqual(result.roomNumber, Number("Keah"));
});

test("UhqU CSM handoff shape is accepted without prizeAmount", async () => {
    const { adapter, calls } = createAdapter();
    const winnerWallet = "EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le";
    const ownerWallet = "0QBaklBYMdMsuq7a2eTYhMkz1OF7ZSHaO1mnFd1MZd3YjC5t";
    const request = {
        gameId: "game_3618b43e-f127-4f8f-93ca-84eaa90f1345",
        roomId: "UhqU",
        roomNumber: 1,
        winnerWallet,
        ownerWallet,
        winnerAmount: 2.85,
        organizerAmount: 0.15
    };

    assert.equal(Object.hasOwn(request, "winnerAmount"), true);
    assert.equal(Object.hasOwn(request, "organizerAmount"), true);
    assert.equal(Object.hasOwn(request, "prizeAmount"), false);
    assert.equal(Object.hasOwn(request, "prizeAmountNano"), false);

    const result = await adapter.settleContract(request);

    assert.equal(result.ok, true);
    assert.equal(result.roomNumber, 1);
    assert.equal(result.winnerAmountNano, 2_850_000_000n);
    assert.equal(result.ownerGrossNano, 150_000_000n);
    assert.equal(result.ownerPayoutNano, 140_000_000n);
    assert.equal(result.ownerRetainedNano, 10_000_000n);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].roomNumber, 1);
    assert.equal(calls[0].destination, winnerWallet);
    assert.equal(calls[0].amountNano, 2_850_000_000n - STUB_GAS_CHARGE_NANO);
    assert.equal(calls[1].roomNumber, 1);
    assert.equal(calls[1].destination, ownerWallet);
    assert.equal(calls[1].amountNano, 140_000_000n - STUB_GAS_CHARGE_NANO);
});

test("disagreeing winnerAmount and prizeAmount fail closed", async () => {
    const { adapter, calls } = createAdapter();

    await assert.rejects(
        () => adapter.settleContract({
            gameId: "game-disagree",
            roomNumber: 1,
            winnerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
            ownerWallet: "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK",
            winnerAmount: 2.85,
            prizeAmount: 2.84,
            organizerAmount: 0.15
        }),
        /winner amount fields disagree/
    );

    assert.equal(calls.length, 0);
});

const WINNER = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const OWNER_W = "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK";
const RW = "EQDGQjwaP0OSExa9MfZih61De5TQuUITQPYiYZyfqAFzpvQB";

function payout(hash, amountNano, destination) {
    return { hash, amountNano, destination, success: true, bounced: false };
}

test("winner payout already on chain is not sent again", async () => {
    let inspectCalls = 0;
    const { adapter, calls } = createAdapter({
        getWalletAddress: async () => RW,
        inspectHistory: async () => {
            inspectCalls += 1;
            return {
                reused: false,
                laterCount: inspectCalls > 1 ? 1 : 0,
                winnerPayout: payout("winner-existing", 9_500_000_000n, WINNER),
                ownerPayout: inspectCalls > 1
                    ? payout("owner-new", 140_000_000n, OWNER_W)
                    : null,
                winnerPayoutCount: 1,
                ownerPayoutCount: inspectCalls > 1 ? 1 : 0
            };
        }
    });

    const result = await adapter.settleContract({
        roomNumber: 1,
        winnerWallet: WINNER,
        ownerWallet: OWNER_W,
        prizeAmountNano: 9_500_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].destination, OWNER_W);
    assert.equal(calls[0].amountNano, 140_000_000n - STUB_GAS_CHARGE_NANO);
});

test("owner payout already on chain is not sent again", async () => {
    let inspectCalls = 0;
    const { adapter, calls } = createAdapter({
        getWalletAddress: async () => RW,
        inspectHistory: async () => {
            inspectCalls += 1;
            return {
                reused: false,
                laterCount: inspectCalls > 1 ? 1 : 0,
                winnerPayout: inspectCalls > 1
                    ? payout("winner-new", 9_500_000_000n, WINNER)
                    : null,
                ownerPayout: payout("owner-existing", 140_000_000n, OWNER_W),
                winnerPayoutCount: inspectCalls > 1 ? 1 : 0,
                ownerPayoutCount: 1
            };
        }
    });

    const result = await adapter.settleContract({
        roomNumber: 1,
        winnerWallet: WINNER,
        ownerWallet: OWNER_W,
        prizeAmountNano: 9_500_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].destination, WINNER);
    assert.equal(calls[0].amountNano, 9_500_000_000n - STUB_GAS_CHARGE_NANO);
});

test("both payouts already on chain are adopted without sending", async () => {
    const { adapter, calls } = createAdapter({
        getWalletAddress: async () => RW,
        inspectHistory: async () => ({
            reused: false,
            laterCount: 0,
            winnerPayout: payout("winner-existing", 9_500_000_000n, WINNER),
            ownerPayout: payout("owner-existing", 140_000_000n, OWNER_W),
            winnerPayoutCount: 1,
            ownerPayoutCount: 1
        })
    });

    const result = await adapter.settleContract({
        roomNumber: 1,
        winnerWallet: WINNER,
        ownerWallet: OWNER_W,
        winnerAmount: 9.5,
        organizerAmount: 0.15
    });

    assert.equal(result.ok, true);
    assert.equal(result.code, "SETTLEMENT_ADOPTED");
    assert.equal(result.winnerConfirmed, true);
    assert.equal(result.ownerConfirmed, true);
    assert.equal(calls.length, 0);
});

test("duplicate payout history fails closed", async () => {
    const { adapter, calls } = createAdapter({
        getWalletAddress: async () => RW,
        inspectHistory: async () => ({
            reused: false,
            laterCount: 2,
            winnerPayout: payout("w1", 9_500_000_000n, WINNER),
            ownerPayout: payout("o1", 140_000_000n, OWNER_W),
            winnerPayoutCount: 2,
            ownerPayoutCount: 1
        })
    });

    const result = await adapter.settleContract({
        roomNumber: 1,
        winnerWallet: WINNER,
        ownerWallet: OWNER_W,
        prizeAmountNano: 9_500_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.code, "DUPLICATE_PAYOUT");
    assert.equal(calls.length, 0);
});

test("reused Room Wallet fails closed", async () => {
    const { adapter, calls } = createAdapter({
        getWalletAddress: async () => RW,
        inspectHistory: async () => ({
            reused: true,
            laterCount: 1,
            winnerPayout: null,
            ownerPayout: null,
            winnerPayoutCount: 0,
            ownerPayoutCount: 0
        })
    });

    const result = await adapter.settleContract({
        roomNumber: 1,
        winnerWallet: WINNER,
        ownerWallet: OWNER_W,
        prizeAmountNano: 9_500_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.code, "WALLET_REUSED");
    assert.equal(calls.length, 0);
});

test("inspect RPC failure is retryable and does not send", async () => {
    const { adapter, calls } = createAdapter({
        getWalletAddress: async () => RW,
        inspectHistory: async () => {
            throw new Error("timeout");
        }
    });

    const result = await adapter.settleContract({
        roomNumber: 1,
        winnerWallet: WINNER,
        ownerWallet: OWNER_W,
        prizeAmountNano: 9_500_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.equal(result.code, "CHAIN_INSPECT_UNKNOWN");
    assert.equal(calls.length, 0);
});


test("partial room-wallet refunds return exactly the paid amount and confirm on chain", async () => {
    const txs = [];
    const { adapter, calls } = createAdapter({
        getWalletAddress: async () => RW,
        getTransactions: async () => txs,
        sendTransfer(input) {
            calls.push(input);
            const hash = "refund-" + calls.length;
            txs.push({
                transaction_id: { hash },
                utime: Math.floor(Date.now() / 1000),
                success: true,
                out_msgs: [{
                    destination: input.destination,
                    value: input.amountNano.toString()
                }]
            });
            return {
                ok: true,
                code: "SENT",
                txHash: hash
            };
        }
    });

    const result = await adapter.refundPayments({
        roomNumber: 7,
        cutoffUtime: Date.now(),
        refunds: [{
            playerId: "player-bob",
            playerIndex: 1,
            wallet: WINNER,
            amount: 1
        }]
    });

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].code, "REFUND_CONFIRMED");
    assert.equal(result.results[0].amountNano, 1_000_000_000n - STUB_GAS_CHARGE_NANO);
    assert.equal(result.results[0].grossRefundNano, 1_000_000_000n);
    assert.equal(result.results[0].recipientGasChargeNano, STUB_GAS_CHARGE_NANO);
    assert.equal(result.results[0].txHash, "refund-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].roomNumber, 7);
    assert.equal(calls[0].destination, WINNER);
    assert.equal(calls[0].amountNano, 1_000_000_000n - STUB_GAS_CHARGE_NANO);
});

test("existing room-wallet refund is adopted without a second send", async () => {
    const existingHash = "refund-existing";
    const { adapter, calls } = createAdapter({
        getWalletAddress: async () => RW,
        getTransactions: async () => [{
            transaction_id: { hash: existingHash },
            utime: Math.floor(Date.now() / 1000),
            success: true,
            out_msgs: [{
                destination: WINNER,
                value: "1000000000"
            }]
        }]
    });

    const result = await adapter.refundPayments({
        roomNumber: 8,
        cutoffUtime: Date.now() - 5_000,
        refunds: [{
            playerId: "player-bob",
            playerIndex: 1,
            wallet: WINNER,
            amount: 1
        }]
    });

    assert.equal(result.ok, true);
    assert.equal(result.results[0].code, "REFUND_ADOPTED");
    assert.equal(result.results[0].txHash, existingHash);
    assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// cutoffUtime unit contract — PaymentSession timestamps are MILLISECONDS,
// TON transaction utime is Unix SECONDS. The adapter must normalize the
// cutoff to Unix seconds exactly once (resolveCutoffUtime: values > 1e12
// are divided by 1000 and floored) before comparing against utime seconds.
// Fixed values pin the derivation: 1_700_000_000_500 ms -> 1_700_000_000 s.
// ---------------------------------------------------------------------------

test("refund cutoff derived from a millisecond timestamp is compared in TON utime seconds — transfer after the cutoff is adopted without re-broadcast", async () => {
    const cutoffMs = 1_700_000_000_500;
    const cutoffSeconds = Math.floor(cutoffMs / 1000);
    assert.equal(cutoffSeconds, 1_700_000_000);

    const { adapter, calls } = createAdapter({
        getWalletAddress: async () => RW,
        getTransactions: async () => [{
            transaction_id: { hash: "refund-after-cutoff" },
            utime: cutoffSeconds + 60, // TON utime SECONDS, after the cutoff
            success: true,
            out_msgs: [{
                destination: WINNER,
                value: "1000000000"
            }]
        }]
    });

    const result = await adapter.refundPayments({
        roomNumber: 9,
        cutoffUtime: cutoffMs, // WheelWin millisecond timestamp
        refunds: [{
            playerId: "player-bob",
            playerIndex: 1,
            wallet: WINNER,
            amount: 1
        }]
    });

    // If the cutoff were compared in milliseconds, utime (seconds scale)
    // could never exceed it and the refund would be broadcast a second time.
    assert.equal(result.ok, true);
    assert.equal(result.results[0].code, "REFUND_ADOPTED");
    assert.equal(result.results[0].txHash, "refund-after-cutoff");
    assert.equal(calls.length, 0);
});

test("transfer with utime before the millisecond-derived cutoff is not adopted — a fresh refund is broadcast", async () => {
    const cutoffMs = 1_700_000_000_500;
    const cutoffSeconds = Math.floor(cutoffMs / 1000);
    const history = [{
        transaction_id: { hash: "pre-cutoff-transfer" },
        utime: cutoffSeconds - 60, // BEFORE the cutoff
        success: true,
        out_msgs: [{
            destination: WINNER,
            value: "1000000000"
        }]
    }];

    let sentCount = 0;
    let broadcastInput = null;

    const { adapter } = createAdapter({
        getWalletAddress: async () => RW,
        getTransactions: async () => history,
        sendTransfer(input) {
            sentCount += 1;
            broadcastInput = input;
            const hash = "refund-fresh";
            history.push({
                transaction_id: { hash },
                utime: Math.floor(Date.now() / 1000),
                success: true,
                out_msgs: [{
                    destination: input.destination,
                    value: input.amountNano.toString()
                }]
            });
            return { ok: true, code: "SENT", txHash: hash };
        }
    });

    const result = await adapter.refundPayments({
        roomNumber: 9,
        cutoffUtime: cutoffMs,
        refunds: [{
            playerId: "player-bob",
            playerIndex: 1,
            wallet: WINNER,
            amount: 1
        }]
    });

    // The pre-cutoff transfer must not be mistaken for the refund.
    assert.equal(result.ok, true);
    assert.equal(result.results[0].code, "REFUND_CONFIRMED");
    assert.equal(result.results[0].txHash, "refund-fresh");
    assert.equal(sentCount, 1);
    assert.deepEqual(
        { destination: broadcastInput?.destination, amountNano: broadcastInput?.amountNano },
        { destination: WINNER, amountNano: 1_000_000_000n - STUB_GAS_CHARGE_NANO }
    );
});

// ---------------------------------------------------------------------------
// PLAYER_WALLET_INBOUND reconciliation — the Room Wallet outbound history may
// have failed to observe a refund that in fact reached the player's wallet.
// When the outbound scan finds no match, the destination player's own inbound
// history is inspected (read-only). An inbound transfer is accepted ONLY when
// it is successful, not bounced, exactly the expected amount, sourced from the
// authoritative Room Wallet, and later than the refund cutoff. An adopted
// player-wallet refund must never trigger a second broadcast.
// ---------------------------------------------------------------------------

const PLAYER_WALLET = "EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM";
const STRANGER_WALLET = "EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le";

test("refund that reached the player wallet is reconciled from player wallet history without a second send", async () => {
    const cutoffMs = 1_700_000_000_500;
    const cutoffSeconds = Math.floor(cutoffMs / 1000);
    const addressQueries = [];
    let broadcastCount = 0;
    const infoLogLines = [];

    const { adapter, calls } = createAdapter({
        getWalletAddress: async () => RW,
        getTransactions: async () => [], // Room Wallet history: no matching outbound refund
        getAddressTransactions: async (address, query) => {
            addressQueries.push({ address, query });
            return [{
                transaction_id: { hash: "player-inbound-refund" },
                utime: cutoffSeconds + 60, // AFTER the cutoff
                success: true,
                in_msg: {
                    source: RW, // authoritative Room Wallet
                    value: "1000000000"
                }
            }];
        },
        sendTransfer() {
            broadcastCount += 1;
            return { ok: true, code: "SENT", txHash: `refund-${broadcastCount}` };
        },
        logger: {
            info: (line) => infoLogLines.push(line),
            warn: () => {}
        }
    });

    const result = await adapter.refundPayments({
        roomNumber: 10,
        cutoffUtime: cutoffMs,
        refunds: [{
            playerId: "player-bob",
            playerIndex: 1,
            wallet: PLAYER_WALLET,
            amount: 1
        }]
    });

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].code, "REFUND_RECONCILED_FROM_PLAYER_WALLET");
    assert.equal(result.results[0].reconciliation, "PLAYER_WALLET_INBOUND");
    assert.equal(result.results[0].confirmed, true);
    assert.equal(result.results[0].txHash, "player-inbound-refund");
    // The reconciled legacy (pre-payout-gas-policy) transfer was broadcast at
    // the gross refundable amount; the adopted result reports the frozen NET
    // refund the plan would produce for this target.
    assert.equal(result.results[0].amountNano, 1_000_000_000n - STUB_GAS_CHARGE_NANO);

    // An already completed refund must never be broadcast again.
    assert.equal(calls.length, 0);
    assert.equal(broadcastCount, 0);

    // Exactly the destination player's own wallet is inspected, archival.
    assert.deepEqual(addressQueries, [{
        address: PLAYER_WALLET,
        query: { limit: 40, archival: true }
    }]);

    // Exactly one concise informational log for the reconciliation.
    assert.equal(infoLogLines.length, 1);
    assert.match(infoLogLines[0], /room=10/);
    assert.match(infoLogLines[0], new RegExp(`playerWallet=${PLAYER_WALLET}`));
    assert.match(infoLogLines[0], new RegExp(`roomWallet=${RW}`));
    // The adopted result reports the frozen NET refund for this target.
    assert.match(infoLogLines[0], new RegExp(`amountNano=${1000000000 - 2000000}`));
    assert.match(infoLogLines[0], /txHash=player-inbound-refund/);
    assert.match(infoLogLines[0], /reconciliation=PLAYER_WALLET_INBOUND/);
});

test("inbound from another source is not accepted as an already completed refund — a fresh refund is broadcast", async () => {
    const cutoffMs = 1_700_000_000_500;
    const cutoffSeconds = Math.floor(cutoffMs / 1000);
    const roomWalletHistory = [];
    let broadcastCount = 0;

    const { adapter } = createAdapter({
        getWalletAddress: async () => RW,
        getTransactions: async () => roomWalletHistory,
        getAddressTransactions: async () => [{
            transaction_id: { hash: "foreign-source-inbound" },
            utime: cutoffSeconds + 60,
            success: true,
            in_msg: {
                source: STRANGER_WALLET, // NOT the authoritative Room Wallet
                value: "1000000000"
            }
        }],
        sendTransfer(input) {
            broadcastCount += 1;
            const hash = `refund-fresh-${broadcastCount}`;
            roomWalletHistory.push({
                transaction_id: { hash },
                utime: cutoffSeconds + 120,
                success: true,
                out_msgs: [{
                    destination: input.destination,
                    value: input.amountNano.toString()
                }]
            });
            return { ok: true, code: "SENT", txHash: hash };
        }
    });

    const result = await adapter.refundPayments({
        roomNumber: 10,
        cutoffUtime: cutoffMs,
        refunds: [{
            playerId: "player-bob",
            playerIndex: 1,
            wallet: PLAYER_WALLET,
            amount: 1
        }]
    });

    // The foreign-source inbound must not be mistaken for the refund.
    assert.equal(result.results[0].code, "REFUND_CONFIRMED");
    assert.equal(result.results[0].reconciliation, undefined);
    assert.equal(broadcastCount, 1);
});

test("player wallet inbound with a different amount is not accepted as an already completed refund — a fresh refund is broadcast", async () => {
    const cutoffMs = 1_700_000_000_500;
    const cutoffSeconds = Math.floor(cutoffMs / 1000);
    const roomWalletHistory = [];
    let broadcastCount = 0;

    const { adapter } = createAdapter({
        getWalletAddress: async () => RW,
        getTransactions: async () => roomWalletHistory,
        getAddressTransactions: async () => [{
            transaction_id: { hash: "wrong-amount-inbound" },
            utime: cutoffSeconds + 60,
            success: true,
            in_msg: {
                source: RW, // correct source…
                value: "999000000" // …but a different amount
            }
        }],
        sendTransfer(input) {
            broadcastCount += 1;
            const hash = `refund-fresh-${broadcastCount}`;
            roomWalletHistory.push({
                transaction_id: { hash },
                utime: cutoffSeconds + 120,
                success: true,
                out_msgs: [{
                    destination: input.destination,
                    value: input.amountNano.toString()
                }]
            });
            return { ok: true, code: "SENT", txHash: hash };
        }
    });

    const result = await adapter.refundPayments({
        roomNumber: 10,
        cutoffUtime: cutoffMs,
        refunds: [{
            playerId: "player-bob",
            playerIndex: 1,
            wallet: PLAYER_WALLET,
            amount: 1
        }]
    });

    assert.equal(result.results[0].code, "REFUND_CONFIRMED");
    assert.equal(result.results[0].reconciliation, undefined);
    assert.equal(broadcastCount, 1);
});

test("player wallet inbound before the refund cutoff is not accepted — a fresh refund is broadcast", async () => {
    const cutoffMs = 1_700_000_000_500;
    const cutoffSeconds = Math.floor(cutoffMs / 1000);
    const roomWalletHistory = [];
    let broadcastCount = 0;

    const { adapter } = createAdapter({
        getWalletAddress: async () => RW,
        getTransactions: async () => roomWalletHistory,
        getAddressTransactions: async () => [{
            transaction_id: { hash: "pre-cutoff-inbound" },
            utime: cutoffSeconds - 60, // BEFORE the cutoff
            success: true,
            in_msg: {
                source: RW,
                value: "1000000000"
            }
        }],
        sendTransfer(input) {
            broadcastCount += 1;
            const hash = `refund-fresh-${broadcastCount}`;
            roomWalletHistory.push({
                transaction_id: { hash },
                utime: cutoffSeconds + 120,
                success: true,
                out_msgs: [{
                    destination: input.destination,
                    value: input.amountNano.toString()
                }]
            });
            return { ok: true, code: "SENT", txHash: hash };
        }
    });

    const result = await adapter.refundPayments({
        roomNumber: 10,
        cutoffUtime: cutoffMs,
        refunds: [{
            playerId: "player-bob",
            playerIndex: 1,
            wallet: PLAYER_WALLET,
            amount: 1
        }]
    });

    assert.equal(result.results[0].code, "REFUND_CONFIRMED");
    assert.equal(result.results[0].reconciliation, undefined);
    assert.equal(broadcastCount, 1);
});

test("bounced player wallet inbound is not accepted as an already completed refund — a fresh refund is broadcast", async () => {
    const cutoffMs = 1_700_000_000_500;
    const cutoffSeconds = Math.floor(cutoffMs / 1000);
    const roomWalletHistory = [];
    let broadcastCount = 0;

    const { adapter } = createAdapter({
        getWalletAddress: async () => RW,
        getTransactions: async () => roomWalletHistory,
        getAddressTransactions: async () => [{
            transaction_id: { hash: "bounced-inbound" },
            utime: cutoffSeconds + 60,
            success: true,
            in_msg: {
                source: RW,
                value: "1000000000",
                bounced: true
            }
        }],
        sendTransfer(input) {
            broadcastCount += 1;
            const hash = `refund-fresh-${broadcastCount}`;
            roomWalletHistory.push({
                transaction_id: { hash },
                utime: cutoffSeconds + 120,
                success: true,
                out_msgs: [{
                    destination: input.destination,
                    value: input.amountNano.toString()
                }]
            });
            return { ok: true, code: "SENT", txHash: hash };
        }
    });

    const result = await adapter.refundPayments({
        roomNumber: 10,
        cutoffUtime: cutoffMs,
        refunds: [{
            playerId: "player-bob",
            playerIndex: 1,
            wallet: PLAYER_WALLET,
            amount: 1
        }]
    });

    assert.equal(result.results[0].code, "REFUND_CONFIRMED");
    assert.equal(result.results[0].reconciliation, undefined);
    assert.equal(broadcastCount, 1);
});

test("a matching Room Wallet outbound refund still wins over a player wallet inbound match", async () => {
    const cutoffMs = 1_700_000_000_500;
    const cutoffSeconds = Math.floor(cutoffMs / 1000);
    const infoLogLines = [];

    const { adapter, calls } = createAdapter({
        getWalletAddress: async () => RW,
        getTransactions: async () => [{
            transaction_id: { hash: "room-wallet-outbound-refund" },
            utime: cutoffSeconds + 60,
            success: true,
            out_msgs: [{
                destination: PLAYER_WALLET,
                value: "1000000000"
            }]
        }],
        getAddressTransactions: async () => [{
            transaction_id: { hash: "player-inbound-refund" },
            utime: cutoffSeconds + 60,
            success: true,
            in_msg: {
                source: RW,
                value: "1000000000"
            }
        }],
        logger: {
            info: (line) => infoLogLines.push(line),
            warn: () => {}
        }
    });

    const result = await adapter.refundPayments({
        roomNumber: 11,
        cutoffUtime: cutoffMs,
        refunds: [{
            playerId: "player-bob",
            playerIndex: 1,
            wallet: PLAYER_WALLET,
            amount: 1
        }]
    });

    // The Room Wallet outbound match keeps the existing REFUND_ADOPTED shape.
    assert.equal(result.ok, true);
    assert.equal(result.results[0].code, "REFUND_ADOPTED");
    assert.equal(result.results[0].reconciliation, undefined);
    assert.equal(result.results[0].txHash, "room-wallet-outbound-refund");
    assert.equal(calls.length, 0);
    assert.equal(infoLogLines.length, 0);
});

test("player wallet reconciliation is skipped without a crash when getAddressTransactions is unavailable", async () => {
    const cutoffMs = 1_700_000_000_500;
    const cutoffSeconds = Math.floor(cutoffMs / 1000);
    const roomWalletHistory = [];
    let broadcastCount = 0;

    const { adapter } = createAdapter({
        getWalletAddress: async () => RW,
        getTransactions: async () => roomWalletHistory,
        // No getAddressTransactions on the room wallet adapter.
        sendTransfer(input) {
            broadcastCount += 1;
            const hash = `refund-fresh-${broadcastCount}`;
            roomWalletHistory.push({
                transaction_id: { hash },
                utime: cutoffSeconds + 120,
                success: true,
                out_msgs: [{
                    destination: input.destination,
                    value: input.amountNano.toString()
                }]
            });
            return { ok: true, code: "SENT", txHash: hash };
        }
    });

    const result = await adapter.refundPayments({
        roomNumber: 10,
        cutoffUtime: cutoffMs,
        refunds: [{
            playerId: "player-bob",
            playerIndex: 1,
            wallet: PLAYER_WALLET,
            amount: 1
        }]
    });

    assert.equal(result.results[0].code, "REFUND_CONFIRMED");
    assert.equal(broadcastCount, 1);
});
