import test from "node:test";
import assert from "node:assert/strict";
import {
    createPlayerFundedFeeReserve,
    reconcilePlayerFundedFees,
    PlayerFundedNetworkFeeError
} from "../fees/PlayerFundedNetworkFeePolicy.js";

const freshQuotes = [
    { operationId: "winner-transfer", feeAtomic: 10, quotedAtMs: 1_000, validForMs: 60_000 },
    { operationId: "operator-transfer", feeAtomic: 8, quotedAtMs: 1_000, validForMs: 60_000 },
    { operationId: "refund-transfer-per-player", feeAtomic: 5, quotedAtMs: 1_000, validForMs: 60_000 }
];

test("reserve is separate from principal and deterministically shared by exactly three players", () => {
    const reserve = createPlayerFundedFeeReserve({
        roomId: "room-a",
        playerIds: ["player-c", "player-a", "player-b"],
        feeQuotes: freshQuotes,
        nowMs: 2_000
    });

    assert.equal(reserve.totalReserveAtomic, 23);
    assert.equal(reserve.principalExcluded, true);
    assert.deepEqual(reserve.contributions, [
        { playerId: "player-a", amountAtomic: 8 },
        { playerId: "player-b", amountAtomic: 8 },
        { playerId: "player-c", amountAtomic: 7 }
    ]);
    assert.equal(reserve.contributions.reduce((sum, item) => sum + item.amountAtomic, 0), 23);
});

test("allocation is independent of player join order", () => {
    const first = createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["c", "a", "b"], feeQuotes: freshQuotes, nowMs: 2_000
    });
    const second = createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["b", "c", "a"], feeQuotes: freshQuotes, nowMs: 2_000
    });
    assert.deepEqual(first.contributions, second.contributions);
});

test("fresh quote evidence reconciles actual fees and exposes surplus explicitly", () => {
    const reserve = createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["a", "b", "c"], feeQuotes: freshQuotes, nowMs: 2_000
    });
    const result = reconcilePlayerFundedFees({
        reserve,
        actualFees: [
            { operationId: "winner-transfer", feeAtomic: 9 },
            { operationId: "operator-transfer", feeAtomic: 7 },
            { operationId: "refund-transfer-per-player", feeAtomic: 4 }
        ]
    });
    assert.equal(result.reservedAtomic, 23);
    assert.equal(result.actualAtomic, 20);
    assert.equal(result.surplusAtomic, 3);
    assert.equal(result.settlementAllowed, true);
    assert.equal(result.surplusDisposition, "REQUIRES_EXPLICIT_REFUND_OR_RECONCILIATION");
});

test("stale, future, or duplicate fee quotes fail closed", () => {
    assert.throws(() => createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["a", "b", "c"],
        feeQuotes: [{ ...freshQuotes[0], quotedAtMs: 0, validForMs: 10 }],
        nowMs: 100
    }), PlayerFundedNetworkFeeError);

    assert.throws(() => createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["a", "b", "c"],
        feeQuotes: [{ ...freshQuotes[0], quotedAtMs: 3_000 }],
        nowMs: 2_000
    }), PlayerFundedNetworkFeeError);

    assert.throws(() => createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["a", "b", "c"],
        feeQuotes: [freshQuotes[0], freshQuotes[0]],
        nowMs: 2_000
    }), PlayerFundedNetworkFeeError);
});

test("a shortfall blocks settlement instead of charging room principal", () => {
    const reserve = createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["a", "b", "c"], feeQuotes: freshQuotes, nowMs: 2_000
    });
    assert.throws(() => reconcilePlayerFundedFees({
        reserve,
        actualFees: [
            { operationId: "winner-transfer", feeAtomic: 10 },
            { operationId: "operator-transfer", feeAtomic: 8 },
            { operationId: "refund-transfer-per-player", feeAtomic: 6 }
        ]
    }), (error) => error instanceof PlayerFundedNetworkFeeError
        && error.details.shortfallAtomic === 1);
});

test("unknown, duplicate, or incomplete actual fee evidence is rejected", () => {
    const reserve = createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["a", "b", "c"], feeQuotes: freshQuotes, nowMs: 2_000
    });
    assert.throws(() => reconcilePlayerFundedFees({
        reserve,
        actualFees: [
            { operationId: "winner-transfer", feeAtomic: 1 },
            { operationId: "winner-transfer", feeAtomic: 1 },
            { operationId: "operator-transfer", feeAtomic: 1 }
        ]
    }), PlayerFundedNetworkFeeError);
    assert.throws(() => reconcilePlayerFundedFees({
        reserve,
        actualFees: [{ operationId: "winner-transfer", feeAtomic: 1 }]
    }), PlayerFundedNetworkFeeError);
});
