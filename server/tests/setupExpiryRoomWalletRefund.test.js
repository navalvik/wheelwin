/**
 * R18.XSDd — Setup-expiry Room Wallet refund tests.
 *
 * When the setup session expires BEFORE GAME_INITIALIZED, every confirmed
 * Room Wallet player payment (1/3, 2/3, 3/3) must be refunded through the
 * EXISTING PaymentSessionManager Room Wallet refund machinery
 * (failSession → _requestRoomWalletPartialPaymentRefund →
 * RoomWalletSettlementAdapter.refundPayments), with the room close deferred
 * while REFUND_PENDING. A FULLY_PAID session no longer suppresses the
 * refund. No GameEscrow / DepositContract mechanism is involved.
 *
 * Successor of the R17.8O.4 escrow-era setup-expiry suite: the bridge no
 * longer routes setup expiry into the GameEscrow cancel path (Room Wallet
 * intake is the active Testnet payment path).
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
 * Build a setup-expiry payment session with `paidCount` confirmed seats.
 * paidCount 3 → FULLY_PAID (all three players paid), otherwise PARTIALLY_PAID.
 */
function paidSetupSession(roomId, paidCount) {

    return new PaymentSession({
        paymentSessionId: `pay-setup-${paidCount}of3`,
        roomId,
        roomNumber: 7,
        gameId: "game-setup",
        status: paidCount === 3
            ? PAYMENT_SESSION_STATUS.FULLY_PAID
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

            return { ok: true, txId: "cancel-setup-tx" };

        }
    };

    const blockchainMonitor = {
        watchGameEscrowRefunds() {

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

function seedArchivedSetup(lifecycle, roomId) {

    lifecycle.archiveForPayment(roomId);

    assert.ok(
        lifecycle.getSession(roomId),
        "setup session must exist before expiry"
    );

}

async function waitForAsync() {

    await new Promise((resolve) => setTimeout(resolve, 0));

}

async function triggerSetupExpiry(stack) {

    stack.setupSessionLifecycle._onExpiry(stack.roomId);

}

console.log("R18.XSDd setup expiry Room Wallet refund tests");

// A — SETUP EXPIRY, 2/3 PAID: confirmed funds refunded, unpaid seat untouched,
// room close deferred while REFUND_PENDING, then finalized.
{

    const stack = buildStack({ refundDefer: true });

    seedArchivedSetup(stack.setupSessionLifecycle, stack.roomId);

    stack.paymentSessionManager._sessionsByRoom.set(
        stack.roomId,
        paidSetupSession(stack.roomId, 2)
    );

    await triggerSetupExpiry(stack);

    assert.equal(
        stack.closeRoomCalls.length,
        0,
        "_closeRoom must not run while the refund is in progress"
    );
    assert.equal(
        stack.paymentSessionManager.getSession(stack.roomId).status,
        PAYMENT_SESSION_STATUS.REFUND_PENDING,
        "session must enter REFUND_PENDING"
    );
    assert.equal(stack.refundCalls.length, 1, "exactly one refund handoff");
    assert.equal(
        stack.refundCalls[0].roomNumber,
        7,
        "refund uses the Room Wallet room number"
    );

    const refundTargets = stack.refundCalls[0].refunds.map((r) => r.playerId);

    assert.deepEqual(
        [...refundTargets].sort(),
        ["p1", "p2"],
        "only the two confirmed players are refund targets"
    );

    const p1Target = stack.refundCalls[0].refunds.find((r) => r.playerId === "p1");

    assert.equal(
        p1Target.amount,
        10,
        "refund amount is the confirmed paid amount (Room Wallet residual/gas handling stays inside the settlement adapter)"
    );

    stack.resolvePendingRefunds();

    await waitForAsync();

    assert.equal(
        stack.paymentSessionManager.getSession(stack.roomId).status,
        PAYMENT_SESSION_STATUS.CANCELLED,
        "session is CANCELLED after all refunds confirm"
    );
    assert.equal(stack.failedEvents.length, 1, "PAYMENT_SESSION_FAILED after refunds");
    assert.equal(stack.failedEvents[0].reason, "setup_expired");
    assert.equal(
        stack.closeRoomCalls.length,
        1,
        "room closes only after the refund completes"
    );
    assert.equal(stack.closeRoomCalls[0].reason, "setup_expired");
    assert.equal(
        stack.cancelCalls.length,
        0,
        "no GameEscrow cancel is ever requested"
    );

    stack.shutdown();

    console.log("  A. 2/3 paid → both refunded, deferred close, no escrow passed");

}

// B — SETUP EXPIRY, 0/3 PAID: normal room close, no refund attempt.
{

    const stack = buildStack();

    seedArchivedSetup(stack.setupSessionLifecycle, stack.roomId);

    await triggerSetupExpiry(stack);

    assert.equal(stack.closeRoomCalls.length, 1);
    assert.equal(stack.closeRoomCalls[0].reason, "setup_expired");
    assert.equal(stack.refundCalls.length, 0, "nothing received → nothing refunded");
    assert.equal(stack.cancelCalls.length, 0);

    stack.shutdown();

    console.log("  B. 0/3 paid → normal _closeRoom passed");

}

// C — SETUP EXPIRY, 1/3 PAID: only the confirmed player is refunded.
{

    const stack = buildStack();

    seedArchivedSetup(stack.setupSessionLifecycle, stack.roomId);

    stack.paymentSessionManager._sessionsByRoom.set(
        stack.roomId,
        paidSetupSession(stack.roomId, 1)
    );

    await triggerSetupExpiry(stack);
    await waitForAsync();

    assert.equal(stack.refundCalls.length, 1);

    const refundTargets = stack.refundCalls[0].refunds.map((r) => r.playerId);

    assert.deepEqual(
        refundTargets,
        ["p1"],
        "exactly the single confirmed player is refunded"
    );
    assert.equal(
        stack.paymentSessionManager.getSession(stack.roomId).status,
        PAYMENT_SESSION_STATUS.CANCELLED
    );
    assert.equal(stack.closeRoomCalls.length, 1);
    assert.equal(stack.cancelCalls.length, 0);

    stack.shutdown();

    console.log("  C. 1/3 paid → single refund passed");

}

// D — SETUP EXPIRY, 3/3 PAID (FULLY_PAID): FULLY_PAID must NOT suppress the
// refund; all three payments are refunded; no duplicate refund.
{

    const stack = buildStack({ refundDefer: true });

    seedArchivedSetup(stack.setupSessionLifecycle, stack.roomId);

    stack.paymentSessionManager._sessionsByRoom.set(
        stack.roomId,
        paidSetupSession(stack.roomId, 3)
    );

    await triggerSetupExpiry(stack);

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
    assert.equal(stack.closeRoomCalls.length, 1);
    assert.equal(stack.failedEvents.length, 1);

    // Idempotency — a repeated expiry must not refund again.
    await triggerSetupExpiry(stack);
    await waitForAsync();

    assert.equal(
        stack.refundCalls.length,
        1,
        "no duplicate refund after the unwind completed"
    );
    assert.equal(stack.cancelCalls.length, 0);

    stack.shutdown();

    console.log("  D. 3/3 paid (FULLY_PAID) → all refunded, idempotent passed");

}

// E — REFUND FAILURE: room stays preserved while REFUND_PENDING (recovery can retry).
{

    const stack = buildStack({ refundThrows: true });

    seedArchivedSetup(stack.setupSessionLifecycle, stack.roomId);

    stack.paymentSessionManager._sessionsByRoom.set(
        stack.roomId,
        paidSetupSession(stack.roomId, 2)
    );

    await triggerSetupExpiry(stack);
    await waitForAsync();

    assert.equal(stack.refundCalls.length, 1, "refund was attempted");
    assert.equal(
        stack.paymentSessionManager.getSession(stack.roomId).status,
        PAYMENT_SESSION_STATUS.REFUND_PENDING,
        "session stays REFUND_PENDING for retry/recovery"
    );
    assert.equal(
        stack.closeRoomCalls.length,
        0,
        "room must not be destroyed while funds are pending refund"
    );
    assert.equal(
        stack.roomManager.getRoom(stack.roomId) != null,
        true,
        "room preserved for recovery"
    );

    stack.shutdown();

    console.log("  E. refund failure → room preserved, REFUND_PENDING passed");

}

// F — SETUP EXPIRY AFTER GAME_INITIALIZED: no refund, gameplay ownership intact.
{

    const stack = buildStack();

    seedArchivedSetup(stack.setupSessionLifecycle, stack.roomId);

    stack.paymentSessionManager._sessionsByRoom.set(
        stack.roomId,
        paidSetupSession(stack.roomId, 3)
    );

    // GAME_INITIALIZED releases setup ownership (existing R8.6 guard).
    stack.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_INITIALIZED,
        payload: { roomId: stack.roomId, gameId: "game-setup" }
    });

    stack.roomLobbyBridge._handleSetupSessionExpired({ roomId: stack.roomId });

    await waitForAsync();

    assert.equal(
        stack.refundCalls.length,
        0,
        "setup-expiry refund must not touch gameplay funds after GAME_INITIALIZED"
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

    console.log("  F. after GAME_INITIALIZED → no refund passed");

}

console.log("setupExpiryRoomWalletRefund.test.js passed");
