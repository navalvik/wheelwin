/**
 * PAYMENT_CLOSING — PaymentSession lifetime while Page4 waits for payments.
 *
 * Proves, using the EXISTING lifecycle only (no new refund system):
 *   E. two accepted payments + hard-timer expiry → the existing
 *      failSession("payment_timeout") → _requestRoomWalletPartialPaymentRefund
 *      → RoomWalletSettlementAdapter.refundPayments path refunds exactly
 *      those two players, with refund recipients taken from the
 *      authoritative participant records;
 *   F. the player whose payment was never accepted gets no refund;
 *   G. a late confirmation cannot reopen or complete the expired session.
 *
 * Mocked settlement adapter. No TESTNET funds. No GameEscrow involvement.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../models/PaymentSession.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";

const ROOM_ID = "Cl01";
const GAME_ID = "game-closing";
const ROOM_NUMBER = 9;
const ROOM_WALLET = friendlyAddress("cl-room-wallet");

const PLAYERS = [
    { playerId: "cl-p1", wallet: friendlyAddress("cl-p1") },
    { playerId: "cl-p2", wallet: friendlyAddress("cl-p2") },
    { playerId: "cl-p3", wallet: friendlyAddress("cl-p3") }
];

function friendlyAddress(seedLabel) {
    const seed = createHash("sha256").update(seedLabel).digest();
    const keyPair = keyPairFromSeed(seed);
    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({ bounceable: true, urlSafe: true });
}

function createLogger() {
    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {}
    };
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLifecycleContext({ t = null, durationMs = 60_000 } = {}) {
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const persistence = new TonFinancialPersistence({
        dataDir: mkdtempSync(join(tmpdir(), "ww-pc-closing-")),
        logger
    });
    persistence.initialize();

    const refundCalls = [];

    // Existing Room-Wallet refund path — RoomWalletSettlementAdapter contract.
    const roomWalletSettlementAdapter = {
        async refundPayments(request) {
            refundCalls.push(request);
            return {
                ok: true,
                roomNumber: request.roomNumber,
                results: (request.refunds ?? []).map((refund) => Object.freeze({
                    ok: true,
                    code: "REFUND_CONFIRMED",
                    confirmed: true,
                    playerId: refund.playerId,
                    playerIndex: refund.playerIndex,
                    wallet: refund.wallet,
                    amountNano: refund.amount,
                    txHash: `refund-${refund.playerId}`
                }))
            };
        }
    };

    const manager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager: {
            getIdentity(playerId) {
                const player = PLAYERS.find((entry) => entry.playerId === playerId);
                return player ? { baseStake: 1, sectorCount: 1 } : null;
            }
        },
        roomManager: {
            getRoom(id) {
                return id === ROOM_ID
                    ? {
                        roomId: ROOM_ID,
                        roomNumber: ROOM_NUMBER,
                        players: PLAYERS.map((player) => player.playerId)
                    }
                    : null;
            },
            resolveRoomNumber(id) {
                return id === ROOM_ID ? ROOM_NUMBER : null;
            }
        },
        roomConfig: { paymentSessionDurationMs: durationMs },
        gameplayContextResolver: {
            resolveGameIdByRoomId(id) {
                return id === ROOM_ID ? GAME_ID : null;
            }
        },
        sessionWalletStore: {
            getWallet(id, playerId) {
                const player = PLAYERS.find((entry) => entry.playerId === playerId);
                return id === ROOM_ID && player ? player.wallet : null;
            }
        },
        financialPersistence: persistence,
        roomWalletPaymentIntakeEnabled: true,
        roomWalletSettlementAdapter
    });
    manager.initialize();

    // Production app.js wiring: the Room Wallet registry backs the
    // fail-closed Room Wallet destination resolution in createPaymentSession.
    const registry = new RoomWalletRegistry({
        entries: [{ roomNumber: ROOM_NUMBER, address: ROOM_WALLET }]
    });
    manager.setRoomWalletFinance({
        registry,
        roomWalletPaymentIntakeEnabled: true
    });

    manager.createPaymentSession(ROOM_ID, { gameId: GAME_ID, network: "testnet" });

    const completed = [];
    eventBus.subscribe(
        EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
        (envelope) => completed.push(envelope.payload)
    );

    const context = {
        manager,
        eventBus,
        persistence,
        refundCalls,
        completed,
        session: manager.getSession(ROOM_ID)
    };

    t?.after?.(() => {
        manager.shutdown();
        persistence.shutdown({ checkpoint: false });
        eventBus.shutdown();
    });

    return context;
}

test("PAYMENT_CLOSING E/F: timer expiry with two accepted payments refunds exactly those two players", async (t) => {
    const ctx = createLifecycleContext({ t, durationMs: 150 });

    // Bob (cl-p1) and Olga (cl-p2) pay while the session is accepting;
    // Lena (cl-p3) never pays. Note: with durationMs 150 the session is
    // already inside the 5 s PAYMENT_CLOSING window, which gates only the
    // observer's Room-Wallet acceptance — manager confirmations remain
    // valid until the hard deadline (proven in test C above).
    const bob = ctx.manager.confirmBlockchainPayment(ROOM_ID, "cl-p1", {
        txHash: "tx-cl-p1",
        amount: 1,
        sender: PLAYERS[0].wallet
    });
    assert.ok(bob);

    const olga = ctx.manager.confirmBlockchainPayment(ROOM_ID, "cl-p2", {
        txHash: "tx-cl-p2",
        amount: 1,
        sender: PLAYERS[1].wallet
    });
    assert.ok(olga);

    assert.equal(ctx.session.status, PAYMENT_SESSION_STATUS.PARTIALLY_PAID);
    assert.equal(ctx.session.confirmedCount(), 2);

    // Hard payment timer expires → existing _onExpiry →
    // failSession("payment_timeout") → PAYMENT_TIMEOUT +
    // existing partial-payment Room Wallet refund unwind.
    await wait(300);

    assert.equal(ctx.refundCalls.length, 1, "existing refund mechanism invoked once");

    const request = ctx.refundCalls[0];
    assert.equal(request.roomNumber, ROOM_NUMBER);
    assert.equal(request.gameId, GAME_ID);
    assert.equal(request.paymentSessionId, ctx.session.paymentSessionId);

    // cutoffUtime unit contract — the refund cutoff handed to the adapter is
    // the PaymentSession MILLISECOND lifecycle timestamp
    // (recoveryMetadata.refundRequestedAt). The adapter normalizes it to
    // Unix seconds exactly once (RoomWalletSettlementAdapter
    // .resolveCutoffUtime: values > 1e12 are Math.floor(v / 1000)) before
    // comparing against TON utime seconds — proven behaviorally in
    // roomWalletSettlementAdapter.test.js.
    assert.equal(request.cutoffUtime, ctx.session.recoveryMetadata.refundRequestedAt);
    assert.equal(request.cutoffUtime > 1_000_000_000_000, true, "cutoff is on the millisecond scale");

    // E — exactly the two accepted players are refund targets.
    const refundedPlayerIds = request.refunds.map((refund) => refund.playerId).sort();
    assert.deepEqual(refundedPlayerIds, ["cl-p1", "cl-p2"]);

    // Refund recipients come from the authoritative participant records.
    assert.deepEqual(
        request.refunds.map((refund) => refund.wallet).sort(),
        [PLAYERS[0].wallet, PLAYERS[1].wallet].sort()
    );

    // F — the never-paid player has no refund target and no refund state.
    assert.equal(request.refunds.some((refund) => refund.playerId === "cl-p3"), false);
    const lena = ctx.session.findParticipant("cl-p3");
    assert.equal(lena.refunded, false);
    assert.equal(lena.paidAmount, 0);

    // The unwind finalizes through the existing flow once every confirmed
    // seat is refunded: REFUND_PENDING → CANCELLED (PAYMENT_SESSION_FAILED).
    await wait(50);

    assert.equal(ctx.session.findParticipant("cl-p1").refunded, true);
    assert.equal(ctx.session.findParticipant("cl-p2").refunded, true);
    assert.equal(ctx.session.status, PAYMENT_SESSION_STATUS.CANCELLED);
    assert.equal(ctx.completed.length, 0, "expired session never completes");
});

test("PAYMENT_CLOSING G: a late transaction cannot reopen or complete an expired session", async (t) => {
    const ctx = createLifecycleContext({ t, durationMs: 150 });

    ctx.manager.confirmBlockchainPayment(ROOM_ID, "cl-p1", {
        txHash: "tx-g-p1",
        amount: 1,
        sender: PLAYERS[0].wallet
    });

    await wait(300); // expiry + existing refund unwind for the single accepted payment
    await wait(50);

    assert.equal(ctx.session.isInProgress(), false);
    assert.equal(ctx.manager.isAcceptingPayments(ROOM_ID), false);

    // The direct confirmation API refuses a terminal session.
    const lateDirect = ctx.manager.confirmBlockchainPayment(ROOM_ID, "cl-p2", {
        txHash: "tx-g-late",
        amount: 1,
        sender: PLAYERS[1].wallet
    });
    assert.equal(lateDirect, null);

    // The observer confirmation event path cannot credit it either.
    ctx.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED,
        payload: {
            roomId: ROOM_ID,
            gameId: GAME_ID,
            playerId: "cl-p2",
            transactionId: "tx-g-late",
            amount: 1,
            sender: PLAYERS[1].wallet
        }
    });
    await wait(20);

    assert.equal(ctx.completed.length, 0);
    assert.equal(ctx.session.confirmedCount(), 1);
    assert.equal(ctx.session.findParticipant("cl-p2").status, PAYMENT_PARTICIPANT_STATUS.PAYMENT_FAILED);
    assert.equal(ctx.session.findParticipant("cl-p2").txHash, null);
    assert.equal(ctx.session.isInProgress(), false);
});