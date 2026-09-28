/**
 * Stage 2 — authoritative room network propagation into PaymentSession.
 *
 * Production path under test (Room-Wallet-only architecture):
 *
 *   RoomLobbyBridge._roomNetworkByRoom  (R20 one-time Owner selection)
 *     -> PAYMENT_CONNECTION_READY payload.network
 *     -> PaymentSessionManager._handlePaymentConnectionReady
 *     -> createAndRequest(roomId, { gameId, network })
 *     -> createPaymentSession(roomId, { gameId, network })
 *     -> PaymentSession.network
 *
 * Proven here:
 *   A. TESTNET room  -> session.network === "testnet"
 *   B. MAINNET room  -> session.network === "mainnet" (never converted)
 *   C. The process-level TON_NETWORK (manager tonNetwork) must NOT override
 *      an explicit room selection (both directions).
 *   D. Missing/unknown authoritative room network fails closed using the
 *      existing create-failure convention (PAYMENT_SESSION_FAILED, no session).
 *   E. RoomLobbyBridge attaches the committed _roomNetworkByRoom value to the
 *      PAYMENT_CONNECTION_READY domain event payload (null when absent).
 *
 * No smart-contract payment path (GameEscrow / DepositContract /
 * DepositPackage) is imported, restored, or activated by this stage.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { PAYMENT_SESSION_STATUS } from "../models/PaymentSession.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import { createDummyRoomWalletEntry } from "./helpers/dummyRoomWallet.js";

const ROOM_NUMBER = 17;

const ROOM_WALLET = createDummyRoomWalletEntry(ROOM_NUMBER);

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {},
        startupLine() {}
    };

}

function createEventBus() {

    const eventBus = new EventBus({
        logger: createLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    return eventBus;

}

/**
 * Production-shaped harness: Room-Wallet-only player payments
 * (isRoomWalletOnlyFinancialPath is unconditionally true in production) and
 * no Game Contract in the room.
 */
function createHarness({ tonNetwork = "testnet" } = {}) {

    const eventBus = createEventBus();

    const manager = new PaymentSessionManager({
        logger: createLogger(),
        eventBus,
        playerManager: {
            getIdentity() {

                return { baseStake: 10, sectorCount: 1 };

            }
        },
        roomManager: {
            getRoom(roomId) {

                return roomId
                    ? {
                        roomId,
                        roomNumber: ROOM_NUMBER,
                        players: ["p1", "p2", "p3"]
                    }
                    : null;

            }
        },
        roomConfig: { paymentSessionDurationMs: 60_000 },
        gameplayContextResolver: {
            resolveGameIdByRoomId(roomId) {

                return roomId ? `game-${roomId}` : null;

            }
        },
        sessionWalletStore: {
            getWallet(_roomId, playerId) {

                return `EQ${playerId}WalletXXXXXXXXXXXXXXXXXXXX`;

            }
        },
        blockchainMonitor: {
            watchPayment() {}
        },
        tonNetwork,
        devMode: false,
        roomWalletPaymentIntakeEnabled: true
    });

    manager.setRoomWalletFinance({
        registry: new RoomWalletRegistry({
            entries: [
                { roomNumber: ROOM_NUMBER, address: ROOM_WALLET.address }
            ]
        }),
        roomWalletPaymentIntakeEnabled: true
    });

    manager.initialize();

    return { eventBus, manager };

}

/**
 * Mirrors the production RoomLobbyBridge._deliverPaymentConnectionReady emit.
 * Passing `undefined` emulates the pre-Stage-2 payload shape (no network).
 */
function emitPaymentConnectionReady(eventBus, roomId, network) {

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_CONNECTION_READY,
        payload: network === undefined
            ? { roomId, timestamp: Date.now() }
            : { roomId, network, timestamp: Date.now() }
    });

}

test("A: TESTNET room commits PaymentSession.network = testnet", () => {

    const { eventBus, manager } = createHarness({ tonNetwork: "testnet" });

    emitPaymentConnectionReady(eventBus, "room-t", "testnet");

    const session = manager.getSession("room-t");

    assert.ok(session, "session must be created for a TESTNET room");

    assert.equal(session.status, PAYMENT_SESSION_STATUS.WAITING_FOR_PAYMENTS);

    assert.equal(
        session.network,
        "testnet",
        "PaymentSession.network must equal the room's TESTNET selection"
    );

    assert.equal(session.roomWalletAddress, ROOM_WALLET.address);

    manager.shutdown();

    eventBus.shutdown();

});

test("B: MAINNET room commits PaymentSession.network = mainnet (no conversion)", () => {

    const { eventBus, manager } = createHarness({ tonNetwork: "testnet" });

    emitPaymentConnectionReady(eventBus, "room-m", "mainnet");

    const session = manager.getSession("room-m");

    assert.ok(session, "session must be created for a MAINNET room");

    assert.equal(
        session.network,
        "mainnet",
        "PaymentSession.network must equal the room's MAINNET selection"
    );

    assert.notEqual(
        session.network,
        "testnet",
        "MAINNET selection must never be silently converted to TESTNET"
    );

    manager.shutdown();

    eventBus.shutdown();

});

test("C: process-level TON_NETWORK does not override the explicit room selection", () => {

    // Process-level TON_NETWORK = mainnet; room explicitly selected testnet.
    const mainnetProcess = createHarness({ tonNetwork: "mainnet" });

    emitPaymentConnectionReady(mainnetProcess.eventBus, "room-pm", "testnet");

    assert.equal(
        mainnetProcess.manager.getSession("room-pm")?.network,
        "testnet",
        "manager tonNetwork=mainnet must not override the room's testnet selection"
    );

    mainnetProcess.manager.shutdown();

    mainnetProcess.eventBus.shutdown();

    // Opposite direction: process-level TON_NETWORK = testnet; room selected mainnet.
    const testnetProcess = createHarness({ tonNetwork: "testnet" });

    emitPaymentConnectionReady(testnetProcess.eventBus, "room-pt", "mainnet");

    assert.equal(
        testnetProcess.manager.getSession("room-pt")?.network,
        "mainnet",
        "manager tonNetwork=testnet must not override the room's mainnet selection"
    );

    testnetProcess.manager.shutdown();

    testnetProcess.eventBus.shutdown();

});

test("D: missing authoritative room network fails closed (no session, PAYMENT_SESSION_FAILED)", () => {

    const { eventBus, manager } = createHarness({ tonNetwork: "testnet" });

    const failures = [];

    eventBus.subscribe(EVENT_TYPES.PAYMENT_SESSION_FAILED, (envelope) => {

        failures.push(envelope.payload);

    });

    // Production payload without an authoritative room network
    // (e.g. committed selection unavailable) must fail closed.
    emitPaymentConnectionReady(eventBus, "room-x");

    assert.equal(
        manager.getSession("room-x"),
        null,
        "no session may be created without the authoritative room network"
    );

    assert.equal(
        failures.length,
        1,
        "exactly one PAYMENT_SESSION_FAILED must be emitted"
    );

    assert.equal(failures[0]?.roomId, "room-x");

    assert.match(
        String(failures[0]?.reason ?? ""),
        /Authoritative room network unavailable/,
        "failure reason must name the missing authoritative room network"
    );

    // Unknown network values fail closed too (never a silent TESTNET downgrade).
    const direct = manager.createAndRequest("room-y", {
        gameId: "game-room-y",
        network: "lan"
    });

    assert.equal(direct, null);

    assert.equal(manager.getSession("room-y"), null);

    manager.shutdown();

    eventBus.shutdown();

});

test("E: RoomLobbyBridge attaches the authoritative room network to the domain event", () => {

    const eventBus = createEventBus();

    const captured = [];

    eventBus.subscribe(EVENT_TYPES.PAYMENT_CONNECTION_READY, (envelope) => {

        captured.push(envelope.payload);

    });

    const bridge = new RoomLobbyBridge({
        logger: createLogger(),
        eventBus,
        roomManager: { getRoom() { return null; } },
        playerManager: {},
        isDevelopment: true
    });

    // The same in-memory authoritative store the R20 selection flow commits;
    // direct access mirrors the existing roomNetworkSelection.r20 suite.
    bridge._roomNetworkByRoom.set("room-b1", "mainnet");

    bridge._deliverPaymentConnectionReady("room-b1");

    bridge._deliverPaymentConnectionReady("room-b2");

    assert.equal(captured.length, 2);

    assert.equal(captured[0]?.roomId, "room-b1");

    assert.equal(
        captured[0]?.network,
        "mainnet",
        "committed room selection must ride the PAYMENT_CONNECTION_READY payload"
    );

    assert.equal(captured[1]?.roomId, "room-b2");

    assert.equal(
        captured[1]?.network,
        null,
        "rooms without a committed selection must expose network: null (fail-closed input)"
    );

    eventBus.shutdown();

});

