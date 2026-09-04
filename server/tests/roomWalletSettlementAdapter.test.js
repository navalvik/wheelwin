import assert from "node:assert/strict";
import test from "node:test";

import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import { GRAM_NANO } from "../payment/roomWallet/RoomWalletFinancialPolicy.js";

function createAdapter({
    balanceNano = 100n * GRAM_NANO,
    sendTransfer = null
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
        }
    };

    return {
        adapter: new RoomWalletSettlementAdapter({ roomWalletAdapter }),
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
