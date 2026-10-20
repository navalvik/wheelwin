import test from "node:test";
import assert from "node:assert/strict";
import {
    createPlayerFundedFeeReserve,
    reconcilePlayerFundedFees,
    PlayerFundedNetworkFeeError
} from "../payment/fees/PlayerFundedNetworkFeePolicy.js";

const freshQuotes = [
    { operationId: "winner-transfer", estimateId: "est-1", destination: "winner-address", purpose: "WINNER_PAYOUT", networkName: "TESTNET", globalId: -3, source: "TONCENTER_FEE_ESTIMATE", feeAtomic: 10, quotedAtMs: 1_000, validForMs: 60_000 },
    { operationId: "operator-transfer", estimateId: "est-2", destination: "operator-address", purpose: "OPERATOR_PAYOUT", networkName: "TESTNET", globalId: -3, source: "TONCENTER_FEE_ESTIMATE", feeAtomic: 8, quotedAtMs: 1_000, validForMs: 60_000 },
    { operationId: "refund-transfer-per-player", estimateId: "est-3", destination: "payer-address", purpose: "PLAYER_REFUND", networkName: "TESTNET", globalId: -3, source: "TONCENTER_FEE_ESTIMATE", feeAtomic: 5, quotedAtMs: 1_000, validForMs: 60_000 }
];

const actual = (operationId, feeAtomic, transactionId, destination) => ({
    operationId, feeAtomic, transactionId, destination,
    blockId: "block-final-1", networkName: "TESTNET", globalId: -3,
    finalized: true, observedAtMs: 3_000
});

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
            actual("winner-transfer", 9, "tx-1", "winner-address"),
            actual("operator-transfer", 7, "tx-2", "operator-address"),
            actual("refund-transfer-per-player", 4, "tx-3", "payer-address")
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
        feeQuotes: [{ ...freshQuotes[0], quotedAtMs: 0, validForMs: 10 }], nowMs: 100
    }), PlayerFundedNetworkFeeError);
    assert.throws(() => createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["a", "b", "c"],
        feeQuotes: [{ ...freshQuotes[0], quotedAtMs: 3_000 }], nowMs: 2_000
    }), PlayerFundedNetworkFeeError);
    assert.throws(() => createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["a", "b", "c"],
        feeQuotes: [freshQuotes[0], freshQuotes[0]], nowMs: 2_000
    }), PlayerFundedNetworkFeeError);
});

test("a shortfall blocks settlement instead of charging room principal", () => {
    const reserve = createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["a", "b", "c"], feeQuotes: freshQuotes, nowMs: 2_000
    });
    assert.throws(() => reconcilePlayerFundedFees({
        reserve,
        actualFees: [
            actual("winner-transfer", 10, "tx-1", "winner-address"),
            actual("operator-transfer", 8, "tx-2", "operator-address"),
            actual("refund-transfer-per-player", 6, "tx-3", "payer-address")
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
            actual("winner-transfer", 1, "tx-1", "winner-address"),
            actual("winner-transfer", 1, "tx-duplicate", "winner-address"),
            actual("operator-transfer", 1, "tx-2", "operator-address")
        ]
    }), PlayerFundedNetworkFeeError);
    assert.throws(() => reconcilePlayerFundedFees({
        reserve,
        actualFees: [actual("winner-transfer", 1, "tx-1", "winner-address")]
    }), PlayerFundedNetworkFeeError);
});

test("fee quotes from the wrong network or provider are rejected", () => {
    assert.throws(() => createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["a", "b", "c"],
        feeQuotes: [{ ...freshQuotes[0], globalId: -239 }], nowMs: 2_000
    }), PlayerFundedNetworkFeeError);
    assert.throws(() => createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["a", "b", "c"],
        feeQuotes: [{ ...freshQuotes[0], source: "CLIENT_ESTIMATE" }], nowMs: 2_000
    }), PlayerFundedNetworkFeeError);
});

test("unfinalized or destination-mismatched actual fee evidence is rejected", () => {
    const reserve = createPlayerFundedFeeReserve({
        roomId: "room-a", playerIds: ["a", "b", "c"], feeQuotes: freshQuotes, nowMs: 2_000
    });
    assert.throws(() => reconcilePlayerFundedFees({
        reserve,
        actualFees: [
            { ...actual("winner-transfer", 9, "tx-1", "winner-address"), finalized: false },
            actual("operator-transfer", 7, "tx-2", "operator-address"),
            actual("refund-transfer-per-player", 4, "tx-3", "payer-address")
        ]
    }), PlayerFundedNetworkFeeError);
    assert.throws(() => reconcilePlayerFundedFees({
        reserve,
        actualFees: [
            actual("winner-transfer", 9, "tx-1", "wrong-address"),
            actual("operator-transfer", 7, "tx-2", "operator-address"),
            actual("refund-transfer-per-player", 4, "tx-3", "payer-address")
        ]
    }), PlayerFundedNetworkFeeError);
});
