/**
 * Application wiring boundary for the room-wallet payment runtime.
 *
 * This module attaches an already-initialized, real payment runtime to the
 * real server collaborators (RoomManager, GameStartAuthorization). It does not
 * construct a second runtime, does not re-run initialization, and never
 * creates financial records on its own. It exists so the wiring that
 * `server/app.js` performs is exercised by integration tests against the exact
 * same collaborators the production runtime uses.
 *
 * What it guarantees:
 *   - the server-authoritative three-player payment gate is enforced on every
 *     gameplay-start entry point (they all funnel through GameStartAuthorization);
 *   - room destruction prepares durable refund obligations BEFORE the room's
 *     financial context is deleted (RoomManager -> RefundLifecycleCoordinator);
 *   - live payment-session preparation stays disabled while live acceptance is
 *     off, and channels late-arriving confirmed payments into safe refund
 *     reconciliation without reopening gameplay.
 */

import { PaymentExecutionBlockedError } from "../PaymentErrors.js";
import {
    LIVE_PAYMENT_ACCEPTANCE_ENABLED
} from "../PaymentLifecycleAvailability.js";
import { DESCRIPTOR_STAKE_RELATION } from "./RoomPaymentSessionAdapter.js";

/**
 * Attach an initialized payment runtime to the real application.
 *
 * @param {object} runtime result of buildPaymentRuntime(...).initialize(...)
 * @param {{
 *   roomManager?: object,
 *   gameStartAuthorization?: object,
 *   logger?: object|null
 * }} [dependencies]
 * @returns {Readonly<object>} a small controller (no background timers/workers)
 */
export function bindPaymentRuntimeToApplication(runtime, dependencies = {}) {

    const {
        roomManager = null,
        gameStartAuthorization = null,
        logger = null,
        // Test-only, per-binding-instance policy. Production app.js does not pass
        // it, so it resolves to the module constant LIVE_PAYMENT_ACCEPTANCE_ENABLED
        // (false) and production behavior is unchanged. No environment variable,
        // no mutable global, no cross-test leakage.
        paymentAcceptanceEnabled = LIVE_PAYMENT_ACCEPTANCE_ENABLED
    } = dependencies;

    if (!runtime || typeof runtime.initialize !== "function"
        || runtime.initialized !== true) {
        throw new Error(
            "bindPaymentRuntimeToApplication requires an initialized payment runtime"
        );
    }

    // 1. Room close -> durable refund obligations. RoomManager.destroyRoom()
    //    invokes refundLifecycle.prepareClosedRoom() after DESTROYED is
    //    authoritative and before ROOM_DESTROYED listeners / room deletion.
    if (roomManager && typeof roomManager.attachRefundLifecycle === "function") {

        roomManager.attachRefundLifecycle(runtime.refundLifecycle);

    }

    // 2. Enforce the three-player payment barrier on every game-start path.
    //    All entry points call GameStartAuthorization._checkStartConditions(),
    //    which reads paymentGate.getGameStartGateStatus(). A missing/cleared
    //    gate denies start (fail-closed).
    if (gameStartAuthorization
        && typeof gameStartAuthorization.configurePaymentGate === "function") {

        gameStartAuthorization.configurePaymentGate(runtime.paymentGate);

    }

    logger?.info?.(
        "Payment runtime bound to application"
            + ` | refundLifecycle=${Boolean(roomManager?.attachRefundLifecycle)}`
            + ` | paymentGate=${Boolean(gameStartAuthorization)}`
    );

    return Object.freeze({

        runtime,

        /**
         * Server-authoritative payment-session preparation seam. The trusted
         * server code (never a client) maps a room + authoritative per-player
         * payer identities + stakes into the immutable adapter descriptor.
         *
         * This is intentionally gated: while live payment acceptance is
         * disabled (no supported outgoing-refund path exists) it fails closed
         * and writes nothing. `playerPayments` must carry the authoritative
         * expected-sender address and amount for each of the room's players.
         *
         * @param {string} roomId
         * @param {Array<{ playerId: string, paymentReference: string,
         *   expectedSender: string, amountAtomic: number }>} playerPayments
         */
        prepareRoomPaymentSession(roomId, playerPayments) {

            if (!paymentAcceptanceEnabled) {

                throw new PaymentExecutionBlockedError(
                    "live room-wallet payment acceptance is disabled: payment-"
                        + "session preparation is unavailable until a supported "
                        + "outgoing-refund submission and finality path exists"
                );

            }

            if (!roomManager || typeof roomManager.getRoom !== "function") {
                throw new Error("roomManager.getRoom() is required for preparation");
            }

            const room = roomManager.getRoom(roomId);

            if (!room) {

                throw new PaymentExecutionBlockedError(
                    "room payment session cannot be prepared for a missing room"
                );

            }

            return runtime.sessionAdapter.prepareRoom({
                roomId,
                roomCreatedAt: room.createdAt,
                network: runtime.network,
                asset: "TON",
                stakeLedgerRelation: DESCRIPTOR_STAKE_RELATION,
                requiredPlayers: playerPayments.map((payment) => ({
                    roomId,
                    paymentReference: payment.paymentReference,
                    playerId: payment.playerId,
                    expectedSender: payment.expectedSender,
                    amountAtomic: payment.amountAtomic
                }))
            });

        },

        /**
         * Reconcile a payment that was confirmed AFTER its room closed. Creates
         * a refund obligation from the durable closed-room snapshot but never
         * reopens the room or authorizes gameplay.
         *
         * @param {string} roomId
         * @returns {Array<object>} refund obligations created (idempotent)
         */
        reconcileLateConfirmedPayments(roomId) {

            return runtime.refundLifecycle.prepareLateConfirmedPayments(roomId);

        }
    });

}

export default bindPaymentRuntimeToApplication;
