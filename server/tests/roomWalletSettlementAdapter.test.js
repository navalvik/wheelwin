import assert from "node:assert/strict";
import test from "node:test";

import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import { GRAM_NANO } from "../payment/roomWallet/RoomWalletFinancialPolicy.js";

function createAdapter({ balanceNano = 100n * GRAM_NANO } = {}) {
    const calls = [];
    const roomWalletAdapter = {
        getGasReserveNano() {
            return 3_000_000n;
        },
        async canFundTransfer({ amountNano }) {
            return {
                ok: balanceNano >= amountNano + 3_000_000n,
                balanceNano,
                requiredNano: amountNano + 3_000_000n,
                shortfallNano: balanceNano >= amountNano + 3_000_000n
                    ? 0n
                    : amountNano + 3_000_000n - balanceNano
            };
        },
        async sendTransfer(input) {
            calls.push(input);
            return {
                ok: true,
                code: "SENT",
                txHash: `tx-${calls.length}`
            };
        }
    };

    return {
        adapter: new RoomWalletSettlementAdapter({ roomWalletAdapter }),
        calls
    };
}

test("owner payout retains exactly 0.01 Gram from owner gross share", async () => {
    const { adapter, calls } = createAdapter();

    const result = await adapter.settleContract({
        gameId: "game-1",
        roomNumber: "01",
        winnerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        ownerWallet: "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBK",
        prizeAmountNano: 9_500_000_000n,
        organizerAmountNano: 150_000_000n
    });

    assert.equal(result.ok, true);
    assert.equal(result.ownerGrossNano, 150_000_000n);
    assert.equal(result.ownerPayoutNano, 140_000_000n);
    assert.equal(result.ownerRetainedNano, 10_000_000n);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].amountNano, 9_500_000_000n);
    assert.equal(calls[1].amountNano, 140_000_000n);
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
    const { adapter, calls } = createAdapter({ balanceNano: 100_000_000n });

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
});
