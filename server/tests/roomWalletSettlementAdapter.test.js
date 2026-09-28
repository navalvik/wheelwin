import assert from "node:assert/strict";
import test from "node:test";

import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import { GRAM_NANO } from "../payment/roomWallet/RoomWalletFinancialPolicy.js";

function createAdapter({
    balanceNano = 100n * GRAM_NANO,
    sendTransfer = null,
    inspectHistory = null,
    getWalletAddress = null,
    getTransactions = null
} = {}) {
    const calls = [];
    const balanceCalls = [];
    const gasReserveNano = 3_000_000n;
    const roomWalletAdapter = {
        getGasReserveNano() {
            return gasReserveNano;
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
        ...(typeof getTransactions === "function" ? { getTransactions } : {})
    };

    return {
        adapter: new RoomWalletSettlementAdapter({
            roomWalletAdapter,
            ...(inspectHistory ? { inspectHistory } : {})
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
    assert.equal(calls[0].amountNano, 9_500_000_000n);
    assert.equal(calls[1].amountNano, 140_000_000n);
    assert.equal(result.winnerTransfer.recipientCreditNano, 9_500_000_000n);
    assert.equal(result.winnerTransfer.gasNano, 3_000_000n);
    assert.equal(result.winnerTransfer.sourceDebitNano, 9_503_000_000n);
    assert.equal(result.ownerTransfer.recipientCreditNano, 140_000_000n);
    assert.equal(result.ownerTransfer.gasNano, 3_000_000n);
    assert.equal(result.ownerTransfer.sourceDebitNano, 143_000_000n);
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
    assert.equal(calls[1].amountNano, 4_990_000_000n);
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
    assert.equal(result.preflight.winner.amountNano, 95_000_000n);
    assert.equal(result.preflight.owner.payoutNano, 140_000_000n);
    assert.equal(result.preflight.totalGasReserveNano, 6_000_000n);
    assert.deepEqual(balanceCalls, [3]);
});

test("preflight uses getBalance and requires payout plus source-wallet gas reserve", async () => {
    const { adapter, gasReserveNano } = createAdapter({ balanceNano: 100n * GRAM_NANO });

    const preflight = await adapter.preflight({
        gameId: "game-4",
        roomNumber: "04",
        prizeAmountNano: 9_500_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(preflight.ok, true);
    assert.equal(preflight.balanceNano, 100n * GRAM_NANO);
    assert.equal(preflight.winner.amountNano, 9_500_000_000n);
    assert.equal(preflight.winner.gasReserveNano, gasReserveNano);
    assert.equal(preflight.owner.payoutNano, 140_000_000n);
    assert.equal(preflight.owner.retainedNano, 10_000_000n);
    assert.equal(preflight.totalPayoutNano, 9_640_000_000n);
    assert.equal(preflight.totalGasReserveNano, gasReserveNano * 2n);
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
    assert.equal(calls[0].amountNano, 9_500_000_000n);
    assert.equal(calls[1].amountNano, 140_000_000n);
    assert.equal(result.winner.txHash, "tx-winner");
    assert.equal(result.ownerTransfer.recipientCreditNano, 140_000_000n);
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
    assert.equal(calls[0].amountNano, 2_850_000_000n);
    assert.equal(calls[1].roomNumber, 1);
    assert.equal(calls[1].destination, ownerWallet);
    assert.equal(calls[1].amountNano, 140_000_000n);
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
    assert.equal(calls[0].amountNano, 140_000_000n);
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
    assert.equal(calls[0].amountNano, 9_500_000_000n);
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
    assert.equal(result.results[0].amountNano, 1_000_000_000n);
    assert.equal(result.results[0].txHash, "refund-1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].roomNumber, 7);
    assert.equal(calls[0].destination, WINNER);
    assert.equal(calls[0].amountNano, 1_000_000_000n);
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
        { destination: WINNER, amountNano: 1_000_000_000n }
    );
});
