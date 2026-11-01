import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { GameStartAuthorization } from "../../gameplay/GameStartAuthorization.js";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { MainnetPaymentRuntime } from "../payment/MainnetPaymentRuntime.js";

const PLAYERS = ["p1", "p2", "p3"];
const ADDRESSES = PLAYERS.map((_, index) => `0:${String(index + 1).padStart(64, "0")}`);

function runtime(t) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-gate-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const walletCatalog = Array.from({ length: 64 }, (_, index) => ({
        walletId: `mw-${index + 1}`, roomNumber: index + 1,
        address: `0:${String(index + 100).padStart(64, "0")}`, network: "mainnet"
    }));
    const config = loadMainnetRuntimeConfig({ TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-key",
        MAINNET_ROOM_WALLETS_JSON: JSON.stringify(walletCatalog),
        MAINNET_ROOM_WALLET_DATA_DIR: dataDir });
    return { dataDir, config, payment: new MainnetPaymentRuntime({ config }) };
}

function register(payment) {
    payment.incomingPayments.createRoomPaymentIntents({
        roomId: "room-gate", wallet: { walletId: "mw-1", network: "mainnet",
            globalId: -239, address: `0:${String(200).padStart(64, "0")}` },
        createdAt: 1000, expiresAt: 100_000,
        players: PLAYERS.map((playerId, index) => ({ playerId,
            expectedSender: ADDRESSES[index], amountAtomic: String((index + 1) * 1_000_000_000),
            paymentReference: `gate_${playerId}` }))
    });
}

test("Mainnet game-start gate rejects invalid rosters and 0/3, 1/3, 2/3; accepts only exact 3/3", (t) => {
    const h = runtime(t);
    register(h.payment);
    const gate = h.payment.gameStartPaymentGate;
    assert.equal(gate.getGameStartGateStatus("room-gate", ["p1", "p2"]).eligible, false);
    for (const count of [0, 1, 2]) {
        for (const intent of h.payment.incomingLedger.listRoomIntents("room-gate").slice(0, count)) {
            const observation = { network: "mainnet", globalId: -239, roomId: "room-gate",
                transactionId: `tx-${intent.playerId}`,
                payloadFingerprint: createHash("sha256").update(intent.playerId).digest("hex"),
                sourceAddress: intent.expectedSender, destinationAddress: intent.destinationWalletAddress,
                amountAtomic: intent.amountAtomic, asset: "TON", transactionTime: 50_000, observedAt: 50_001 };
            h.payment.incomingLedger.recordTransfer({ observation,
                receipt: { network: "mainnet", globalId: -239, roomId: "room-gate",
                    transactionId: observation.transactionId, status: "CONFIRMED", reason: null,
                    paymentReference: intent.paymentReference, amountAtomic: intent.amountAtomic,
                    sourceAddress: intent.expectedSender, destinationAddress: intent.destinationWalletAddress,
                    transactionTime: 50_000, updatedAt: 50_001, asset: "TON" },
                settleReference: intent.paymentReference });
        }
        const result = gate.getGameStartGateStatus("room-gate", PLAYERS);
        assert.equal(result.eligible, count === 3);
        assert.equal(result.status, `${count}/3`);
        assert.equal(result.page5Enabled, false);
        if (count === 3) {
            const recovered = new MainnetPaymentRuntime({ config: h.config });
            assert.equal(recovered.gameStartPaymentGate.getGameStartGateStatus("room-gate", PLAYERS).eligible, true);
            assert.equal(recovered.gameStartPaymentGate.getGameStartGateStatus("room-gate", PLAYERS).status, "3/3");
        }
    }
});

test("Mainnet game-start gate reads persisted ledger state and never uses Testnet identity", (t) => {
    const h = runtime(t);
    register(h.payment);
    const expected = h.payment.gameStartPaymentGate.getGameStartGateStatus("room-gate", PLAYERS);
    const restarted = new MainnetPaymentRuntime({ config: h.config });
    assert.deepEqual(restarted.gameStartPaymentGate.getGameStartGateStatus("room-gate", PLAYERS), expected);
    assert.equal(restarted.gameStartPaymentGate.network, "mainnet");
    assert.equal(restarted.gameStartPaymentGate.globalId, -239);
    assert.throws(() => new (restarted.gameStartPaymentGate.constructor)({ incomingLedger: {
        network: "testnet", globalId: -3, getRoomPaymentStatus() {}, listRoomIntents() {}
    } }), /MAINNET_PAYMENT_GATE_LEDGER_REQUIRED/);
});

test("GameStartAuthorization allows only the exact 3/3 Mainnet-ledger roster", (t) => {
    const h = runtime(t);
    register(h.payment);
    const players = [...PLAYERS];
    const room = { maxPlayers: 3, players, status: "ACTIVE" };
    const authorization = new GameStartAuthorization({
        logger: {},
        eventBus: {},
        roomManager: { getRoom: () => room },
        gameManager: { getPendingGameplayGameId: () => "game-gate" },
        recoveryEngine: { getRecoverySnapshot: () => null },
        paymentGate: h.payment.gameStartPaymentGate
    });

    for (const count of [0, 1, 2]) {
        assert.equal(authorization._checkStartConditions("room-gate").ok, false,
            `${count}/3 must not authorize gameplay`);
        assert.equal(authorization._checkStartConditions("room-gate").waitForPayment, true);
        for (const intent of h.payment.incomingLedger.listRoomIntents("room-gate").slice(count, count + 1)) {
            const observation = { network: "mainnet", globalId: -239, roomId: "room-gate",
                transactionId: `auth-tx-${intent.playerId}`,
                payloadFingerprint: createHash("sha256").update(`auth-${intent.playerId}`).digest("hex"),
                sourceAddress: intent.expectedSender, destinationAddress: intent.destinationWalletAddress,
                amountAtomic: intent.amountAtomic, asset: "TON", transactionTime: 50_000, observedAt: 50_001 };
            h.payment.incomingLedger.recordTransfer({ observation,
                receipt: { network: "mainnet", globalId: -239, roomId: "room-gate",
                    transactionId: observation.transactionId, status: "CONFIRMED", reason: null,
                    paymentReference: intent.paymentReference, amountAtomic: intent.amountAtomic,
                    sourceAddress: intent.expectedSender, destinationAddress: intent.destinationWalletAddress,
                    transactionTime: 50_000, updatedAt: 50_001, asset: "TON" },
                settleReference: intent.paymentReference });
        }
    }
    assert.equal(authorization._checkStartConditions("room-gate").ok, true,
        "exact Mainnet ledger 3/3 must authorize the existing server start gate");

    room.players = ["p1", "p2", "intruder"];
    assert.equal(authorization._checkStartConditions("room-gate").ok, false,
        "a different room roster must not reuse the confirmed payments");

    room.players = [...PLAYERS];
    authorization.configurePaymentGate(null);
    assert.equal(authorization._checkStartConditions("room-gate").ok, false,
        "missing gate after an initialization error must fail closed");
});
