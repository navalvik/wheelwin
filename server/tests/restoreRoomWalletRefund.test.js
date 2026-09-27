/**
 * Restore-path Room Wallet refund tests — PaymentSessionManager.restorePaymentSessions().
 *
 * Verifies the current Room Wallet restart-restore behavior for persisted
 * sessions that still hold unrefunded paid funds:
 *
 *   A. Persisted FULLY_PAID (3/3 paid, none refunded): restored through
 *      restorePaymentSessions() despite being terminal, and the EXISTING Room
 *      Wallet refund machinery (_requestRoomWalletPartialPaymentRefund →
 *      RoomWalletSettlementAdapter.refundPayments) is requested for all three
 *      unrefunded participants.
 *   B. Persisted REFUND_PENDING mid-unwind (1/3 refunded): only the remaining
 *      unrefunded participants are re-requested; no duplicate request for the
 *      already-refunded participant.
 *   C. Persisted REFUND_PENDING with all participants refunded: no new refund
 *      broadcast; the existing finalize path completes the session
 *      (CANCELLED + PAYMENT_SESSION_FAILED).
 *   D. Persisted PARTIALLY_PAID (2/3): existing restore refund behavior still
 *      works (regression guard for the decision-helper swap).
 *   E. Room Wallet intake disabled: the new FULLY_PAID restore refund behavior
 *      is NOT activated (terminal session skipped; no refund request).
 *
 * Harness follows creatorLeftRoomWalletRefund.test.js / setupExpiryRoomWalletRefund.test.js
 * (fake settlement adapter + real managers) and financialPersistence.wiring.r810.test.js
 * (real TonFinancialPersistence over a temp dataDir, restart via a second stack).
 * Production code is not modified by this file.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { PlayerManager } from "../managers/PlayerManager.js";
import { RoomManager } from "../managers/RoomManager.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS,
    PaymentSession
} from "../models/PaymentSession.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";

function waitForAsync(ms = 25) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

/**
 * Build a persisted-shape Room Wallet payment session with `paidCount`
 * confirmed seats; `refundedIndexes` marks seats already refunded mid-unwind.
 */
function buildRestoreSession({
    roomId,
    status,
    paidCount = 3,
    refundedIndexes = []
}) {

    return new PaymentSession({
        paymentSessionId: `pay-restore-${roomId}`,
        roomId,
        roomNumber: 7,
        gameId: `game-${roomId}`,
        status,
        // Restart happens after the payment window passed — also prevents the
        // restore path from scheduling a fresh expiry timer.
        paymentDeadline: Date.now() - 60_000,
        recoveryMetadata: status === PAYMENT_SESSION_STATUS.REFUND_PENDING
            ? { unwindReason: "setup_expired", refundRequestedAt: Date.now() - 5000 }
            : null,
        roomWalletAddress: "EQRestoreRoomWalletAddressForTestsXXXXXXXXXXXXX",
        participants: [0, 1, 2].map((index) => ({
            playerId: `p${index + 1}`,
            playerIndex: index,
            wallet: `wallet-${index + 1}`,
            requiredGram: 10,
            status: index < paidCount
                ? PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                : PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION,
            paidAmount: index < paidCount ? 10 : 0,
            refunded: refundedIndexes.includes(index)
        }))
    });

}

function buildStack({
    dataDir,
    roomWalletPaymentIntakeEnabled = true
}) {

    const errorLogs = [];

    const logger = {
        info() {},
        error(...args) {

            errorLogs.push(args.map((arg) => String(arg?.message ?? arg)).join(" "));

        },
        warn() {},
        debug() {},
        decisionTrace() {}
    };

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    // Existing Room Wallet refund machinery — same adapter interface the
    // production RoomWalletSettlementRouter exposes to PaymentSessionManager.
    const refundCalls = [];

    const roomWalletSettlementAdapter = {
        async refundPayments(request) {

            refundCalls.push(request);

            return {
                ok: true,
                results: request.refunds.map((refund) => ({
                    ok: true,
                    playerId: refund.playerId,
                    txHash: `restore-refund-tx-${refund.playerId}-${refundCalls.length}`
                }))
            };

        }
    };

    const blockchainMonitor = {
        stopRoom() {},
        watchPayment() {},
        unwatchPayment() {},
        watchTransaction() {},
        unwatchTransaction() {}
    };

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const roomManager = new RoomManager({
        logger,
        eventBus,
        roomConfig: { maxPlayers: 3 }
    });

    roomManager.initialize();

    const financialPersistence = new TonFinancialPersistence({
        logger,
        dataDir
    });

    financialPersistence.initialize();

    const paymentSessionManager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager: { getIdentity() { return null; } },
        roomManager,
        blockchainMonitor,
        financialPersistence,
        devMode: false,
        roomWalletPaymentIntakeEnabled,
        roomWalletSettlementAdapter
    });

    paymentSessionManager.initialize();

    const failedEvents = [];

    eventBus.subscribe(EVENT_TYPES.PAYMENT_SESSION_FAILED, (envelope) => {

        failedEvents.push(envelope?.payload ?? envelope);

    });

    return {
        financialPersistence,
        paymentSessionManager,
        refundCalls,
        failedEvents,
        errorLogs,
        shutdown() {

            paymentSessionManager.shutdown?.();

            financialPersistence.shutdown({ checkpoint: false });

            eventBus.shutdown();

        }
    };

}

async function runCase(results, name, fn) {

    try {

        await fn();

        results.push({ name, ok: true });

        console.log(`  PASS  ${name}`);

    } catch (error) {

        results.push({ name, ok: false, error });

        console.log(`  FAIL  ${name}`);
        console.log(`        ${error?.message ?? error}`);

    }

}

const results = [];

// A — Persisted FULLY_PAID (3/3 paid, none refunded): the terminal restore
// gate must let the session through and the existing Room Wallet refund
// machinery must be requested for all three unrefunded participants.
await runCase(results, "A. persisted FULLY_PAID 3/3 restored, refund requested for all 3", async () => {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-restore-rw-a-"));

    const first = buildStack({ dataDir });

    first.paymentSessionManager._persistSession(
        buildRestoreSession({
            roomId: "room-restore-a",
            status: PAYMENT_SESSION_STATUS.FULLY_PAID
        }),
        "create"
    );

    first.shutdown();

    const second = buildStack({ dataDir });

    try {

        const summary = await second.paymentSessionManager.restorePaymentSessions();

        await waitForAsync();

        assert.equal(summary.restored, 1, "FULLY_PAID session is restored");

        const restored = second.paymentSessionManager.getSession("room-restore-a");

        assert.ok(restored, "session is reachable via getSession()");

        assert.equal(
            second.refundCalls.length,
            1,
            "existing Room Wallet refund machinery is requested once"
                + (second.errorLogs.length
                    ? ` | restore errors: ${second.errorLogs.join(" || ")}`
                    : "")
        );

        const refundTargets = second.refundCalls[0].refunds.map((refund) => refund.playerId);

        assert.deepEqual(
            [...refundTargets].sort(),
            ["p1", "p2", "p3"],
            "all three unrefunded participants are refund targets"
        );

        assert.equal(
            restored.status,
            PAYMENT_SESSION_STATUS.CANCELLED,
            "existing machinery unwinds the restored session to CANCELLED"
        );

        assert.equal(second.failedEvents.length, 1, "PAYMENT_SESSION_FAILED emitted once");

    } finally {

        second.shutdown();

        TonFinancialPersistence.destroyStorage(dataDir);

    }

});

// B — Persisted REFUND_PENDING mid-unwind (1/3 refunded): restore re-requests
// only the remaining unrefunded participants; no duplicate for the refunded one.
await runCase(results, "B. REFUND_PENDING 1/3 refunded → only unrefunded re-requested", async () => {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-restore-rw-b-"));

    const first = buildStack({ dataDir });

    first.paymentSessionManager._persistSession(
        buildRestoreSession({
            roomId: "room-restore-b",
            status: PAYMENT_SESSION_STATUS.REFUND_PENDING,
            refundedIndexes: [0]
        }),
        "create"
    );

    first.shutdown();

    const second = buildStack({ dataDir });

    try {

        const summary = await second.paymentSessionManager.restorePaymentSessions();

        await waitForAsync();

        assert.equal(summary.restored, 1, "mid-unwind session is restored");

        assert.equal(second.refundCalls.length, 1, "exactly one refund handoff");

        const refundTargets = second.refundCalls[0].refunds.map((refund) => refund.playerId);

        assert.deepEqual(
            refundTargets,
            ["p2", "p3"],
            "only the two unrefunded participants are re-requested"
        );

        assert.equal(
            refundTargets.includes("p1"),
            false,
            "no duplicate request for the already-refunded participant"
        );

        const restored = second.paymentSessionManager.getSession("room-restore-b");

        assert.equal(
            restored.findParticipant("p1").refunded,
            true,
            "already-refunded participant state is preserved"
        );

        assert.equal(
            restored.status,
            PAYMENT_SESSION_STATUS.CANCELLED,
            "mid-unwind session completes via the existing finalize path"
        );

        assert.equal(second.failedEvents.length, 1);

        assert.equal(second.failedEvents[0].reason, "setup_expired");

    } finally {

        second.shutdown();

        TonFinancialPersistence.destroyStorage(dataDir);

    }

});

// C — Persisted REFUND_PENDING with ALL participants refunded: no new refund
// broadcast; the existing finalize path completes the session.
await runCase(results, "C. REFUND_PENDING all refunded → no broadcast, finalize completes", async () => {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-restore-rw-c-"));

    const first = buildStack({ dataDir });

    first.paymentSessionManager._persistSession(
        buildRestoreSession({
            roomId: "room-restore-c",
            status: PAYMENT_SESSION_STATUS.REFUND_PENDING,
            refundedIndexes: [0, 1, 2]
        }),
        "create"
    );

    first.shutdown();

    const second = buildStack({ dataDir });

    try {

        const summary = await second.paymentSessionManager.restorePaymentSessions();

        await waitForAsync();

        assert.equal(summary.restored, 1, "fully-refunded unwind session is restored");

        assert.equal(
            second.refundCalls.length,
            0,
            "no new refund broadcast when everything is already refunded"
        );

        const restored = second.paymentSessionManager.getSession("room-restore-c");

        assert.equal(
            restored.status,
            PAYMENT_SESSION_STATUS.CANCELLED,
            "existing finalize path completes the session"
        );

        assert.equal(
            second.failedEvents.length,
            1,
            "PAYMENT_SESSION_FAILED emitted by the existing finalize path"
        );

    } finally {

        second.shutdown();

        TonFinancialPersistence.destroyStorage(dataDir);

    }

});

// D — Persisted PARTIALLY_PAID (2/3): existing restore refund behavior still
// works (regression guard — the decision-helper swap must not change it).
await runCase(results, "D. persisted PARTIALLY_PAID 2/3 → existing refund behavior preserved", async () => {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-restore-rw-d-"));

    const first = buildStack({ dataDir });

    first.paymentSessionManager._persistSession(
        buildRestoreSession({
            roomId: "room-restore-d",
            status: PAYMENT_SESSION_STATUS.PARTIALLY_PAID,
            paidCount: 2
        }),
        "create"
    );

    first.shutdown();

    const second = buildStack({ dataDir });

    try {

        const summary = await second.paymentSessionManager.restorePaymentSessions();

        await waitForAsync();

        assert.equal(summary.restored, 1);

        assert.equal(second.refundCalls.length, 1);

        const refundTargets = second.refundCalls[0].refunds.map((refund) => refund.playerId);

        assert.deepEqual(
            refundTargets,
            ["p1", "p2"],
            "only the two confirmed players are refund targets"
        );

        const restored = second.paymentSessionManager.getSession("room-restore-d");

        assert.equal(restored.status, PAYMENT_SESSION_STATUS.CANCELLED);

        assert.equal(second.failedEvents.length, 1);

    } finally {

        second.shutdown();

        TonFinancialPersistence.destroyStorage(dataDir);

    }

});

// E — Room Wallet intake disabled: the new FULLY_PAID restore refund behavior
// is NOT activated — terminal session stays skipped and no refund is requested.
await runCase(results, "E. intake disabled → FULLY_PAID restore refund NOT activated", async () => {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-restore-rw-e-"));

    const first = buildStack({ dataDir, roomWalletPaymentIntakeEnabled: false });

    first.paymentSessionManager._persistSession(
        buildRestoreSession({
            roomId: "room-restore-e-full",
            status: PAYMENT_SESSION_STATUS.FULLY_PAID
        }),
        "create"
    );

    first.paymentSessionManager._persistSession(
        buildRestoreSession({
            roomId: "room-restore-e-refund",
            status: PAYMENT_SESSION_STATUS.REFUND_PENDING,
            paidCount: 2
        }),
        "create"
    );

    first.shutdown();

    const second = buildStack({ dataDir, roomWalletPaymentIntakeEnabled: false });

    try {

        const summary = await second.paymentSessionManager.restorePaymentSessions();

        await waitForAsync();

        assert.equal(
            summary.restored,
            1,
            "only the non-terminal REFUND_PENDING session restores"
        );

        assert.equal(
            second.paymentSessionManager.getSession("room-restore-e-full"),
            null,
            "terminal FULLY_PAID session is not restored when intake is disabled"
        );

        const restoredRefund = second.paymentSessionManager.getSession("room-restore-e-refund");

        assert.ok(restoredRefund, "REFUND_PENDING session still restores");

        assert.equal(restoredRefund.status, PAYMENT_SESSION_STATUS.REFUND_PENDING);

        assert.equal(
            second.refundCalls.length,
            0,
            "no Room Wallet refund is requested when intake is disabled"
        );

        assert.equal(second.failedEvents.length, 0);

    } finally {

        second.shutdown();

        TonFinancialPersistence.destroyStorage(dataDir);

    }

});

console.log("");

console.log("restoreRoomWalletRefund results:");

for (const result of results) {

    console.log(
        `  ${result.ok ? "PASS" : "FAIL"}  ${result.name}`
            + (result.ok ? "" : `\n        → ${result.error?.message ?? result.error}`)
    );

}

const failedCount = results.filter((result) => !result.ok).length;

if (failedCount > 0) {

    console.log(
        `restoreRoomWalletRefund.test.js FAILED (${failedCount}/${results.length} cases failed)`
    );

    process.exitCode = 1;

} else {

    console.log("restoreRoomWalletRefund.test.js passed");

}




