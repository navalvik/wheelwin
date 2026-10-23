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
import { isPaymentIntentStoreContract } from "./PaymentIntentStoreContract.js";
import {
    PaymentConfigurationError,
    PaymentExecutionBlockedError,
    PaymentIntentExpiredError,
    PaymentReferenceCollisionError,
    PaymentValidationError,
    TransactionAlreadyCreditedError,
    WalletAssignmentConflictError
} from "./PaymentErrors.js";

import { IncomingTransfer } from "./incoming/IncomingTransfer.js";
import {
    deriveIncomingTransactionId,
    matchIncomingTransferToIntent,
    normalizeNetwork
} from "./incoming/index.js";
import {
    deriveTonAddressIdentity,
    tonAddressIdentitiesEqual
} from "./incoming/TonAddressIdentity.js";
import { isPaymentReference } from "./incoming/PaymentReferenceCodec.js";
import {
    isTrustedRoomPaymentObservationResult,
    RoomPaymentObservationService
} from "./toncenter/RoomPaymentObservationService.js";

export const ROOM_WALLET_PAYMENT_PHASE = 1;

// ---------------------------------------------------------------------------
// Phase 3D — settlement bound to trusted observation results
//
// `settlePayment()` is PROTECTED. It may only be reached with an immutable
// observation result returned by the configured RoomPaymentObservationService
// after a successful provider observation. Object identity is required: a plain
// object, a copied result, a Proxy, or an object carrying only field names
// is rejected. Only that exact frozen result is trusted; it cannot be
// registered or minted by callers.
//
// The coordinator no longer produces or passes a transferable authority token.
// All security-critical checks (identity binding to the exact observation
// instance, completeness, ambiguity, collisions, time/window and expiry,
// sender/destination/network/asset/amount/reference) are enforced by this
// service boundary. Finality depth and irreversibility remain unverified.
// ---------------------------------------------------------------------------

/** PaymentIntent states that are terminal and therefore cannot be settled. */
function isTerminalState(state) {

    return isTerminalPaymentIntentState(state);

}

export class RoomWalletPaymentService {

    constructor({
        walletPool,
        intentStore,
        assetRegistry,
        logger = null,
        snapshotDir = null,
        nowProvider = Date.now,
        paymentWindowMs = ROOM_LIFETIME_MS,
        persistSnapshots = true,
        observationService
    } = {}) {

        if (!(walletPool instanceof WalletPoolRegistry)) {

            throw new PaymentValidationError(
                "walletPool must be a WalletPoolRegistry instance"
            );

        }

        if (!isPaymentIntentStoreContract(intentStore)) {

            throw new PaymentConfigurationError(
                "intentStore must implement the payment intent store contract",
                { intentStore: intentStore === undefined ? null : typeof intentStore }
            );

        }

        if (!(assetRegistry instanceof AssetDenominationRegistry)) {

            throw new PaymentValidationError(
                "assetRegistry must be an AssetDenominationRegistry instance"
            );

        }

        if (!(observationService instanceof RoomPaymentObservationService)) {

            throw new PaymentConfigurationError(
                "observationService must be the RoomPaymentObservationService instance "
                    + "whose trusted observation results this service may settle from",
                { observationService: observationService === undefined ? null : typeof observationService }
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

        this._observationService = observationService;

        this._logger = logger;

        this._snapshotDir = snapshotDir ?? join(intentStore.dataDir, "payment-core");

        this._nowProvider = nowProvider;

        this._paymentWindowMs = paymentWindowMs;

        this._persistSnapshots = persistSnapshots === true;

        this._initialized = false;

    }

    /**
     * Return the authoritative configured denomination for an asset/network.
     * The returned AssetDenomination is immutable and exposes no registry
     * mutation API, so callers can safely use it for read-only validation.
     *
     * @param {string} network
     * @param {string} asset
     * @returns {import("./AssetDenomination.js").AssetDenomination}
     */
    requireAssetDenomination(network, asset) {

        return this._assetRegistry.requireMapping(network, asset);

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

        // Validate every persisted open obligation before changing any wallet
        // reservation. Missing reservations are reconstructed from the exact
        // public wallet identity recorded by their authoritative intents.
        const recoveries = this._collectWalletReservationRecoveries();

        if (recoveries.length > 0 && !this._persistSnapshots) {

            throw new PaymentConfigurationError(
                "cannot recover open room wallet reservations without durable snapshot persistence"
            );

        }

        // R8 — a wallet is never recycled while its previous room still has
        // unresolved obligations. Restore only still-owed reservations.
        const obligations = this._collectObligationsByRoom();

        const reconciliation = this._walletPool.reconcile({
            obligationsByRoom: obligations
        });

        for (const recovery of recoveries) {

            if (this._walletPool.hasReservationForRoom(recovery.roomId)) {

                continue;

            }

            this._walletPool.reserve({
                roomId: recovery.roomId,
                network: recovery.network,
                walletId: recovery.walletId,
                now: this._now()
            });

        }

        // Startup must not report success until recovered reservations are
        // durable. Persisting after reconciliation also records any releases.
        if (this._persistSnapshots
            && (recoveries.length > 0 || reconciliation.released > 0)) {

            this._walletPool.persistSnapshot(snapshotDir);

        }

        this._initialized = true;

        this._logInfo(
            "RoomWalletPaymentService ready"
                 + ` | observation=${this._observationService.constructor.name}`
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

    get observationService() {
        return this._observationService;
    }

    // -------------------------------------------------------------------------
    shutdown() {

        this.persistSnapshot();

        this._initialized = false;

    }

    // Room deadline (R1)
    // -------------------------------------------------------------------------

    /**
     * The single, immutable room deadline: `roomCreatedAt + 300000` ms.
     *
     * @param {number} roomCreatedAt
     * @returns {{ roomCreatedAt: number, roomLifetimeMs: number, deadlineMs: number }}
     */
    getRoomDeadline(roomCreatedAt) {

        return createRoomDeadline(roomCreatedAt).toJSON();

    }

    /**
     * Absolute room pool lifetime. Fixed at exactly 300 seconds.
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

            intent = this._intentStore.save(intent);

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

        const committed = this._intentStore.update(next);

        this.persistSnapshot();

        this._logInfo(
            `Payment intent matched | ref=${paymentReference}`
                + ` | transaction=${transactionId}`
        );

        return committed;

    }

    /**
     * Mark a matched payment intent as settled (funds received).
     *
     * PHASE 3D — PROTECTED PATH. This method can only be reached through a
     * exact, immutable result returned by the configured observation service,
     * plus the selected transaction id. The transaction id selects a candidate;
     * it is never proof by itself.
     *
     * Every other route fails closed: a direct `settlePayment(ref)` call, a
     * `matchTransaction(ref, arbitraryTxId)` + `settlePayment(ref)` pair, and a
     * hand-made object that merely carries the expected field names are all
     * rejected with `PaymentValidationError`. Nothing is settled.
     *
     * @param {string} paymentReference
     * @param {Readonly<object>|null} observationResult exact trusted batch result
     * @param {string} transactionId selected transaction id
     * @returns {PaymentIntent}
     */
    settlePayment(paymentReference, observationResult = null, transactionId = null) {

        this._assertInitialized();

        const intent = this._intentStore.require(paymentReference);

        this.#assertTrustedObservationCandidate(
            observationResult,
            transactionId,
            intent
        );

        if (intent.state === PAYMENT_INTENT_STATE.SETTLED) {

            if (intent.transactionId === transactionId) {

                return intent;

            }

            throw new PaymentValidationError(
                "a settled payment intent cannot be rebound to another transaction",
                { paymentReference }
            );

        }

        if (intent.state !== PAYMENT_INTENT_STATE.MATCHED
            || intent.transactionId !== transactionId) {

            throw new PaymentValidationError(
                "settlement requires the intent to be matched to the observed transaction",
                { paymentReference }
            );

        }

        const next = intent.transition(PAYMENT_INTENT_STATE.SETTLED, {
            now: this._now()
        });

        const committed = this._intentStore.update(next);

        this.persistSnapshot();

        // A successful transition is persisted once; an exact replay returns
        // the already-settled intent above without another write.

        return committed;

    }

    /**
     * Fail-closed validation of a trusted batch result and one selected
     * candidate against the current authoritative intent.
     *
     * @param {unknown} observationResult
     * @param {string} transactionId
     * @param {PaymentIntent} intent authoritative intent from the store
     * @returns {void}
     */
    #assertTrustedObservationCandidate(observationResult, transactionId, intent) {

        if (typeof transactionId !== "string" || transactionId.trim() === "") {

            throw new PaymentValidationError(
                "settlement requires a selected observed transaction id",
                { paymentReference: intent.paymentReference }
            );

        }

        if (!isTrustedRoomPaymentObservationResult(
            observationResult,
            this._observationService
        )) {

            throw new PaymentValidationError(
                "settlement requires the exact trusted observation result "
                    + "returned by the configured observation service",
                { paymentReference: intent.paymentReference }
            );

        }

        const observations = observationResult.observations;
        const transfers = observationResult.transfers;
        const window = observationResult.window;
        const reservation = this.getWalletForRoom(intent.roomId);

        const deeplyFrozen = Object.isFrozen(observationResult)
            && Object.isFrozen(window)
            && Object.isFrozen(observations)
            && Object.isFrozen(transfers)
            && Array.isArray(observations)
            && Array.isArray(transfers)
            && transfers.every((transfer) => transfer instanceof IncomingTransfer
                && Object.isFrozen(transfer)
                && Object.isFrozen(transfer.providerTransactionIdentity))
            && observations.every((entry) => Object.isFrozen(entry)
                && (entry.candidatePaymentReferences === null
                    || Object.isFrozen(entry.candidatePaymentReferences))
                && (entry.candidateTransactionIds === null
                    || Object.isFrozen(entry.candidateTransactionIds)));

        if (!deeplyFrozen) {

            throw new PaymentValidationError(
                "trusted observation result must be deeply immutable",
                { paymentReference: intent.paymentReference }
            );

        }

        if (observationResult.resultWindowComplete !== true
            || observationResult.roomId !== intent.roomId
            || !reservation
            || !tonAddressIdentitiesEqual(
                observationResult.walletAddress,
                reservation.address
            )
            || intent.destinationWalletId !== reservation.walletId
            || !tonAddressIdentitiesEqual(
                intent.destinationWalletAddress,
                reservation.address
            )) {

            throw new PaymentValidationError(
                "observation is incomplete or unrelated to the intent room wallet",
                { paymentReference: intent.paymentReference }
            );

        }

        if (!window
            || !Number.isSafeInteger(window.floorMs)
            || !Number.isSafeInteger(window.ceilingMs)
            || window.floorMs <= 0
            || window.ceilingMs < window.floorMs
            || window.floorMs > intent.createdAt
            || !Number.isSafeInteger(window.limit)
            || window.limit < 1
            || !Number.isSafeInteger(window.rowsReturned)
            || window.rowsReturned < 0
            || window.rowsReturned >= window.limit
            || observationResult.providerRequests !== 1
            || observations.length !== transfers.length) {

            throw new PaymentValidationError(
                "observation window is not complete or internally consistent",
                { paymentReference: intent.paymentReference }
            );

        }

        const relatedEntries = observations.filter((entry) =>
            entry.paymentReference === intent.paymentReference
                || entry.transactionId === transactionId
                || (Array.isArray(entry.candidatePaymentReferences)
                    && entry.candidatePaymentReferences.includes(
                        intent.paymentReference
                    ))
                || (Array.isArray(entry.candidateTransactionIds)
                    && entry.candidateTransactionIds.includes(transactionId))
        );

        const matchingEntries = relatedEntries.filter((entry) =>
            entry.status === "matched"
                && entry.paymentReference === intent.paymentReference
                && entry.transactionId === transactionId
        );

        const matchingTransfers = transfers.filter((transfer) =>
            transfer.transactionId === transactionId
        );

        if (relatedEntries.length !== 1
            || matchingEntries.length !== 1
            || matchingTransfers.length !== 1) {

            throw new PaymentValidationError(
                "observation must contain exactly one unambiguous candidate for the payment",
                { paymentReference: intent.paymentReference }
            );

        }

        const transfer = matchingTransfers[0];
        const entry = matchingEntries[0];
        const providerIdentity = transfer.providerTransactionIdentity;

        if (deriveIncomingTransactionId({
            network: transfer.network,
            providerId: providerIdentity.providerId,
            accountId: providerIdentity.accountId,
            transactionId: providerIdentity.transactionId
        }) !== transactionId
            || !tonAddressIdentitiesEqual(
                providerIdentity.accountId,
                reservation.address
            )
            || transfer.destinationWalletId !== reservation.walletId
            || !tonAddressIdentitiesEqual(
                transfer.destinationWalletAddress,
                reservation.address
            )
            || !tonAddressIdentitiesEqual(
                transfer.senderAddress,
                intent.expectedSender
            )
            || normalizeNetwork(transfer.network) !== normalizeNetwork(intent.network)
            || transfer.asset !== intent.asset
            || transfer.amountAtomic !== intent.amountAtomic
            || transfer.paymentReference !== intent.paymentReference
            // ToncenterTransactionsMapper stores the decoded bare reference in
            // `comment`; IncomingTransfer preserves that normalized value as
            // `paymentComment`.
            || transfer.paymentComment !== intent.paymentReference
            || transfer.transactionTime < intent.createdAt
            || transfer.transactionTime < window.floorMs
            || transfer.transactionTime > window.ceilingMs
            || transfer.transactionTime >= intent.expiresAt
            || intent.isExpired(window.ceilingMs)
            || entry.amountAtomic !== transfer.amountAtomic
            || entry.transactionTime !== transfer.transactionTime
            || !tonAddressIdentitiesEqual(
                entry.senderAddress,
                transfer.senderAddress
            )) {

            throw new PaymentValidationError(
                "observed candidate does not satisfy the current payment intent",
                { paymentReference: intent.paymentReference }
            );

        }

        const intentForMatching = intent.state === PAYMENT_INTENT_STATE.SETTLED
            ? { ...intent, state: PAYMENT_INTENT_STATE.PENDING, transactionId: null }
            : intent;

        const matchingIntents = this._intentStore.listForRoom(intent.roomId)
            .filter((roomIntent) => matchIncomingTransferToIntent(
                transfer,
                roomIntent.paymentReference === intent.paymentReference
                    ? intentForMatching
                    : roomIntent
            ).matched);

        if (matchingIntents.length !== 1
            || matchingIntents[0].paymentReference !== intent.paymentReference) {

            throw new PaymentValidationError(
                "observed transaction is ambiguous across the room payment intents",
                { paymentReference: intent.paymentReference }
            );

        }

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

        const committed = this._intentStore.update(next);

        this.persistSnapshot();

        return committed;

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

        const committed = this._intentStore.update(next);

        this.persistSnapshot();

        return committed;

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

        const committed = this._intentStore.update(next);

        this.persistSnapshot();

        return committed;

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

    _collectWalletReservationRecoveries() {

        const rooms = new Map();

        const walletOwners = new Map();

        const addressOwners = new Map();

        for (const intent of this._intentStore.list()) {

            if (!intent.hasOpenObligation()) {

                continue;

            }

            if (!isPaymentReference(intent.paymentReference)
                || !Number.isSafeInteger(intent.amountAtomic)
                || intent.amountAtomic <= 0) {

                throw new PaymentValidationError(
                    "open payment intent has invalid reference or amount metadata",
                    { roomId: intent.roomId, paymentReference: intent.paymentReference }
                );

            }

            const mapping = this._assetRegistry.requireMapping(
                intent.network,
                intent.asset
            );

            if (intent.amountAtomic % mapping.atomicUnitsPerUnit !== 0
                || intent.roomDeadlineMs <= intent.createdAt
                || intent.roomDeadlineMs > intent.createdAt + ROOM_LIFETIME_MS) {

                throw new PaymentValidationError(
                    "open payment intent has invalid amount or room-deadline metadata",
                    { roomId: intent.roomId, paymentReference: intent.paymentReference }
                );

            }

            let destinationIdentity;

            try {

                destinationIdentity = deriveTonAddressIdentity(
                    intent.destinationWalletAddress
                );

                deriveTonAddressIdentity(intent.expectedSender);

            } catch (error) {

                throw new PaymentValidationError(
                    "open payment intent has an invalid TON address",
                    {
                        roomId: intent.roomId,
                        paymentReference: intent.paymentReference,
                        cause: error?.message
                    }
                );

            }

            const wallet = this._walletPool.getWallet(intent.destinationWalletId);

            if (!wallet
                || intent.network !== this._walletPool.network
                || wallet.network !== intent.network
                || !tonAddressIdentitiesEqual(
                    intent.destinationWalletAddress,
                    wallet.address
                )) {

                throw new WalletAssignmentConflictError(
                    "open payment intent wallet identity is missing or does not match the configured pool",
                    {
                        roomId: intent.roomId,
                        paymentReference: intent.paymentReference,
                        walletId: intent.destinationWalletId
                    }
                );

            }

            const previousOwner = walletOwners.get(intent.destinationWalletId);

            const previousAddressOwner = addressOwners.get(destinationIdentity);

            if ((previousOwner && previousOwner !== intent.roomId)
                || (previousAddressOwner && previousAddressOwner !== intent.roomId)) {

                throw new WalletAssignmentConflictError(
                    "persisted open obligations assign one wallet to different rooms",
                    {
                        walletId: intent.destinationWalletId,
                        roomId: intent.roomId,
                        conflictingRoomId: previousOwner ?? previousAddressOwner
                    }
                );

            }

            walletOwners.set(intent.destinationWalletId, intent.roomId);

            addressOwners.set(destinationIdentity, intent.roomId);

            const existingReservation = this._walletPool.getReservationForRoom(
                intent.roomId
            );

            if (existingReservation
                && (existingReservation.walletId !== wallet.walletId
                    || !tonAddressIdentitiesEqual(
                        existingReservation.address,
                        destinationIdentity
                    ))) {

                throw new WalletAssignmentConflictError(
                    "persisted room reservation conflicts with its open payment intents",
                    {
                        roomId: intent.roomId,
                        walletId: wallet.walletId,
                        reservedWalletId: existingReservation.walletId
                    }
                );

            }

            if (wallet.reservedByRoomId
                && wallet.reservedByRoomId !== intent.roomId) {

                throw new WalletAssignmentConflictError(
                    "open payment intent wallet is already reserved by another room",
                    {
                        walletId: wallet.walletId,
                        roomId: intent.roomId,
                        reservedByRoomId: wallet.reservedByRoomId
                    }

                );

            }

            const roomRecovery = rooms.get(intent.roomId);

            if (roomRecovery
                && (roomRecovery.walletId !== wallet.walletId
                    || roomRecovery.addressIdentity !== destinationIdentity)) {

                throw new WalletAssignmentConflictError(
                    "open payment intents for one room identify different wallets",
                    {
                        roomId: intent.roomId,
                        walletId: wallet.walletId,
                        conflictingWalletId: roomRecovery.walletId
                    }

                );

            }

            if (!roomRecovery) {

                rooms.set(intent.roomId, {
                    roomId: intent.roomId,
                    walletId: wallet.walletId,
                    addressIdentity: destinationIdentity,
                    network: intent.network
                });

            }

        }

        return [...rooms.values()];

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
