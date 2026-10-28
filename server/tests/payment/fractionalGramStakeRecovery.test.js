import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPaymentRuntime } from "../../payment/runtime/PaymentRuntimeFactory.js";
import { DESCRIPTOR_STAKE_RELATION } from "../../payment/runtime/RoomPaymentSessionAdapter.js";

test("three-player native Gram stakes include 1.5 Gram and 15 Gram and survive restart", () => {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-fractional-gram-"));
    const catalogPath = join(root, "wallets.json");
    const dataDir = join(root, "state");
    const now = Date.now();
    const catalog = Array.from({ length: 64 }, (_, index) => ({
        walletId: `room-wallet-${index + 1}`,
        roomNumber: index + 1,
        address: `0:${(index + 1).toString(16).padStart(64, "0")}`,
        network: "testnet",
        workchain: 0
    }));
    writeFileSync(catalogPath, JSON.stringify(catalog));

    const build = () => buildPaymentRuntime({
        dataDir, walletCatalogPath: catalogPath, nowProvider: () => now
    });
    const requiredPlayers = [1_000_000_000, 1_500_000_000, 15_000_000_000].map(
        (amountAtomic, index) => ({
            roomId: "fractional-room",
            paymentReference: `fractional-stake-${index + 1}`,
            playerId: `player-${index + 1}`,
            expectedSender: `0:${(index + 100).toString(16).padStart(64, "0")}`,
            amountAtomic
        })
    );
    const descriptor = {
        roomId: "fractional-room",
        roomCreatedAt: now,
        network: "testnet",
        asset: "TON",
        stakeLedgerRelation: DESCRIPTOR_STAKE_RELATION,
        requiredPlayers
    };
    try {
        const first = build();
        first.initialize();
        first.sessionAdapter.prepareRoom(descriptor);
        assert.deepEqual(
            first.intentStore.listForRoom("fractional-room").map(x => x.amountAtomic).sort((a, b) => a - b),
            [1_000_000_000, 1_500_000_000, 15_000_000_000]
        );
        const reserved = first.walletPool.getReservationForRoom("fractional-room");
        assert.ok(reserved);
        first.shutdown();

        const recovered = build();
        recovered.initialize();
        assert.equal(recovered.walletPool.getReservationForRoom("fractional-room")?.walletId, reserved.walletId);
        assert.equal(recovered.intentStore.listForRoom("fractional-room").length, 3);
        assert.equal(
            recovered.intentStore.listForRoom("fractional-room").find(x => x.playerId === "player-2")?.amountAtomic,
            1_500_000_000
        );
        assert.throws(() => recovered.sessionAdapter.prepareRoom({
            ...descriptor,
            roomId: "invalid-room",
            requiredPlayers: requiredPlayers.map((x, i) => ({
                ...x, roomId: "invalid-room",
                amountAtomic: i === 1 ? 1_500_000_000.5 : x.amountAtomic
            }))
        }), /positive safe integer/);
        assert.equal(recovered.walletPool.getReservationForRoom("invalid-room"), null);
        recovered.shutdown();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
