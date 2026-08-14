/**
 * R17.8O.4 — Setup expiry escrow unwind bridge tests.
 */
import assert from "node:assert/strict";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameContractManager } from "../gameplay/GameContractManager.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { RoomManager } from "../managers/RoomManager.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS,
    PaymentSession
} from "../models/PaymentSession.js";
import { SETUP_SESSION_STATUS } from "../models/SetupSessionStatus.js";
import { RoomLobbyBridge } from "../socket/RoomLobbyBridge.js";
import { GameplayContextResolver } from "../socket/GameplayContextResolver.js";
import { PlayerManager } from "../managers/PlayerManager.js";

function createLogger() {

    return {
        info() {},
        error() {},
        warn() {},
        debug() {},
        decisionTrace() {}
    };

}

function partialSession(roomId = "room-setup") {

    return new PaymentSession({
        paymentSessionId: "pay-setup-expiry",
        roomId,
        gameId: "game-setup",
        status: PAYMENT_SESSION_STATUS.PARTIALLY_PAID,
        participants: [
            {
                playerId: "p1",
                playerIndex: 0,
                wallet: "wallet-A",
                requiredGram: 10,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED,
                paidAmount: 10
            },
            {
                playerId: "p2",
                playerIndex: 1,
                wallet: "wallet-B",
                requiredGram: 10,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED,
                paidAmount: 10
            },
            {
                playerId: "p3",
                playerIndex: 2,
                wallet: "wallet-C",
                requiredGram: 10,
                status: PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
            }
        ]
    });

}

function buildStack({
    cancelResult = { ok: true, txId: "cancel-setup-tx" }
} = {}) {

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const cancelCalls = [];
    const closeRoomCalls = [];

    const deployAdapter = {
        async cancel(payload) {

            cancelCalls.push(payload);

            return cancelResult;

        }
    };

    const blockchainMonitor = {
        watchGameEscrowRefunds(payload) {

            return { watchId: "refund-watch-setup" };

        },
        stopRoom() {}
    };

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3 }
    });

    roomManager.initialize();

    const gameplayContextResolver = new GameplayContextResolver({
        logger,
        playerManager,
        roomManager
    });

    const setupSessionLifecycle = new SetupSessionLifecycle({
        logger,
        eventBus,
        roomManager,
        roomConfig: { setupDurationMs: 300_000 }
    });

    setupSessionLifecycle.initialize();

    roomManager.attachSetupSessionLifecycle(setupSessionLifecycle);

    const gameContractManager = new GameContractManager({
        logger,
        eventBus,
        playerManager: { getIdentity() { return null; } },
        roomManager,
        deployAdapter,
        devMode: false
    });

    gameContractManager.initialize();

    gameContractManager.setEscrowUnwindDeps({ blockchainMonitor });

    const paymentSessionManager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager: { getIdentity() { return null; } },
        roomManager,
        gameContractManager,
        blockchainMonitor,
        devMode: false
    });

    paymentSessionManager.initialize();

    gameContractManager.setFinancialEvidenceDeps({ paymentSessionManager });

    setupSessionLifecycle.setEscrowUnwindBridgeDeps({ paymentSessionManager });

    const roomLobbyBridge = new RoomLobbyBridge({
        logger,
        eventBus,
        roomManager,
        playerManager,
        gameplayContextResolver,
        setupSessionLifecycle,
        paymentSessionManager,
        gameContractManager
    });

    roomLobbyBridge.initialize();

    roomLobbyBridge._closeRoom = async (roomId, reason) => {

        closeRoomCalls.push({ roomId, reason });

    };

    const room = roomManager.createRoom({ maxPlayers: 3 });

    const roomId = room.roomId;

    gameContractManager._contractsByRoom.set(roomId, {
        contractId: "contract-setup",
        roomId,
        gameId: "game-setup",
        contractAddress: "EQescrow-setup",
        status: GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
    });

    gameContractManager._roomByGameId.set("game-setup", roomId);

    return {
        logger,
        eventBus,
        roomId,
        roomManager,
        setupSessionLifecycle,
        roomLobbyBridge,
        paymentSessionManager,
        gameContractManager,
        cancelCalls,
        closeRoomCalls,
        shutdown() {

            roomLobbyBridge.shutdown();

            paymentSessionManager.shutdown?.();

            gameContractManager.shutdown?.();

            setupSessionLifecycle.shutdown();

            roomManager.shutdown();

            playerManager.shutdown();

            eventBus.shutdown();

        }
    };

}

function seedArchivedSetup(lifecycle, roomId) {

    lifecycle.archiveForPayment(roomId);

    assert.equal(
        lifecycle.getSession(roomId)?.state,
        SETUP_SESSION_STATUS.ARCHIVED
    );

}

async function waitForAsync() {

    await new Promise((resolve) => setTimeout(resolve, 0));

}

async function triggerSetupExpiry(stack) {

    stack.setupSessionLifecycle._onExpiry(stack.roomId);

}

console.log("R17.8O.4 setup expiry escrow unwind bridge tests");

// A — Setup expiry with partial payment triggers unwind, not immediate close.
{

    const stack = buildStack();

    seedArchivedSetup(stack.setupSessionLifecycle, stack.roomId);

    stack.paymentSessionManager._sessionsByRoom.set(
        stack.roomId,
        partialSession(stack.roomId)
    );

    await triggerSetupExpiry(stack);

    await waitForAsync();

    assert.equal(stack.closeRoomCalls.length, 0, "_closeRoom must not run immediately");
    assert.equal(
        stack.paymentSessionManager.getSession(stack.roomId).status,
        PAYMENT_SESSION_STATUS.REFUND_PENDING
    );
    assert.equal(stack.cancelCalls.length, 1);
    assert.equal(stack.roomManager.getRoom(stack.roomId) != null, true, "room preserved");

    stack.shutdown();

    console.log("  A. partial payment setup expiry → failSession + deferred close");

}

// B — Setup expiry without payment uses normal close path.
{

    const stack = buildStack();

    seedArchivedSetup(stack.setupSessionLifecycle, stack.roomId);

    await triggerSetupExpiry(stack);

    assert.equal(stack.closeRoomCalls.length, 1);
    assert.equal(stack.closeRoomCalls[0].reason, "setup_expired");
    assert.equal(stack.cancelCalls.length, 0);

    stack.shutdown();

    console.log("  B. no payment → normal _closeRoom");

}

// C — Setup expiry after full payment does not trigger escrow unwind.
{

    const stack = buildStack();

    seedArchivedSetup(stack.setupSessionLifecycle, stack.roomId);

    const session = new PaymentSession({
        paymentSessionId: "pay-full",
        roomId: stack.roomId,
        gameId: "game-setup",
        status: PAYMENT_SESSION_STATUS.FULLY_PAID,
        participants: [
            {
                playerId: "p1",
                wallet: "wallet-A",
                requiredGram: 10,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            },
            {
                playerId: "p2",
                wallet: "wallet-B",
                requiredGram: 10,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            },
            {
                playerId: "p3",
                wallet: "wallet-C",
                requiredGram: 10,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            }
        ]
    });

    stack.paymentSessionManager._sessionsByRoom.set(stack.roomId, session);

    await triggerSetupExpiry(stack);

    await waitForAsync();

    assert.equal(stack.closeRoomCalls.length, 1);
    assert.equal(stack.cancelCalls.length, 0);

    stack.shutdown();

    console.log("  C. full payment → no escrow unwind");

}

// D — Cancel failure preserves contract and room during setup expiry unwind.
{

    const stack = buildStack({
        cancelResult: { ok: false, reason: "cancel_failed" }
    });

    seedArchivedSetup(stack.setupSessionLifecycle, stack.roomId);

    stack.paymentSessionManager._sessionsByRoom.set(
        stack.roomId,
        partialSession(stack.roomId)
    );

    const failedEvents = [];

    stack.eventBus.subscribe(EVENT_TYPES.ESCROW_CANCEL_FAILED, (envelope) => {

        failedEvents.push(envelope.payload);

    });

    await triggerSetupExpiry(stack);

    await waitForAsync();

    assert.equal(stack.closeRoomCalls.length, 0);
    assert.equal(failedEvents.length, 1);
    assert.equal(
        stack.gameContractManager.getContract(stack.roomId)?.contractAddress,
        "EQescrow-setup"
    );
    assert.equal(stack.roomManager.getRoom(stack.roomId) != null, true);

    stack.shutdown();

    console.log("  D. cancel failure → ESCROW_CANCEL_FAILED + room preserved");

}

// E — R17.8O.6C production order ends in RoomLobbyBridge cleanup.
{

    const stack = buildStack();

    seedArchivedSetup(stack.setupSessionLifecycle, stack.roomId);

    stack.paymentSessionManager._sessionsByRoom.set(
        stack.roomId,
        partialSession(stack.roomId)
    );

    await triggerSetupExpiry(stack);

    await waitForAsync();

    assert.equal(stack.closeRoomCalls.length, 0, "room deferred during unwind");
    assert.equal(
        stack.paymentSessionManager.getSession(stack.roomId).status,
        PAYMENT_SESSION_STATUS.REFUND_PENDING
    );

    stack.paymentSessionManager._handleGameEscrowCancelConfirmed({
        roomId: stack.roomId,
        cancelTxHash: "cancel-tx-setup-order"
    });

    assert.equal(
        stack.paymentSessionManager.getSession(stack.roomId).status,
        PAYMENT_SESSION_STATUS.REFUND_PENDING
    );
    assert.equal(stack.closeRoomCalls.length, 0);

    stack.paymentSessionManager._handleGameEscrowRefundConfirmed({
        roomId: stack.roomId,
        playerId: "p1",
        transactionId: "refund-tx-1"
    });

    assert.equal(stack.closeRoomCalls.length, 0);

    stack.paymentSessionManager._handleGameEscrowRefundConfirmed({
        roomId: stack.roomId,
        playerId: "p2",
        transactionId: "refund-tx-2"
    });

    await waitForAsync();

    assert.equal(
        stack.closeRoomCalls.length,
        1,
        "PAYMENT_SESSION_FAILED must trigger RoomLobbyBridge._closeRoom"
    );
    assert.equal(stack.closeRoomCalls[0].roomId, stack.roomId);
    assert.equal(stack.closeRoomCalls[0].reason, "setup_expired");
    assert.equal(
        stack.paymentSessionManager.getSession(stack.roomId).status,
        PAYMENT_SESSION_STATUS.CANCELLED
    );

    stack.shutdown();

    console.log(
        "  E. cancel→refunds→PAYMENT_SESSION_FAILED→_closeRoom (prod order)"
    );

}

console.log("R17.8O.4 setup expiry escrow unwind bridge tests passed");
