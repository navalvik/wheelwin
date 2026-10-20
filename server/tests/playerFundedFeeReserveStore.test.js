import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    PlayerFundedFeeReserveStore,
    PlayerFundedFeeReserveStoreError
} from "../payment/fees/PlayerFundedFeeReserveStore.js";

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), "wheelwin-fee-reserve-"));
    let now = 1_000;
    const filePath = join(directory, "reserves.json");
    const store = new PlayerFundedFeeReserveStore({ filePath, nowProvider: () => now });
    store.initialize();
    const reserve = {
        roomId: "room-1",
        totalReserveAtomic: 23,
        contributions: [
            { playerId: "a", amountAtomic: 8 },
            { playerId: "b", amountAtomic: 8 },
            { playerId: "c", amountAtomic: 7 }
        ],
        feeQuotes: [
            { operationId: "winner", estimateId: "est-1", destination: "winner-address", purpose: "WINNER_PAYOUT", networkName: "TESTNET", globalId: -3, source: "TONCENTER_FEE_ESTIMATE", feeAtomic: 10, quotedAtMs: 900, validForMs: 500 },
            { operationId: "owner", estimateId: "est-2", destination: "owner-address", purpose: "OPERATOR_PAYOUT", networkName: "TESTNET", globalId: -3, source: "TONCENTER_FEE_ESTIMATE", feeAtomic: 8, quotedAtMs: 900, validForMs: 500 },
            { operationId: "refunds", estimateId: "est-3", destination: "payer-address", purpose: "PLAYER_REFUND", networkName: "TESTNET", globalId: -3, source: "TONCENTER_FEE_ESTIMATE", feeAtomic: 5, quotedAtMs: 900, validForMs: 500 }
        ]
    };
    return { directory, filePath, store, reserve, setNow(value) { now = value; } };
}

test("durably creates fee reserve and replays same idempotency key", () => {
    const f = fixture();
    try {
        const first = f.store.create({ idempotencyKey: "room-1:fee-reserve", reserve: f.reserve });
        f.setNow(2_000);
        const replay = f.store.create({ idempotencyKey: "room-1:fee-reserve", reserve: f.reserve });
        assert.equal(first.replay, false);
        assert.equal(replay.replay, true);
        assert.equal(replay.record.createdAtMs, 1_000);
        const recovered = new PlayerFundedFeeReserveStore({ filePath: f.filePath }).initialize();
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].totalReserveAtomic, 23);
    } finally {
        rmSync(f.directory, { recursive: true, force: true });
    }
});

test("conflicting replay and incorrect contribution total are rejected", () => {
    const f = fixture();
    try {
        f.store.create({ idempotencyKey: "room-1:fee-reserve", reserve: f.reserve });
        assert.throws(() => f.store.create({
            idempotencyKey: "room-1:fee-reserve",
            reserve: { ...f.reserve, totalReserveAtomic: 24 }
        }), PlayerFundedFeeReserveStoreError);
        assert.throws(() => f.store.create({
            idempotencyKey: "room-2:fee-reserve",
            reserve: { ...f.reserve, contributions: [
                { playerId: "a", amountAtomic: 7 },
                { playerId: "b", amountAtomic: 8 },
                { playerId: "c", amountAtomic: 7 }
            ] }
        }), PlayerFundedFeeReserveStoreError);
    } finally {
        rmSync(f.directory, { recursive: true, force: true });
    }
});

test("reconciliation is durable and rejects actual fees beyond the reserve", () => {
    const f = fixture();
    try {
        f.store.create({ idempotencyKey: "room-1:fee-reserve", reserve: f.reserve });
        assert.throws(() => f.store.reconcile({
            idempotencyKey: "room-1:fee-reserve",
            reconciliation: {
                settlementAllowed: true, reservedAtomic: 23, actualAtomic: 24,
                surplusAtomic: -1, surplusDisposition: "refund"
            }
        }), PlayerFundedFeeReserveStoreError);
        const result = f.store.reconcile({
            idempotencyKey: "room-1:fee-reserve",
            reconciliation: {
                settlementAllowed: true, reservedAtomic: 23, actualAtomic: 20,
                surplusAtomic: 3, surplusDisposition: "REQUIRES_EXPLICIT_REFUND_OR_RECONCILIATION",
                actualFees: [
                    { operationId: "winner", transactionId: "tx-winner", destination: "winner-address", blockId: "block-1", networkName: "TESTNET", globalId: -3, finalized: true, observedAtMs: NOW, feeAtomic: 9 },
                    { operationId: "owner", transactionId: "tx-owner", destination: "owner-address", blockId: "block-1", networkName: "TESTNET", globalId: -3, finalized: true, observedAtMs: NOW, feeAtomic: 7 },
                    { operationId: "refunds", transactionId: "tx-refund", destination: "payer-address", blockId: "block-1", networkName: "TESTNET", globalId: -3, finalized: true, observedAtMs: NOW, feeAtomic: 4 }
                ]
            }
        });
        assert.equal(result.state, "RECONCILED");
        assert.equal(result.reconciliation.surplusAtomic, 3);
        assert.equal(result.reconciliation.actualFees.length, 3);
        const recovered = new PlayerFundedFeeReserveStore({ filePath: f.filePath }).initialize();
        assert.equal(recovered[0].state, "RECONCILED");
        assert.equal(recovered[0].reconciliation.actualFees[0].transactionId, "tx-winner");
    } finally {
        rmSync(f.directory, { recursive: true, force: true });
    }
});

test("durable reserve preserves quote provenance and rejects wrong-network quote records", () => {
    const f = fixture();
    try {
        const created = f.store.create({ idempotencyKey: "room-1:fee-reserve", reserve: f.reserve });
        assert.equal(created.record.feeQuotes[0].estimateId, "est-1");
        assert.equal(created.record.feeQuotes[0].globalId, -3);
        assert.equal(created.record.feeQuotes[0].destination, "winner-address");
        assert.throws(() => f.store.create({
            idempotencyKey: "room-2:fee-reserve",
            reserve: {
                ...f.reserve,
                feeQuotes: [{ ...f.reserve.feeQuotes[0], globalId: -239 }]
            }
        }), PlayerFundedFeeReserveStoreError);
    } finally {
        rmSync(f.directory, { recursive: true, force: true });
    }
});


test("reserve rejects quote totals that do not match and duplicate outgoing operation IDs", () => {
    const f = fixture();
    try {
        assert.throws(() => f.store.create({
            idempotencyKey: "room-1:bad-total",
            reserve: {
                ...f.reserve,
                totalReserveAtomic: 24,
                contributions: [
                    { playerId: "a", amountAtomic: 8 },
                    { playerId: "b", amountAtomic: 8 },
                    { playerId: "c", amountAtomic: 8 }
                ]
            }
        }), PlayerFundedFeeReserveStoreError);

        assert.throws(() => f.store.create({
            idempotencyKey: "room-1:duplicate-operation",
            reserve: {
                ...f.reserve,
                feeQuotes: [
                    ...f.reserve.feeQuotes,
                    { ...f.reserve.feeQuotes[0], feeAtomic: 0 }
                ]
            }
        }), PlayerFundedFeeReserveStoreError);
    } finally {
        rmSync(f.directory, { recursive: true, force: true });
    }
});


test("reconciliation refuses aggregate totals without per-operation evidence", () => {
    const f = fixture();
    try {
        f.store.create({ idempotencyKey: "room-1:fee-reserve", reserve: f.reserve });
        assert.throws(() => f.store.reconcile({
            idempotencyKey: "room-1:fee-reserve",
            reconciliation: {
                settlementAllowed: true, reservedAtomic: 23, actualAtomic: 20,
                surplusAtomic: 3, surplusDisposition: "REQUIRES_EXPLICIT_REFUND_OR_RECONCILIATION"
            }
        }), PlayerFundedFeeReserveStoreError);
    } finally {
        rmSync(f.directory, { recursive: true, force: true });
    }
});
