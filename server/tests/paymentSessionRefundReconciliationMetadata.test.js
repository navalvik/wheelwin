/**
 * Stage 2 — PaymentSessionManager refund reconciliation provenance tests.
 *
 * Proves that the EXISTING Room Wallet refund machinery
 * (_requestRoomWalletPartialPaymentRefund → settlement adapter refundPayments)
 * records non-authoritative observability metadata when a refund was adopted
 * from the destination player's own inbound wallet history
 * (result code REFUND_RECONCILED_FROM_PLAYER_WALLET, reconciliation
 * "PLAYER_WALLET_INBOUND"), and that:
 *
 *   A. A PLAYER_WALLET_INBOUND refund keeps the existing participant behavior
 *      (refunded=true, refundTxHash unchanged) and appends exactly one
 *      compact entry to session.recoveryMetadata.refundReconciliations
 *      (playerId, playerIndex, wallet, reconciliation, transactionHash,
 *      reconciledAt) — no refund amount, no raw blockchain payload — plus
 *      exactly one ROOM_WALLET_REFUND_RECONCILED info log, and the metadata
 *      is durably persisted with the session.
 *   B. A repeated recovery/refund pass delivering the SAME successful
 *      reconciliation result (same playerId + txHash) does NOT create a
 *      duplicate metadata entry (idempotent; first write wins).
 *   C. A normal REFUND_ADOPTED result (Room Wallet outbound history) does NOT
 *      create PLAYER_WALLET_INBOUND metadata.
 *
 * Harness follows restoreRoomWalletRefund.test.js (fake settlement adapter +
 * real managers + real TonFinancialPersistence over a temp dataDir). Fully
 * offline — no live network, no blockchain broadcast.
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
import {
    TON_FINANCIAL_RECORD_TYPES,
    TonFinancialPersistence
} from "../persistence/TonFinancialPersistence.js";

function waitForAsync(ms = 50) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

/**
 * Build a persisted-shape Room Wallet payment session with `paidCount`
 * confirmed seats (p1..p3, wallets wallet-1..wallet-3).
 */
function buildReconciliationSession({ roomId, paidCount = 1 }) {

    return new PaymentSession({
        paymentSessionId: `pay-recon-${roomId}`,
        roomId,
        roomNumber: 7,
        gameId: `game-${roomId}`,
        status: paidCount === 3
            ? PAYMENT_SESSION_STATUS.FULLY_PAID
            : PAYMENT_SESSION_STATUS.PARTIALLY_PAID,
        // Expiry already passed — prevents the restore path from scheduling a
        // fresh expiry timer (same trick as restoreRoomWalletRefund.test.js).
        paymentDeadline: Date.now() - 60_000,
        roomWalletAddress: "EQReconciliationRoomWalletAddressForTestsXXXXXX",
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

/**
 * Stack with the existing Room Wallet refund machinery faked at the same
 * adapter interface the production RoomWalletSettlementRouter exposes.
 * `buildRefundResult(request, callCount)` returns the full adapter result.
 */
function buildStack({ dataDir, buildRefundResult }) {

    const infoLogs = [];

    const errorLogs = [];

    const logger = {
        info(...args) {

            infoLogs.push(args.map((arg) => String(arg?.message ?? arg)).join(" "));

        },
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

    const refundCalls = [];

    const roomWalletSettlementAdapter = {
        async refundPayments(request) {

            refundCalls.push(request);

            return buildRefundResult(request, refundCalls.length);

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
        roomWalletPaymentIntakeEnabled: true,
        roomWalletSettlementAdapter
    });

    paymentSessionManager.initialize();

    const failedEvents = [];

    eventBus.subscribe(EVENT_TYPES.PAYMENT_SESSION_FAILED, (envelope) => {

        failedEvents.push(envelope?.payload ?? envelope);

    });

    const reconciledLogs = () => infoLogs.filter((line) =>
        line.includes("ROOM_WALLET_REFUND_RECONCILED")
    );

    return {
        financialPersistence,
        paymentSessionManager,
        refundCalls,
        failedEvents,
        infoLogs,
        errorLogs,
        reconciledLogs,
        shutdown() {

            paymentSessionManager.shutdown?.();

            financialPersistence.shutdown({ checkpoint: false });

            eventBus.shutdown();

        }
    };

}

/** Build a fresh stack over the SAME dataDir and restore persisted sessions. */
async function restoreOver(dataDir, buildRefundResult) {

    const stack = buildStack({ dataDir, buildRefundResult });

    const summary = await stack.paymentSessionManager.restorePaymentSessions();

    await waitForAsync();

    return { stack, summary };

}

/**
 * Successful PLAYER_WALLET_INBOUND reconciliation result — mirrors the
 * RoomWalletSettlementAdapter result shape (including amountNano, which must
 * NOT leak into the recovery metadata).
 */
function playerWalletInboundResult(playerId, playerIndex, wallet) {

    return {
        ok: true,
        code: "REFUND_RECONCILED_FROM_PLAYER_WALLET",
        confirmed: true,
        reconciliation: "PLAYER_WALLET_INBOUND",
        playerId,
        playerIndex,
        wallet,
        amountNano: 1_000_000_000n,
        txHash: "player-inbound-refund"
    };

}

function findPersistedRecord(stack, paymentSessionId) {

    const records = stack.financialPersistence.listActive(
        TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION
    );

    return (records ?? []).find(
        (record) => (record?.payload ?? record)?.paymentSessionId === paymentSessionId
    ) ?? null;

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

// A — PLAYER_WALLET_INBOUND refund: existing participant behavior unchanged,
// exactly one compact provenance entry in recoveryMetadata (no amounts),
// exactly one ROOM_WALLET_REFUND_RECONCILED info log, and the metadata is
// durably persisted with the session record.
await runCase(
    results,
    "A. PLAYER_WALLET_INBOUND refund records reconciliation provenance metadata",
    async () => {

        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-refund-recon-a-"));

        const roomId = "room-recon-a";

        const first = buildStack({
            dataDir,
            buildRefundResult: () => ({ ok: true, results: [] })
        });

        first.paymentSessionManager._persistSession(
            buildReconciliationSession({ roomId, paidCount: 1 }),
            "create"
        );

        first.shutdown();

        const { stack: second } = await restoreOver(
            dataDir,
            (request) => ({
                ok: true,
                results: request.refunds.map((refund) =>
                    playerWalletInboundResult(
                        refund.playerId,
                        refund.playerIndex,
                        refund.wallet
                    )
                )
            })
        );

        try {

            assert.equal(
                second.refundCalls.length,
                1,
                "existing Room Wallet refund machinery is requested once"
                    + (second.errorLogs.length
                        ? ` | errors: ${second.errorLogs.join(" || ")}`
                        : "")
            );

            const session = second.paymentSessionManager.getSession(roomId);

            assert.ok(session, "restored session is reachable via getSession()");

            const participant = session.findParticipant("p1");

            assert.equal(participant.refunded, true, "participant becomes refunded=true");

            assert.equal(
                participant.refundTxHash,
                "player-inbound-refund",
                "participant.refundTxHash keeps the reconciled transaction hash"
            );

            const metadata = session.recoveryMetadata;

            assert.ok(metadata, "session.recoveryMetadata exists");

            const entries = metadata.refundReconciliations;

            assert.ok(Array.isArray(entries), "refundReconciliations array exists");

            assert.equal(
                entries.length,
                1,
                "exactly one reconciliation entry for the player"
            );

            const entry = entries[0];

            assert.equal(entry.playerId, "p1");
            assert.equal(entry.playerIndex, 0);
            assert.equal(entry.wallet, "wallet-1");
            assert.equal(entry.reconciliation, "PLAYER_WALLET_INBOUND");
            assert.equal(entry.transactionHash, "player-inbound-refund");
            assert.equal(typeof entry.reconciledAt, "number");

            assert.deepEqual(
                Object.keys(entry).sort(),
                [
                    "playerId",
                    "playerIndex",
                    "reconciledAt",
                    "reconciliation",
                    "transactionHash",
                    "wallet"
                ],
                "entry carries only provenance identifiers — no refund amount"
            );

            assert.equal(
                Object.keys(metadata).some((key) => /amount/i.test(key)),
                false,
                "no refund amount is added to recoveryMetadata"
            );

            const reconciledLogs = second.reconciledLogs();

            assert.equal(reconciledLogs.length, 1, "exactly one reconciliation info log");

            assert.match(reconciledLogs[0], /ROOM_WALLET_REFUND_RECONCILED/);
            assert.match(reconciledLogs[0], new RegExp(`roomId=${roomId}`));
            assert.match(reconciledLogs[0], /playerId=p1/);
            assert.match(reconciledLogs[0], /playerWallet=wallet-1/);
            assert.match(reconciledLogs[0], /txHash=player-inbound-refund/);
            assert.match(reconciledLogs[0], /method=PLAYER_WALLET_INBOUND/);

            const record = findPersistedRecord(second, `pay-recon-${roomId}`);

            assert.ok(record, "persisted payment session record found");

            const persistedMetadata = (record.payload ?? record).recoveryMetadata;

            assert.ok(
                Array.isArray(persistedMetadata?.refundReconciliations),
                "reconciliation metadata is durably persisted"
            );

            assert.equal(persistedMetadata.refundReconciliations.length, 1);

            assert.equal(
                persistedMetadata.refundReconciliations[0].transactionHash,
                "player-inbound-refund"
            );

            assert.equal(
                session.status,
                PAYMENT_SESSION_STATUS.CANCELLED,
                "existing unwind finalize behavior is unchanged"
            );

            assert.equal(
                second.failedEvents.length,
                1,
                "PAYMENT_SESSION_FAILED emitted once (existing behavior)"
            );

        } finally {

            second.shutdown();

            TonFinancialPersistence.destroyStorage(dataDir);

        }

    }
);

// B — Idempotency: delivering the SAME successful reconciliation result twice
// through the existing recovery/refund path leaves exactly one metadata entry
// for the same playerId + transactionHash (first write wins).
await runCase(
    results,
    "B. repeated refund pass with same reconciliation result stays idempotent",
    async () => {

        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-refund-recon-b-"));

        const roomId = "room-recon-b";

        const first = buildStack({
            dataDir,
            buildRefundResult: () => ({ ok: true, results: [] })
        });

        first.paymentSessionManager._persistSession(
            buildReconciliationSession({ roomId, paidCount: 2 }),
            "create"
        );

        first.shutdown();

        const buildResult = (request) => ({
            ok: false,
            results: request.refunds.map((refund) => (
                refund.playerId === "p1"
                    ? playerWalletInboundResult(
                        refund.playerId,
                        refund.playerIndex,
                        refund.wallet
                    )
                    : {
                        // p2 stays unrefunded so the session remains
                        // REFUND_PENDING and can be re-requested.
                        ok: false,
                        retryable: true,
                        code: "REFUND_BROADCAST_FAILED",
                        playerId: refund.playerId,
                        playerIndex: refund.playerIndex,
                        wallet: refund.wallet
                    }
            ))
        });

        const { stack: second } = await restoreOver(dataDir, buildResult);

        try {

            assert.equal(second.refundCalls.length, 1, "first refund pass requested");

            const session = second.paymentSessionManager.getSession(roomId);

            assert.ok(session, "restored session is reachable via getSession()");

            const metadata = session.recoveryMetadata;

            const entries = metadata.refundReconciliations;

            assert.equal(entries.length, 1, "one entry after the first pass");

            const firstReconciledAt = entries[0].reconciledAt;

            const participant = session.findParticipant("p1");

            assert.equal(participant.refunded, true);

            assert.equal(session.status, PAYMENT_SESSION_STATUS.REFUND_PENDING);

            // Simulate the same reconciliation result being re-delivered on a
            // repeated recovery/refund pass before the refunded flag lands:
            // the participant is pending again and the adapter returns the
            // identical PLAYER_WALLET_INBOUND result (same txHash).
            participant.refunded = false;

            await second.paymentSessionManager._requestRoomWalletPartialPaymentRefund(
                session,
                "setup_expired"
            );

            assert.equal(
                second.refundCalls.length,
                2,
                "the same successful reconciliation result was processed twice"
            );

            const entriesAfter = session.recoveryMetadata.refundReconciliations;

            assert.equal(
                entriesAfter.length,
                1,
                "still exactly one metadata entry for the same playerId + txHash"
            );

            assert.equal(entriesAfter[0].transactionHash, "player-inbound-refund");

            assert.equal(entriesAfter[0].playerId, "p1");

            assert.equal(
                entriesAfter[0].reconciledAt,
                firstReconciledAt,
                "first write wins — no rewrite on the repeated pass"
            );

            assert.equal(participant.refunded, true);

            assert.equal(participant.refundTxHash, "player-inbound-refund");

            assert.equal(
                second.reconciledLogs().length,
                1,
                "no repeated reconciliation log for the duplicate result"
            );

            assert.equal(
                session.status,
                PAYMENT_SESSION_STATUS.REFUND_PENDING,
                "no lifecycle change: p2 still unrefunded"
            );

        } finally {

            second.shutdown();

            TonFinancialPersistence.destroyStorage(dataDir);

        }

    }
);

// C — Normal REFUND_ADOPTED (Room Wallet outbound history): participant
// behavior unchanged and NO PLAYER_WALLET_INBOUND metadata is created.
await runCase(
    results,
    "C. REFUND_ADOPTED does not create PLAYER_WALLET_INBOUND metadata",
    async () => {

        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-refund-recon-c-"));

        const roomId = "room-recon-c";

        const first = buildStack({
            dataDir,
            buildRefundResult: () => ({ ok: true, results: [] })
        });

        first.paymentSessionManager._persistSession(
            buildReconciliationSession({ roomId, paidCount: 1 }),
            "create"
        );

        first.shutdown();

        const { stack: second } = await restoreOver(
            dataDir,
            (request) => ({
                ok: true,
                results: request.refunds.map((refund) => ({
                    ok: true,
                    code: "REFUND_ADOPTED",
                    confirmed: true,
                    playerId: refund.playerId,
                    playerIndex: refund.playerIndex,
                    wallet: refund.wallet,
                    txHash: "room-wallet-outbound-refund-1"
                }))
            })
        );

        try {

            assert.equal(second.refundCalls.length, 1);

            const session = second.paymentSessionManager.getSession(roomId);

            assert.ok(session, "restored session is reachable via getSession()");

            const participant = session.findParticipant("p1");

            assert.equal(participant.refunded, true);

            assert.equal(participant.refundTxHash, "room-wallet-outbound-refund-1");

            const metadata = session.recoveryMetadata;

            assert.ok(metadata, "recoveryMetadata still exists (unwindReason etc.)");

            assert.equal(
                metadata.refundReconciliations,
                undefined,
                "no PLAYER_WALLET_INBOUND metadata for REFUND_ADOPTED"
            );

            assert.equal(
                metadata.unwindReason,
                "room_destroyed",
                "existing recoveryMetadata fields are untouched (restore-path reason)"
            );

            assert.equal(
                second.reconciledLogs().length,
                0,
                "no reconciliation info log for REFUND_ADOPTED"
            );

            assert.equal(
                session.status,
                PAYMENT_SESSION_STATUS.CANCELLED,
                "existing unwind finalize behavior is unchanged"
            );

        } finally {

            second.shutdown();

            TonFinancialPersistence.destroyStorage(dataDir);

        }

    }
);

console.log("");

console.log("paymentSessionRefundReconciliationMetadata results:");

for (const result of results) {

    console.log(
        `  ${result.ok ? "PASS" : "FAIL"}  ${result.name}`
            + (result.ok ? "" : `\n        → ${result.error?.message ?? result.error}`)
    );

}

const failedCount = results.filter((result) => !result.ok).length;

if (failedCount > 0) {

    console.log(
        `paymentSessionRefundReconciliationMetadata.test.js FAILED`
            + ` (${failedCount}/${results.length} cases failed)`
    );

    process.exitCode = 1;

} else {

    console.log("paymentSessionRefundReconciliationMetadata.test.js passed");

}




