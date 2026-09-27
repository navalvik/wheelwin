/**
 * R18.XSDd follow-up — Creator-leaves-before-GAME_INITIALIZED Room Wallet
 * refunds.
 *
 * When the room creator leaves before GAME_INITIALIZED, every confirmed Room
 * Wallet player payment (1/3, 2/3, 3/3 FULLY_PAID) must be refunded through
 * the EXISTING PaymentSessionManager Room Wallet refund machinery
 * (failSession → _requestRoomWalletPartialPaymentRefund →
 * RoomWalletSettlementAdapter.refundPayments), with the room close deferred
 * while REFUND_PENDING. The obsolete escrow-era decision
 * (sessionNeedsEscrowUnwind) returned false for FULLY_PAID sessions and let
 * the room close without refunding already-paid funds. No GameEscrow /
 * DepositContract mechanism is involved; setup-expiry logic is untouched.
 */
import assert from "node:assert/strict";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameContractManager } from "../gameplay/GameContractManager.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { SetupSessionLifecycle } from "../gameplay/SetupSessionLifecycle.js";
import { RoomManager } from "../managers/RoomManager.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS,
    PaymentSession
} from "../models/PaymentSession.js";
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

/**
 * Build a pre-game payment session with `paidCount` confirmed seats.
 * paidCount 3 → FULLY_PAID (all three players paid), 1-2 → PARTIALLY_PAID,
 * 0 → WAITING_FOR_PAYMENTS.
 */
function paidCreatorSession(roomId, paidCount) {

    return new PaymentSession({
        paymentSessionId: `pay-creator-${paidCount}of3`,
        roomId,
        roomNumber: 7,
        gameId: "game-creator",
        status: paidCount === 3
            ? PAYMENT_SESSION_STATUS.FULLY_PAID
            : paidCount === 0
                ? PAYMENT_SESSION_STATUS.WAITING_FOR_PAYMENTS
                : PAYMENT_SESSION_STATUS.PARTIALLY_PAID,
        participants: [0, 1, 2].map((index) => ({
            playerId: `p${index + 1}`,
            playerIndex: index,
            wallet: `wallet-${index + 1}`,
            requiredGram: 10,
            status: index < paidCount
                ? PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                : PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION,
            paidAmount: index < paidCount ? 10 : 0
        }))
    });

}

function buildStack({ refundThrows = false, refundDefer = false } = {}) {

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const cancelCalls = [];
    const closeRoomCalls = [];
    const failedEvents = [];

    const deployAdapter = {
        async cancel(payload) {

            cancelCalls.push(payload);

            return { ok: true, txId: "cancel-creator-tx" };

        }
    };

    const blockchainMonitor = {
        watchGameEscrowRefunds() {

            return { watchId: "refund-watch-creator" };

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

    // Existing Room Wallet refund machinery — the same adapter interface the
    // production RoomWalletSettlementRouter exposes to PaymentSessionManager.
    const refundCalls = [];
    const deferredRefundResolvers = [];

    const buildRefundResult = () => ({
        ok: true,
        results: refundCalls[refundCalls.length - 1].refunds.map((refund) => ({
            ok: true,
            playerId: refund.playerId,
            txHash: `refund-tx-${refund.playerId}-${refundCalls.length}`
        }))
    });

    const roomWalletSettlementAdapter = {
        async refundPayments(request) {

            refundCalls.push(request);

            if (refundThrows) {

                throw new Error("refund_broadcast_failed");

            }

            if (refundDefer) {

                return await new Promise((resolve) => {

                    deferredRefundResolvers.push(resolve);

                });

            }

            return buildRefundResult();

        }
    };

    const paymentSessionManager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager: { getIdentity() { return null; } },
        roomManager,
        gameContractManager,
        blockchainMonitor,
        devMode: false,
        roomWalletPaymentIntakeEnabled: true,
        roomWalletSettlementAdapter
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

    eventBus.subscribe(EVENT_TYPES.PAYMENT_SESSION_FAILED, (envelope) => {

        failedEvents.push(envelope.payload);

    });

    const room = roomManager.createRoom({ maxPlayers: 3 });

    const roomId = room.roomId;

    return {
        logger,
        eventBus,
        roomId,
        roomManager,
        setupSessionLifecycle,
        roomLobbyBridge,
        paymentSessionManager,
        gameContractManager,
        refundCalls,
        cancelCalls,
        closeRoomCalls,
        failedEvents,
        resolvePendingRefunds() {

            for (const resolve of deferredRefundResolvers.splice(0)) {

                resolve(buildRefundResult());

            }

        },
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

async function waitForAsync() {

    await new Promise((resolve) => setTimeout(resolve, 0));

}

/**
 * Creator disconnects from the lobby before the game started. The
 * creator_left diagnostic block is intentionally silenced for readable
 * test output.
 */
async function triggerCreatorLeave(stack, { creatorId = "p1" } = {}) {

    stack.roomLobbyBridge._roomCreators.set(stack.roomId, creatorId);

    const originalLog = console.log;

    const originalTrace = console.trace;

    console.log = () => {};

    console.trace = () => {};

    try {

        stack.roomLobbyBridge._removePlayerFromLobby(creatorId, stack.roomId, {
            notifyPlayer: false,
            reason: "socket_disconnected"
        });

    } finally {

        console.log = originalLog;

        console.trace = originalTrace;

    }

    await waitForAsync();

}

console.log("R18.XSDd creator-leaves-before-GAME_INITIALIZED Room Wallet refund tests");

// A — CREATOR LEAVES, 0/3 PAID: nothing was received → normal room close,
// no refund attempt, no GameEscrow cancel.
{
    for (const seedPaidCount of [null, 0]) {

        const stack = buildStack();

        if (seedPaidCount != null) {

            stack.paymentSessionManager._sessionsByRoom.set(
                stack.roomId,
                paidCreatorSession(stack.roomId, seedPaidCount)
            );

        }

        await triggerCreatorLeave(stack);

        assert.equal(stack.closeRoomCalls.length, 1, "room closes normally");
        assert.equal(stack.closeRoomCalls[0].reason, "creator_left");
        assert.equal(
            stack.refundCalls.length,
            0,
            "nothing received → nothing refunded"
        );
        assert.equal(stack.failedEvents.length, 0);
        assert.equal(stack.cancelCalls.length, 0);

        stack.shutdown();

    }

    console.log("  A. 0/3 paid → normal _closeRoom passed");

}

// B — CREATOR LEAVES, 1/3 PAID: only the confirmed player is refunded through
// the Room Wallet refund machinery; room closes after the refund completes.
{
    const stack = buildStack();

    stack.paymentSessionManager._sessionsByRoom.set(
        stack.roomId,
        paidCreatorSession(stack.roomId, 1)
    );

    await triggerCreatorLeave(stack);

    assert.equal(stack.refundCalls.length, 1, "exactly one refund handoff");
    assert.equal(
        stack.refundCalls[0].roomNumber,
        7,
        "refund uses the Room Wallet room number"
    );

    const refundTargets = stack.refundCalls[0].refunds.map((r) => r.playerId);

    assert.deepEqual(
        refundTargets,
        ["p1"],
        "exactly the single confirmed player is refunded"
    );
    assert.equal(
        stack.paymentSessionManager.getSession(stack.roomId).status,
        PAYMENT_SESSION_STATUS.CANCELLED,
        "session unwinds REFUND_PENDING → CANCELLED"
    );
    assert.equal(
        stack.failedEvents.length,
        1,
        "PAYMENT_SESSION_FAILED is emitted after the refund"
    );
    assert.equal(stack.failedEvents[0].reason, "creator_left");
    assert.equal(
        stack.closeRoomCalls.length,
        1,
        "room closes only after the refund completes"
    );
    assert.equal(stack.closeRoomCalls[0].reason, "creator_left");
    assert.equal(
        stack.cancelCalls.length,
        0,
        "no GameEscrow cancel is ever requested"
    );

    stack.shutdown();

    console.log("  B. 1/3 paid → single Room Wallet refund passed");

}

// C — CREATOR LEAVES, 2/3 PAID: both confirmed players are refunded.
{
    const stack = buildStack();

    stack.paymentSessionManager._sessionsByRoom.set(
        stack.roomId,
        paidCreatorSession(stack.roomId, 2)
    );

    await triggerCreatorLeave(stack);

    assert.equal(stack.refundCalls.length, 1);

    const refundTargets = stack.refundCalls[0].refunds.map((r) => r.playerId);

    assert.deepEqual(
        [...refundTargets].sort(),
        ["p1", "p2"],
        "only the two confirmed players are refund targets"
    );
    assert.equal(
        stack.paymentSessionManager.getSession(stack.roomId).status,
        PAYMENT_SESSION_STATUS.CANCELLED
    );
    assert.equal(stack.closeRoomCalls.length, 1);
    assert.equal(stack.closeRoomCalls[0].reason, "creator_left");
    assert.equal(stack.cancelCalls.length, 0);

    stack.shutdown();

    console.log("  C. 2/3 paid → both confirmed refunds passed");

}

// D — CREATOR LEAVES, 3/3 PAID (FULLY_PAID): FULLY_PAID must NOT suppress the
// refund (the obsolete escrow-era decision closed the room without refunding);
// all three payments are refunded; close is deferred while REFUND_PENDING.
{
    const stack = buildStack({ refundDefer: true });

    stack.paymentSessionManager._sessionsByRoom.set(
        stack.roomId,
        paidCreatorSession(stack.roomId, 3)
    );

    await triggerCreatorLeave(stack);

    assert.equal(
        stack.closeRoomCalls.length,
        0,
        "fully paid does not skip the refund — close is deferred"
    );
    assert.equal(stack.refundCalls.length, 1);

    const refundTargets = stack.refundCalls[0].refunds.map((r) => r.playerId);

    assert.deepEqual(
        [...refundTargets].sort(),
        ["p1", "p2", "p3"],
        "all three confirmed payments are refund targets"
    );

    stack.resolvePendingRefunds();

    await waitForAsync();

    assert.equal(
        stack.paymentSessionManager.getSession(stack.roomId).status,
        PAYMENT_SESSION_STATUS.CANCELLED,
        "FULLY_PAID session unwinds REFUND_PENDING → CANCELLED"
    );
    assert.equal(stack.failedEvents.length, 1);
    assert.equal(stack.failedEvents[0].reason, "creator_left");
    assert.equal(stack.closeRoomCalls.length, 1);
    assert.equal(stack.closeRoomCalls[0].reason, "creator_left");
    assert.equal(stack.cancelCalls.length, 0);

    stack.shutdown();

    console.log("  D. 3/3 paid (FULLY_PAID) → all refunded, deferred close passed");

}

// E — CREATOR LEAVES AFTER GAME_INITIALIZED: no setup refund; existing
// gameplay ownership guards stay authoritative and the session keeps its
// settlement ownership (FULLY_PAID untouched).
{
    const stack = buildStack();

    stack.paymentSessionManager._sessionsByRoom.set(
        stack.roomId,
        paidCreatorSession(stack.roomId, 3)
    );

    // Setup completed (game start marker) and GAME_INITIALIZED released
    // setup ownership — the authoritative post-init state.
    stack.roomLobbyBridge._startedRooms.add(stack.roomId);

    stack.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_INITIALIZED,
        payload: { roomId: stack.roomId, gameId: "game-creator" }
    });

    await triggerCreatorLeave(stack);

    assert.equal(
        stack.refundCalls.length,
        0,
        "creator leave must not refund gameplay funds after GAME_INITIALIZED"
    );
    assert.equal(
        stack.closeRoomCalls.length,
        0,
        "active gameplay is protected — no room destroy on creator leave"
    );
    assert.equal(
        stack.paymentSessionManager.getSession(stack.roomId).status,
        PAYMENT_SESSION_STATUS.FULLY_PAID,
        "session stays FULLY_PAID — settlement ownership unchanged"
    );
    assert.equal(
        stack.setupSessionLifecycle.isGameplayOwnershipReleased(stack.roomId),
        true,
        "gameplay ownership remains released"
    );

    stack.shutdown();

    console.log("  E. after GAME_INITIALIZED → no refund passed");

}

console.log("creatorLeftRoomWalletRefund.test.js passed");


