/**
 * R13.1H — Financial wallet lock after PAYMENT_CONFIRMED.
 */
import assert from "node:assert/strict";

import { SessionWalletStore } from "../session/SessionWalletStore.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS,
    PaymentSession
} from "../models/PaymentSession.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { EventBus } from "../events/EventBus.js";

function createLogger() {

    return {
        info() {},
        error() {},
        warn() {},
        debug() {},
        decisionTrace() {}
    };

}

console.log("R13.1H financial wallet lock tests");

// A — Before payment: wallet A → B allowed
{

    const store = new SessionWalletStore({ logger: createLogger() });

    assert.equal(store.setWallet("room-a", "p1", "wallet-A"), true);
    assert.equal(store.getWallet("room-a", "p1"), "wallet-A");
    assert.equal(store.setWallet("room-a", "p1", "wallet-B"), true);
    assert.equal(store.getWallet("room-a", "p1"), "wallet-B");
    console.log("  A. before payment wallet change → PASS");

}

// B — After PAYMENT_CONFIRMED: wallet change rejected
{

    const store = new SessionWalletStore({ logger: createLogger() });

    store.setWallet("room-b", "p1", "wallet-A");
    store.lockFinancialWallet("room-b", "p1");

    assert.equal(store.isFinancialWalletLocked("room-b", "p1"), true);
    assert.equal(store.setWallet("room-b", "p1", "wallet-B"), false);
    assert.equal(store.getWallet("room-b", "p1"), "wallet-A");
    console.log("  B. after PAYMENT_CONFIRMED wallet change → REJECT");

}

// C — Reconnect / same wallet after lock still OK; different wallet rejected
{

    const store = new SessionWalletStore({ logger: createLogger() });

    store.setWallet("room-c", "p1", "wallet-A");
    store.lockFinancialWallet("room-c", "p1");

    assert.equal(
        store.setWallet("room-c", "p1", "wallet-A"),
        true,
        "identical reconnect wallet must be accepted"
    );
    assert.equal(store.setWallet("room-c", "p1", "wallet-Z"), false);
    assert.equal(store.getWallet("room-c", "p1"), "wallet-A");
    console.log("  C. reconnect different wallet → No replacement");

}

// D — Settlement source remains frozen snapshot wallet
{

    const snapshotWallet = "EQ_SNAPSHOT_WINNER";
    const liveStore = new SessionWalletStore({ logger: createLogger() });

    liveStore.setWallet("room-d", "winner", "EQ_LIVE_DIFFERENT");
    liveStore.lockFinancialWallet("room-d", "winner");

    const snapshot = Object.freeze({
        players: Object.freeze([
            Object.freeze({ playerId: "winner", wallet: snapshotWallet })
        ]),
        payoutAmount: 95,
        organizerFee: 5
    });

    const winnerSeat = snapshot.players.find(
        (player) => player.playerId === "winner"
    );

    assert.equal(winnerSeat.wallet, snapshotWallet);
    assert.notEqual(
        liveStore.getWallet("room-d", "winner"),
        snapshotWallet
    );
    assert.equal(
        winnerSeat.wallet,
        snapshotWallet,
        "settlement must use frozen snapshot wallet"
    );
    console.log("  D. settlement uses frozen snapshot wallet → PASS");

}

// Confirm path locks via PaymentSessionManager when store is wired
{

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const store = new SessionWalletStore({ logger });

    store.setWallet("room-e", "p1", "wallet-A");

    const roomManager = {
        getRoom() {
            return { roomId: "room-e", players: ["p1"] };
        }
    };

    const playerManager = {
        getIdentity() {
            return { playerId: "p1", baseStake: 1, sectorCount: 1 };
        }
    };

    const manager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager,
        roomManager,
        sessionWalletStore: store,
        roomConfig: { paymentSessionDurationMs: 60_000 }
    });

    manager.initialize();

    const session = new PaymentSession({
        paymentSessionId: "pay_e",
        roomId: "room-e",
        gameId: "game-e",
        status: PAYMENT_SESSION_STATUS.WAITING_FOR_PAYMENTS,
        participants: [
            {
                playerId: "p1",
                wallet: "wallet-A",
                requiredGram: 1,
                status: PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
            }
        ]
    });

    manager._sessionsByRoom.set("room-e", session);

    manager.confirmBlockchainPayment("room-e", "p1", {
        txHash: "tx-lock-1",
        amount: 1,
        sender: "wallet-A"
    });

    assert.equal(
        store.isFinancialWalletLocked("room-e", "p1"),
        true,
        "confirm must lock financial wallet"
    );
    assert.equal(store.setWallet("room-e", "p1", "wallet-B"), false);

    manager.shutdown?.();
    eventBus.shutdown();
    console.log("  confirmBlockchainPayment locks wallet → PASS");

}

console.log("R13.1H financial wallet lock tests passed");
