/**
 * Phase 1 — Room Wallet Payment Layer: authoritative service.
 *
 * SCOPE (Phase 1): wallet-pool model, payment-intent model, validated state
 * transitions, durable persistence and idempotency. This service NEVER
 * executes, broadcasts, or retries a blockchain transaction, and NEVER enables
 * real Testnet / Mainnet payment collection.
 *
 * CONTRACT PROHIBITION: no smart contract, escrow, deposit contract, or
 * deployment manager is referenced anywhere in this module (R9).
 */

import { join } from "node:path";

import {
    ROOM_LIFETIME_MS,
    ROOM_WALLET_POOL_SIZE,
    DEFAULT_ROOM_WALLET_NETWORK
} from "./RoomPaymentConstants.js";

import { createRoomDeadline } from "./RoomDeadline.js";
import { PaymentIntent } from "./PaymentIntent.js";
import {
    isTerminalPaymentIntentState,
    PAYMENT_INTENT_STATE
} from "./PaymentIntentStatus.js";
import { AssetDenominationRegistry } from "./AssetDenomination.js";
import {
    WalletPoolRegistry,
    atomicWriteJson
} from "./WalletPoolRegistry.js";
import { PaymentIntentStore } from "./PaymentIntentStore.js";
import {
    PaymentExecutionBlockedError,
    PaymentIntentExpiredError,
    PaymentReferenceCollisionError,
    PaymentValidationError,
    TransactionAlreadyCreditedError,
    WalletAssignmentConflictError
} from "./PaymentErrors.js";

export const ROOM_WALLET_PAYMENT_PHASE = 1;

export class RoomWalletPaymentService {

    constructor({
        walletPool,
        intentStore,
        assetRegistry,
        logger = null,
        snapshotDir = null,
        nowProvider = Date.now,
        paymentWindowMs = ROOM_LIFETIME_MS,
        persistSnapshots = true
    } = {}) {

        if (!(walletPool instanceof WalletPoolRegistry)) {

            throw new PaymentValidationError(
                "walletPool must be a WalletPoolRegistry instance"
            );

        }

        if (!(intentStore instanceof PaymentIntentStore)) {

            throw new PaymentValidationError(
                "intentStore must be a PaymentIntentStore instance"
            );

        }

        if (!(assetRegistry instanceof AssetDenominationRegistry)) {

            throw new PaymentValidationError(
                "assetRegistry must be an AssetDenominationRegistry instance"
            );

        }

        if (!Number.isInteger(paymentWindowMs)
            || paymentWindowMs <= 0
            || paymentWindowMs > ROOM_LIFETIME_MS) {

            throw new PaymentValidationError(
                `paymentWindowMs must be an integer in 1..${ROOM_LIFETIME_MS}`,
                { paymentWindowMs }
            );

        }

        this._walletPool = walletPool;

        this._intentStore = intentStore;

        this._assetRegistry = assetRegistry;

        this._logger = logger;

        this._snapshotDir = snapshotDir ?? join(intentStore.dataDir, "payment-core");

        this._nowProvider = nowProvider;

        this._paymentWindowMs = paymentWindowMs;

        this._persistSnapshots = persistSnapshots === true;

        this._initialized = false;

    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    /**
     * Load durable state, then reconcile wallet reservations against the
     * persisted payment-intent ledger.
     *
     * @param {{ snapshotDir?: string }} [options]
     */
    initialize(options = {}) {

        const snapshotDir = options.snapshotDir ?? this._snapshotDir;

        this._walletPool.initialize({ snapshotDir });

        this._intentStore.initialize();

        // R8 — a wallet is never recycled while its previous room still has
        // unresolved obligations. Restore only still-owed reservations.
        const obligations = this._collectObligationsByRoom();

        this._walletPool.reconcile({ obligationsByRoom: obligations });

        this._initialized = true;

        this._logInfo(
            "RoomWalletPaymentService ready"
                + ` | phase=${ROOM_WALLET_PAYMENT_PHASE}`
                + ` | wallets=${this._walletPool.size}`
                + ` | intents=${this._intentStore.size}`
                + ` | transfersEnabled=false`
        );

    }

    /**
     * Persist the wallet registry snapshot next to the payment-intent ledger so
     * that a restart keeps reservations consistent with obligations.
     */
    persistSnapshot() {

        if (!this._persistSnapshots) {

            return null;

        }

        return this._walletPool.persistSnapshot(this._snapshotDir);

    }

    shutdown() {

        this.persistSnapshot();

        this._initialized = false;

    }

    // -------------------------------------------------------------------------
    // Room deadline (R1)
    // -------------------------------------------------------------------------

    /**
     * The single, immutable room deadline: `roomCreatedAt + 480000` ms.
     *
     * @param {number} roomCreatedAt
     * @returns {{ roomCreatedAt: number, roomLifetimeMs: number, deadlineMs: number }}
     */
    getRoomDeadline(roomCreatedAt) {

        return createRoomDeadline(roomCreatedAt).toJSON();

    }

    /**
     * Absolute room pool lifetime. Fixed at exactly 480 seconds.
     */
    get roomLifetimeMs() {

        return ROOM_LIFETIME_MS;

    }

    // -------------------------------------------------------------------------
    // Payment intents
    // -------------------------------------------------------------------------

    /**
     * Create, persist and return a distinct payment intent for a player.
     *
     * @param {{
     *   paymentReference: string,
     *   roomId: string,
     *   playerId: string,
     *   expectedSender: string,
     *   amountAtomic: number,
     *   roomCreatedAt: number,
     *   asset?: string,
     *   network?: string,
     *   walletId?: string
     * }} request
     * @returns {PaymentIntent}
     */
    createPaymentIntent({
        paymentReference,
        roomId,
        playerId,
        expectedSender,
        amountAtomic,
        asset,
        network = DEFAULT_ROOM_WALLET_NETWORK,
        walletId = null,
        roomCreatedAt,
        now = null
    }) {

        this._assertInitialized();

        if (typeof paymentReference !== "string" || paymentReference.trim() === "") {

            throw new PaymentValidationError(
                "paymentReference must be a non-empty string"
            );

        }

        if (this._intentStore.has(paymentReference)) {

            // R6 — one distinct, persistent payment intent per player payment.
            throw new PaymentReferenceCollisionError(paymentReference, {
                roomId,
                playerId
            });

        }

        const effectiveNow = now ?? this._now();

        const roomDeadline = createRoomDeadline(roomCreatedAt);

        // A payment intent must be created strictly before the immutable room
        // deadline. There is no point accepting payment for a room whose
        // lifetime has already elapsed.
        if (effectiveNow >= roomDeadline.deadlineMs) {

            throw new PaymentIntentExpiredError(
                paymentReference,
                roomDeadline.deadlineMs,
                {
                    roomId,
                    playerId,
                    now: effectiveNow,
                    reason: "room deadline already reached"
                }
            );

        }

        const requestedNetwork = network ?? DEFAULT_ROOM_WALLET_NETWORK;

        // D2 — reject when the asset/denomination mapping is not configured.
        const mapping = this._assetRegistry.requireMapping(requestedNetwork, asset);

        // Integer-only amount validation against the explicit mapping.
        if (amountAtomic % mapping.atomicUnitsPerUnit !== 0) {

            throw new PaymentValidationError(
                "amountAtomic is not an exact multiple of the configured "
                    + "atomic-unit denomination",
                {
                    amountAtomic,
                    atomicUnitsPerUnit: mapping.atomicUnitsPerUnit,
                    asset: mapping.asset,
                    network: requestedNetwork
                }
            );

        }

        const expiresAt = Math.min(
            roomDeadline.deadlineMs,
            effectiveNow + this._paymentWindowMs
        );

        // R3 — at most one wallet per active room. A room that already holds a
        // reservation reuses it (several players may pay into the same room
        // wallet); otherwise exactly one wallet is reserved for it.
        const existingReservation = this._walletPool.getReservationForRoom(roomId);

        let reservationWallet;

        if (existingReservation) {

            if (walletId !== null && walletId !== existingReservation.walletId) {

                throw new WalletAssignmentConflictError(
                    "room already has a different wallet assigned",
                    {
                        roomId,
                        assignedWalletId: existingReservation.walletId,
                        requestedWalletId: walletId
                    }
                );

            }

            reservationWallet = existingReservation;

        } else {

            try {

                reservationWallet = this._walletPool.reserve({
                    roomId,
                    network: requestedNetwork,
                    walletId
                }).wallet;

            } catch (error) {

                throw error;

            }

        }

        let intent;

        try {

            intent = new PaymentIntent({
                paymentReference,
                roomId,
                playerId,
                network: requestedNetwork,
                destinationWalletId: reservationWallet.walletId,
                destinationWalletAddress: reservationWallet.address,
                expectedSender,
                amountAtomic,
                asset: mapping.asset,
                createdAt: effectiveNow,
                expiresAt,
                roomDeadlineMs: roomDeadline.deadlineMs
            });

            this._intentStore.save(intent);

        } catch (error) {

            // Never leave an orphan reservation on a failed intent creation.
            this._walletPool.release({
                roomId,
                unresolvedObligations: this._countOpenObligationsForRoom(roomId)
            });

            throw error;

        }

        this.persistSnapshot();

        this._logInfo(
            `Payment intent created | ref=${paymentReference}`
                + ` | room=${roomId} | player=${playerId}`
                + ` | wallet=${reservationWallet.walletId}`
                + ` | amountAtomic=${amountAtomic}`
                + ` | expiresAt=${expiresAt}`
        );

        return intent;

    }

    /**
     * R6 — retrieve a payment intent by its unique payment reference.
     *
     * @param {string} paymentReference
     * @returns {PaymentIntent}
     */
    getPaymentIntent(paymentReference) {

        this._assertInitialized();

        return this._intentStore.require(paymentReference);

    }

    /**
     * @param {string} paymentReference
     * @returns {boolean}
     */
    hasPaymentIntent(paymentReference) {

        return this._intentStore.has(paymentReference);

    }

    /**
     * @param {string} roomId
     * @returns {Array<PaymentIntent>}
     */
    listPaymentIntentsForRoom(roomId) {

        this._assertInitialized();

        return this._intentStore.listForRoom(roomId);

    }

    // -------------------------------------------------------------------------
    // State transitions
    // -------------------------------------------------------------------------

    /**
     * Attribute a blockchain transaction identifier to a payment intent.
     *
     * R7 — one transaction identifier can be credited to at most one payment
     * intent, and the operation is idempotent for the same identifier.
     *
     * @param {string} paymentReference
     * @param {string} transactionId
     * @returns {PaymentIntent}
     */
    matchTransaction(paymentReference, transactionId) {

        this._assertInitialized();

        if (typeof transactionId !== "string" || transactionId.trim() === "") {

            throw new PaymentValidationError(
                "transactionId must be a non-empty string"
            );

        }

        const intent = this._intentStore.require(paymentReference);

        // Idempotent replay of the exact same credit.
        if (intent.state === PAYMENT_INTENT_STATE.MATCHED
            && intent.transactionId === transactionId) {

            return intent;

        }

        // R7 — reject a transaction already credited to a different intent.
        const creditedTo = this._intentStore.findByTransactionId(transactionId);

        if (creditedTo && creditedTo.paymentReference !== paymentReference) {

            throw new TransactionAlreadyCreditedError(
                transactionId,
                creditedTo.paymentReference
            );

        }

        const next = intent.transition(PAYMENT_INTENT_STATE.MATCHED, {
            transactionId,
            now: this._now()
        });

        this._intentStore.update(next);

        this.persistSnapshot();

        this._logInfo(
            `Payment intent matched | ref=${paymentReference}`
                + ` | transaction=${transactionId}`
        );

        return next;

    }

    /**
     * Mark a matched payment intent as settled (funds received).
     *
     * @param {string} paymentReference
     * @returns {PaymentIntent}
     */
    settlePayment(paymentReference) {

        this._assertInitialized();

        const intent = this._intentStore.require(paymentReference);

        if (intent.transactionId === null) {

            throw new PaymentValidationError(
                "cannot settle a payment intent without a credited transaction",
                { paymentReference }
            );

        }

        const next = intent.transition(PAYMENT_INTENT_STATE.SETTLED, {
            now: this._now()
        });

        this._intentStore.update(next);

        this.persistSnapshot();

        return next;

    }

    /**
     * Mark a matched payment intent as refunded.
     *
     * @param {string} paymentReference
     * @returns {PaymentIntent}
     */
    refundPayment(paymentReference) {

        this._assertInitialized();

        const intent = this._intentStore.require(paymentReference);

        if (intent.transactionId === null) {

            throw new PaymentValidationError(
                "cannot refund a payment intent without a credited transaction",
                { paymentReference }
            );

        }

        const next = intent.transition(PAYMENT_INTENT_STATE.REFUNDED, {
            now: this._now()
        });

        this._intentStore.update(next);

        this.persistSnapshot();

        return next;

    }

    /**
     * Fail a payment intent (no funds received / invalid transaction).
     *
     * @param {string} paymentReference
     * @returns {PaymentIntent}
     */
    failPayment(paymentReference) {

        this._assertInitialized();

        const intent = this._intentStore.require(paymentReference);

        const next = intent.transition(PAYMENT_INTENT_STATE.FAILED, {
            now: this._now()
        });

        this._intentStore.update(next);

        this.persistSnapshot();

        return next;

    }

    /**
     * Cancel a pending payment intent.
     *
     * @param {string} paymentReference
     * @returns {PaymentIntent}
     */
    cancelPayment(paymentReference) {

        this._assertInitialized();

        const intent = this._intentStore.require(paymentReference);

        const next = intent.transition(PAYMENT_INTENT_STATE.CANCELLED, {
            now: this._now()
        });

        this._intentStore.update(next);

        this.persistSnapshot();

        return next;

    }

    /**
     * Expire a payment intent only once its absolute expiration has passed.
     *
     * @param {string} paymentReference
     * @param {number} [now]
     * @returns {PaymentIntent}
     */
    expirePaymentIntent(paymentReference, now = null) {

        this._assertInitialized();

        const effectiveNow = now ?? this._now();

        const intent = this._intentStore.require(paymentReference);

        if (!intent.isExpired(effectiveNow)) {

            throw new PaymentValidationError(
                "payment intent has not reached its absolute expiration yet",
                { paymentReference, expiresAt: intent.expiresAt, now: effectiveNow }
            );

        }

        const next = intent.transition(PAYMENT_INTENT_STATE.EXPIRED, {
            now: effectiveNow
        });

        this._intentStore.update(next);

        this.persistSnapshot();

        return next;

    }

    /**
     * Expire every payment intent whose absolute expiration has passed.
     *
     * @param {number} [now]
     * @returns {{ expired: number, expiredReferences: Array<string> }}
     */
    sweepExpiredPaymentIntents(now = null) {

        this._assertInitialized();

        const effectiveNow = now ?? this._now();

        const expiredReferences = [];

        for (const intent of this._intentStore.list()) {

            if (intent.state !== PAYMENT_INTENT_STATE.PENDING) {

                continue;

            }

            if (!intent.isExpired(effectiveNow)) {

                continue;

            }

            const next = intent.transition(PAYMENT_INTENT_STATE.EXPIRED, {
                now: effectiveNow
            });

            this._intentStore.update(next);

            expiredReferences.push(intent.paymentReference);

        }

        if (expiredReferences.length > 0) {

            this.persistSnapshot();

        }

        return {
            expired: expiredReferences.length,
            expiredReferences
        };

    }

    // -------------------------------------------------------------------------
    // Wallet reservation / release rules (R3, R8)
    // -------------------------------------------------------------------------

    /**
     * The wallet currently assigned to a room.
     *
     * @param {string} roomId
     * @returns {object|null}
     */
    getWalletForRoom(roomId) {

        return this._walletPool.getReservationForRoom(roomId);

    }

    /**
     * Reserve a wallet for a room (at most one per active room).
     *
     * @param {{ roomId: string, network?: string, walletId?: string }} request
     * @returns {object}
     */
    reserveWalletForRoom({ roomId, network = null, walletId = null }) {

        this._assertInitialized();

        const reservation = this._walletPool.reserve({ roomId, network, walletId });

        this.persistSnapshot();

        return reservation.wallet;

    }

    /**
     * Release a room's wallet. Refused while the room still has unresolved
     * payment or refund obligations (R8).
     *
     * @param {string} roomId
     * @returns {{ released: boolean, walletId: string|null, unresolvedObligations: number }}
     */
    releaseWalletForRoom(roomId) {

        this._assertInitialized();

        const unresolved = this._countOpenObligationsForRoom(roomId);

        const result = this._walletPool.release({
            roomId,
            unresolvedObligations: unresolved
        });

        this.persistSnapshot();

        return result;

    }

    /**
     * R8 — number of payment intents for a room that still leave an open
     * payment or refund obligation.
     *
     * @param {string} roomId
     * @returns {number}
     */
    countOpenObligations(roomId) {

        this._assertInitialized();

        return this._countOpenObligationsForRoom(roomId);

    }

    // -------------------------------------------------------------------------
    // Execution gate (R9 + security scope)
    // -------------------------------------------------------------------------

    /**
     * Payment execution is permanently disabled in Phase 1.
     *
     * This core never executes, broadcasts, or retries a blockchain
     * transaction, and never enables real Testnet / Mainnet collection.
     * The method exists so callers get an explicit, testable refusal instead
     * of a silent no-op.
     *
     * @returns {never}
     */
    executePayment() {

        throw new PaymentExecutionBlockedError(
            "payment execution is disabled in Phase 1: this core does not "
                + "execute, broadcast, or retry blockchain transactions"
        );

    }

    /**
     * Explicit, auditable capability descriptor.
     *
     * @returns {Readonly<{
     *   phase: number,
     *   transfersEnabled: boolean,
     *   broadcastsEnabled: boolean,
     *   smartContractsEnabled: boolean,
     *   realPaymentCollectionEnabled: boolean,
     *   walletPoolSize: number,
     *   roomLifetimeMs: number,
     *   executionRequiresConfiguredDenomination: boolean
     * }>}
     */
    getCapabilities() {

        return Object.freeze({
            phase: ROOM_WALLET_PAYMENT_PHASE,
            transfersEnabled: false,
            broadcastsEnabled: false,
            smartContractsEnabled: false,
            realPaymentCollectionEnabled: false,
            walletPoolSize: ROOM_WALLET_POOL_SIZE,
            roomLifetimeMs: ROOM_LIFETIME_MS,
            executionRequiresConfiguredDenomination: true
        });

    }

    // -------------------------------------------------------------------------
    // Introspection
    // -------------------------------------------------------------------------

    /**
     * R7 — every credited transaction and its owning payment intent.
     *
     * @returns {Array<{ transactionId: string, paymentReference: string }>}
     */
    listCreditedTransactions() {

        return [...this._intentStore.listCreditedTransactions().entries()]
            .map(([transactionId, paymentReference]) => ({
                transactionId,
                paymentReference
            }));

    }

    /**
     * @returns {object} safe engine snapshot (no secrets).
     */
    getHealthSnapshot() {

        return Object.freeze({
            phase: ROOM_WALLET_PAYMENT_PHASE,
            wallets: {
                poolSize: this._walletPool.size,
                reserved: this._walletPool.getReservedCount(),
                available: this._walletPool.getAvailableCount()
            },
            intents: this._intentStore.size,
            creditedTransactions: this._intentStore.listCreditedTransactions().size,
            roomLifetimeMs: ROOM_LIFETIME_MS,
            transfersEnabled: false
        });

    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    _countOpenObligationsForRoom(roomId) {

        let count = 0;

        for (const intent of this._intentStore.listForRoom(roomId)) {

            if (intent.hasOpenObligation()) {

                count += 1;

            }

        }

        return count;

    }

    /**
     * Injectable clock used by every state transition and deadline evaluation
     * so tests and production share one deterministic time source.
     *
     * @returns {number}
     */
    _now() {

        return this._nowProvider();

    }

    _collectObligationsByRoom() {

        const map = new Map();

        for (const intent of this._intentStore.list()) {

            if (!intent.hasOpenObligation()) {

                continue;

            }

            map.set(intent.roomId, (map.get(intent.roomId) ?? 0) + 1);

        }

        return map;

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new PaymentValidationError(
                "RoomWalletPaymentService is not initialized"
            );

        }

    }

    _logInfo(message) {

        this._logger?.info?.(message);

    }

}

export { PaymentIntent, isTerminalPaymentIntentState, atomicWriteJson };
