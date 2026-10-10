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
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";

const ROOM_WALLET_ADDRESS = "EQDGQjwaP0OSExa9MfZih61De5TQuUITQPYiYZyfqAFzpvQB";

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
function paidSetupSession(roomId, paidCount, { legacyDestinationOnly = false } = {}) {

    return new PaymentSession({
        paymentSessionId: `pay-setup-${paidCount}of3-${roomId}`,
        roomId,
        roomNumber: legacyDestinationOnly ? null : 7,
        roomWalletAddress: legacyDestinationOnly ? null : ROOM_WALLET_ADDRESS,
        gameId: "game-setup",
        status: paidCount === 3
            ? PAYMENT_SESSION_STATUS.FULLY_PAID
            : PAYMENT_SESSION_STATUS.PARTIALLY_PAID,
        participants: [0, 1, 2].map((index) => ({
            playerId: `p${index + 1}`,
            playerIndex: index,
            wallet: `wallet-${index + 1}`,
            paymentDestination: ROOM_WALLET_ADDRESS,
            requiredGram: 10,
            status: index < paidCount
                ? PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                : PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION,
            paidAmount: index < paidCount ? 10 : 0
        }))
    });

}

function buildStack({
    refundThrows = false,
    refundDefer = false,
    planRefundsHandler = null,
    refundPaymentsHandler = null,
    roomWalletRefundRetryDelaysMs = null,
    financialPersistence = { listActive: () => [] }
} = {}) {

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

            if (typeof refundPaymentsHandler === "function") {

                return await refundPaymentsHandler(
                    request,
                    refundCalls.length,
                    buildRefundResult
                );

            }

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

    if (typeof planRefundsHandler === "function") {
        roomWalletSettlementAdapter.planRefunds = (request) => planRefundsHandler(request);
    }

    const paymentSessionManager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager: { getIdentity() { return null; } },
        roomManager,
        gameContractManager,
        blockchainMonitor,
        financialPersistence,
        devMode: false,
        roomWalletPaymentIntakeEnabled: true,
        roomWalletSettlementAdapter,
        roomWalletRefundRetryDelaysMs
    });

    paymentSessionManager.initialize();
    paymentSessionManager.setRoomWalletFinance({
        registry: new RoomWalletRegistry({
            entries: [{
                roomNumber: 7,
                address: ROOM_WALLET_ADDRESS,
                network: "testnet"
            }]
        })
    });

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

async function waitUntil(predicate, timeoutMs = 1_000) {

    const deadline = Date.now() + timeoutMs;

    while (!predicate()) {

        if (Date.now() >= deadline) {

            throw new Error("waitUntil timed out");

        }

        await new Promise((resolve) => setTimeout(resolve, 5));

    }

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

// G — legacy persisted PaymentSession with no roomNumber / roomWalletAddress:
// recover the correct wallet from the server-authored participant paymentDestination.
{
    const stack = buildStack();

    seedArchivedSetup(stack.setupSessionLifecycle, stack.roomId);

    stack.paymentSessionManager._sessionsByRoom.set(
        stack.roomId,
        paidSetupSession(stack.roomId, 3, { legacyDestinationOnly: true })
    );

    await triggerSetupExpiry(stack);

    assert.equal(stack.refundCalls.length, 1, "legacy fully-paid session refunds once");
    assert.equal(
        stack.refundCalls[0].roomNumber,
        7,
        "legacy room number is recovered from the persisted Room Wallet destination"
    );

    stack.shutdown();

    console.log("  G. legacy destination-only session → safe room wallet mapping passed");
}

// H — simultaneous recovered refunds serialize fee planning and retry transient 429s.
{
    let activePlans = 0;
    let maxActivePlans = 0;
    let planCalls = 0;

    const makePlan = (refunds) => ({
        mode: "RECIPIENT_PAYS_GAS",
        gasPolicyVersion: "test",
        feeSource: "estimateExternalMessageFee",
        marginBps: "2000",
        marginFloorNano: "1000000",
        entries: refunds.map((refund) => {
            const grossNano = BigInt(Math.round(Number(refund.amount) * 1_000_000_000));
            return {
                playerId: refund.playerId,
                playerIndex: refund.playerIndex ?? null,
                wallet: refund.wallet,
                grossRefundNano: String(grossNano),
                recipientGasChargeNano: "1000000",
                recipientTransferAmountNano: String(grossNano - 1_000_000n),
                feeEvidence: {
                    inFwdFeeNano: "1",
                    storageFeeNano: "1",
                    gasFeeNano: "1",
                    fwdFeeNano: "1",
                    totalNano: "4"
                }
            };
        })
    });

    const stack = buildStack({
        planRefundsHandler: async (request) => {
            activePlans += 1;
            maxActivePlans = Math.max(maxActivePlans, activePlans);
            planCalls += 1;
            const call = planCalls;
            try {
                await new Promise((resolve) => setTimeout(resolve, 5));
                if (call === 1) {
                    return {
                        ok: false,
                        retryable: true,
                        code: "PAYOUT_GAS_ESTIMATE_UNAVAILABLE",
                        detail: "Request failed with status code 429"
                    };
                }
                return { ok: true, refundPlan: makePlan(request.refunds) };
            } finally {
                activePlans -= 1;
            }
        }
    });

    // Both calls target the same persisted session, as can occur when setup
    // expiry and startup recovery converge. The second call must reuse the first
    // frozen entry and estimate only the uncovered refund entry.
    const sharedSession = paidSetupSession("same-session", 3);
    const pendingA = [{
        playerId: "p1", playerIndex: 0, wallet: "wallet-1", amount: 10
    }];
    const pendingB = [{
        playerId: "p2", playerIndex: 1, wallet: "wallet-2", amount: 10
    }];

    const [planA, planB] = await Promise.all([
        stack.paymentSessionManager._ensureRoomWalletRefundPlanFrozen({
            session: sharedSession,
            roomNumber: 7,
            pendingRefunds: pendingA,
            refundRequestedAt: Date.now()
        }),
        stack.paymentSessionManager._ensureRoomWalletRefundPlanFrozen({
            session: sharedSession,
            roomNumber: 7,
            pendingRefunds: pendingB,
            refundRequestedAt: Date.now()
        })
    ]);

    assert.equal(maxActivePlans, 1, "fee plans must never run concurrently");
    assert.equal(planCalls, 3, "one transient 429 is retried before next entry planning");
    assert.ok(planA?.entries?.length === 1, "first refund plan frozen");
    assert.ok(planB?.entries?.length === 2, "second call reuses frozen entry and adds only uncovered refund");
    assert.equal(sharedSession.recoveryMetadata.refundPlan.entries.length, 2);

    stack.shutdown();

    console.log("  H. fee planning serialized and transient 429 retried passed");
}

// I — retryable Room Wallet refund failures retry in-process without a restart.
{
    let failFirstRefund = true;

    const stack = buildStack({
        roomWalletRefundRetryDelaysMs: [5],
        refundPaymentsHandler: async (request, callNumber, buildRefundResult) => {
            if (failFirstRefund) {
                failFirstRefund = false;
                throw new Error("temporary_rpc_unavailable");
            }
            return buildRefundResult();
        }
    });

    const session = paidSetupSession(stack.roomId, 2);
    stack.paymentSessionManager._sessionsByRoom.set(stack.roomId, session);

    const first = await stack.paymentSessionManager._requestRoomWalletPartialPaymentRefund(
        session,
        "setup_expired"
    );

    assert.equal(first.ok, false);
    assert.equal(first.retryable, true);
    assert.equal(session.status, PAYMENT_SESSION_STATUS.REFUND_PENDING);
    assert.equal(stack.refundCalls.length, 1);
    assert.equal(
        stack.paymentSessionManager._roomWalletRefundRetryTimers.has(stack.roomId),
        true,
        "a retry timer is registered after the transient failure"
    );

    await waitUntil(() => session.status === PAYMENT_SESSION_STATUS.CANCELLED);

    assert.equal(stack.refundCalls.length, 2, "refund retried without server restart");
    assert.equal(session.findParticipant("p1").refunded, true);
    assert.equal(session.findParticipant("p2").refunded, true);
    assert.equal(
        stack.paymentSessionManager._roomWalletRefundRetryTimers.has(stack.roomId),
        false,
        "successful retry clears its timer"
    );
    assert.equal(
        stack.paymentSessionManager._roomWalletRefundRetryAttempts.has(stack.roomId),
        false,
        "successful retry clears retry attempt state"
    );

    stack.shutdown();

    assert.equal(stack.paymentSessionManager._roomWalletRefundRetryTimers.size, 0);
    console.log("  I. transient refund failure → automatic in-process retry passed");
}

// J — permanent settlement-safety rejection must not enter the retry loop.
{
    const stack = buildStack({
        refundPaymentsHandler: async () => ({
            ok: false,
            retryable: false,
            code: "PAYOUT_PLAN_MISMATCH",
            results: []
        })
    });

    const session = paidSetupSession(stack.roomId, 2);
    stack.paymentSessionManager._sessionsByRoom.set(stack.roomId, session);

    const result = await stack.paymentSessionManager._requestRoomWalletPartialPaymentRefund(
        session,
        "setup_expired"
    );

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(session.status, PAYMENT_SESSION_STATUS.REFUND_PENDING);
    assert.equal(
        stack.paymentSessionManager._roomWalletRefundRetryTimers.has(stack.roomId),
        false,
        "non-retryable safety failures must not schedule a background retry"
    );

    stack.shutdown();

    console.log("  J. non-retryable settlement rejection → no automatic retry passed");
}

// J2 — an explicitly non-retryable thrown adapter error must remain non-retryable.
{
    const stack = buildStack({
        refundPaymentsHandler: async () => {
            const error = new Error("permanent settlement safety rejection");
            error.retryable = false;
            throw error;
        }
    });

    const session = paidSetupSession(stack.roomId, 2);
    stack.paymentSessionManager._sessionsByRoom.set(stack.roomId, session);

    const result = await stack.paymentSessionManager._requestRoomWalletPartialPaymentRefund(
        session,
        "setup_expired"
    );

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(
        stack.paymentSessionManager._roomWalletRefundRetryTimers.has(stack.roomId),
        false,
        "an explicitly non-retryable thrown error must not schedule a background retry"
    );

    stack.shutdown();

    console.log("  J2. explicitly non-retryable thrown adapter error → no automatic retry passed");
}

// K — direct expiry must clear the actual pending Setup Session timer.
{
    const stack = buildStack();
    const timer = stack.setupSessionLifecycle._expiryTimers.get(stack.roomId);

    assert.ok(timer, "a real setup expiry timer is armed before expiry");

    const originalClearTimeout = globalThis.clearTimeout;
    let targetTimerCleared = false;

    globalThis.clearTimeout = (handle) => {
        if (handle === timer) {
            targetTimerCleared = true;
        }
        return originalClearTimeout(handle);
    };

    try {
        await triggerSetupExpiry(stack);
    } finally {
        globalThis.clearTimeout = originalClearTimeout;

        // Keep this regression test from leaving a five-minute orphan behind
        // if the assertion fails against an older implementation.
        if (!targetTimerCleared) {
            originalClearTimeout(timer);
        }
    }

    assert.equal(
        targetTimerCleared,
        true,
        "_onExpiry must clear the live timer, not only delete its map entry"
    );
    assert.equal(
        stack.setupSessionLifecycle._expiryTimers.has(stack.roomId),
        false,
        "the expired room must no longer have a registered Setup timer"
    );

    stack.shutdown();

    console.log("  K. direct expiry clears pending timer handle passed");
}

console.log("setupExpiryRoomWalletRefund.test.js passed");


// L — a single on-chain hash must never satisfy two participant refund claims.
{
    const stack = buildStack();
    const rgft = paidSetupSession("RGFT", 3);
    const snvb = paidSetupSession("sNvb", 3);

    for (const session of [rgft, snvb]) {
        session.status = PAYMENT_SESSION_STATUS.REFUND_PENDING;
        session.recoveryMetadata = {
            refundIdentityVersion: "room-wallet-refund-query-id-v1",
            refundRequestedAt: Date.now()
        };
        session.participants[0].refunded = true;
        session.participants[0].refundTxHash = "same-on-chain-hash";
        stack.paymentSessionManager._sessionsByRoom.set(session.roomId, session);
    }

    const beforeHash = rgft.participants[0].refundTxHash;
    const result = await stack.paymentSessionManager._requestRoomWalletPartialPaymentRefund(
        rgft,
        "test_duplicate_hash"
    );

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.code, "ROOM_WALLET_REFUND_HASH_CONFLICT");
    assert.equal(rgft.participants[0].refundTxHash, beforeHash);
    assert.equal(stack.refundCalls.length, 0, "no broadcast occurs when a hash is double-claimed");

    stack.shutdown();
    console.log("  L. duplicate refund hash across sessions fails closed passed");
}

// M — legacy pending refunds without query IDs are blocked before a new broadcast.
{
    const stack = buildStack();
    const session = paidSetupSession(stack.roomId, 2);
    session.status = PAYMENT_SESSION_STATUS.REFUND_PENDING;
    session.recoveryMetadata = {
        refundRequestedAt: Date.now(),
        refundPlan: {
            mode: "RECIPIENT_PAYS_GAS",
            entries: [{
                playerId: "p1",
                playerIndex: 0,
                wallet: "wallet-1",
                grossRefundNano: "10000000000",
                recipientGasChargeNano: "1000000",
                recipientTransferAmountNano: "9999000000"
            }]
        }
    };
    stack.paymentSessionManager._sessionsByRoom.set(stack.roomId, session);

    const result = await stack.paymentSessionManager._requestRoomWalletPartialPaymentRefund(
        session,
        "test_legacy_pending"
    );

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.code, "ROOM_WALLET_LEGACY_REFUND_REQUIRES_RECONCILIATION");
    assert.equal(stack.refundCalls.length, 0);
    assert.equal(session.status, PAYMENT_SESSION_STATUS.REFUND_PENDING);

    stack.shutdown();
    console.log("  M. legacy untagged refund retry is blocked before broadcast passed");
}

// N — an adapter success without a transaction hash is not authoritative refund proof.
{
    const stack = buildStack({
        roomWalletRefundRetryDelaysMs: [60_000],
        refundPaymentsHandler: async () => ({
            ok: true,
            results: [
                { ok: true, playerId: "p1", txHash: null },
                { ok: true, playerId: "p2", txHash: "" }
            ]
        })
    });
    const session = paidSetupSession(stack.roomId, 2);
    stack.paymentSessionManager._sessionsByRoom.set(stack.roomId, session);

    const result = await stack.paymentSessionManager._requestRoomWalletPartialPaymentRefund(
        session,
        "test_missing_hash"
    );

    assert.equal(result.ok, false);
    assert.equal(session.findParticipant("p1").refunded, false);
    assert.equal(session.findParticipant("p2").refunded, false);
    assert.equal(session.status, PAYMENT_SESSION_STATUS.REFUND_PENDING);

    stack.shutdown();
    console.log("  N. success without transaction hash cannot mark a refund complete passed");
}


// O — refund hash uniqueness checks fail closed if the authoritative persisted
// session index is unavailable. An in-memory session list alone is insufficient.
{
    const stack = buildStack({ financialPersistence: null });
    const session = paidSetupSession(stack.roomId, 2);
    stack.paymentSessionManager._sessionsByRoom.set(stack.roomId, session);

    const result = await stack.paymentSessionManager._requestRoomWalletPartialPaymentRefund(
        session,
        "test_hash_index_unavailable"
    );

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.code, "ROOM_WALLET_REFUND_HASH_INDEX_UNAVAILABLE");
    assert.equal(stack.refundCalls.length, 0, "no refund handoff without the global persisted claim index");
    assert.equal(session.findParticipant("p1").refunded, false);

    stack.shutdown();
    console.log("  O. missing persisted hash index fails closed passed");
}

 
// P — a stale in-memory copy must not erase a persisted cross-session hash claim.
{
    const sharedHash = "refund-claim-shared-across-sessions";
    const persistedOwner = paidSetupSession("stale-owner", 1);
    persistedOwner.status = PAYMENT_SESSION_STATUS.REFUND_PENDING;
    persistedOwner.participants[0].refunded = true;
    persistedOwner.participants[0].refundTxHash = sharedHash;

    const persistedRecord = {
        recordType: "payment_session",
        recordId: persistedOwner.paymentSessionId,
        payload: persistedOwner.toPayload()
    };

    const stack = buildStack({
        financialPersistence: { listActive: () => [persistedRecord] },
        refundPaymentsHandler: async () => ({
            ok: true,
            results: [{ ok: true, playerId: "p1", txHash: sharedHash }]
        })
    });

    // Same paymentSessionId/playerId as persistedOwner, but the stale object
    // has not yet learned about the persisted refund hash.
    const staleOwner = paidSetupSession("stale-owner", 1);
    staleOwner.participants[0].refunded = false;
    staleOwner.participants[0].refundTxHash = null;
    stack.paymentSessionManager._sessionsByRoom.set(staleOwner.roomId, staleOwner);

    // Isolate the claim-index behavior from the test harness's persistence writer.
    stack.paymentSessionManager._persistSession = () => {};

    const competingSession = paidSetupSession("competing-owner", 1);
    const result = await stack.paymentSessionManager._performRoomWalletPartialPaymentRefund(
        competingSession,
        "test_stale_memory_must_not_erase_claim"
    );

    assert.equal(result.ok, false);
    assert.equal(competingSession.findParticipant("p1").refunded, false);
    assert.equal(competingSession.findParticipant("p1").refundTxHash, null);
    assert.equal(
        stack.refundCalls.length,
        1,
        "the adapter result is checked against persisted cross-session claims"
    );

    stack.shutdown();
    console.log("  P. stale in-memory copy cannot erase persisted refund-hash claim passed");
}


// R — a stale roomNumber must not route a refund from a different catalog wallet.
{
    const stack = buildStack();
    const session = paidSetupSession(stack.roomId, 2);
    const historicalWallet = "EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le";
    session.roomWalletAddress = historicalWallet;
    for (const participant of session.participants) {
        participant.paymentDestination = historicalWallet;
    }
    stack.paymentSessionManager._sessionsByRoom.set(stack.roomId, session);

    const result = await stack.paymentSessionManager._requestRoomWalletPartialPaymentRefund(
        session,
        "test_historical_source_wallet_mismatch"
    );

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.code, "ROOM_WALLET_SOURCE_IDENTITY_MISMATCH");
    assert.equal(stack.refundCalls.length, 0, "no transfer may be attempted from the currently mapped wallet");
    assert.equal(session.findParticipant("p1").refunded, false);
    assert.equal(session.findParticipant("p2").refunded, false);

    stack.shutdown();
    console.log("  R. stored historical source wallet must match the current room-wallet mapping passed");
}


// Q — a success result for a different seat/wallet must not credit the named player.
{
    const stack = buildStack({
        roomWalletRefundRetryDelaysMs: [60_000],
        refundPaymentsHandler: async () => ({
            ok: true,
            results: [{
                ok: true,
                playerId: "p1",
                playerIndex: 1,
                wallet: "wallet-2",
                txHash: "foreign-participant-refund"
            }]
        })
    });
    const session = paidSetupSession(stack.roomId, 2);
    stack.paymentSessionManager._sessionsByRoom.set(stack.roomId, session);

    const result = await stack.paymentSessionManager._requestRoomWalletPartialPaymentRefund(
        session,
        "test_result_participant_identity_mismatch"
    );

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.code, "ROOM_WALLET_REFUND_ATTRIBUTION_CONFLICT");
    assert.equal(session.findParticipant("p1").refunded, false);
    assert.equal(session.findParticipant("p1").refundTxHash, null);
    assert.equal(session.findParticipant("p2").refunded, false);
    assert.equal(session.findParticipant("p2").refundTxHash, null);
    assert.equal(session.status, PAYMENT_SESSION_STATUS.REFUND_PENDING);

    stack.shutdown();
    console.log("  Q. mismatched playerId/playerIndex/wallet cannot credit or auto-retry a participant passed");
}

// S — a frozen refund obligation cannot be redirected to a changed player wallet.
{
    let planCalls = 0;
    const stack = buildStack({
        planRefundsHandler: async () => {
            planCalls += 1;
            return { ok: true, refundPlan: { mode: "RECIPIENT_PAYS_GAS", entries: [] } };
        }
    });
    const session = paidSetupSession(stack.roomId, 2);
    session.status = PAYMENT_SESSION_STATUS.REFUND_PENDING;
    session.recoveryMetadata = {
        refundIdentityVersion: "room-wallet-refund-query-id-v1",
        refundRequestedAt: Date.now(),
        refundPlan: {
            mode: "RECIPIENT_PAYS_GAS",
            entries: [{
                playerId: "p1",
                playerIndex: 0,
                wallet: "wallet-1",
                grossRefundNano: "10000000000",
                recipientGasChargeNano: "1000000",
                recipientTransferAmountNano: "9999000000",
                queryId: "123456789"
            }]
        }
    };
    // Simulate a stale/corrupted recipient identity after the original plan
    // was frozen; the source Room Wallet identity remains unchanged.
    session.findParticipant("p1").wallet = "wallet-changed";
    stack.paymentSessionManager._sessionsByRoom.set(stack.roomId, session);

    const result = await stack.paymentSessionManager._requestRoomWalletPartialPaymentRefund(
        session,
        "test_frozen_plan_recipient_change"
    );

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.code, "ROOM_WALLET_REFUND_PLAN_IDENTITY_MISMATCH");
    assert.equal(planCalls, 0, "do not append a new plan entry for a changed recipient");
    assert.equal(stack.refundCalls.length, 0, "do not broadcast to the changed recipient");
    assert.equal(session.findParticipant("p1").refunded, false);
    assert.equal(session.findParticipant("p1").wallet, "wallet-changed");

    stack.shutdown();
    console.log("  S. frozen refund plan blocks recipient wallet change passed");
}
