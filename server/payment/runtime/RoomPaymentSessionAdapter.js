/**
 * Runtime-neutral orchestration seam for one server-prepared room's payments.
 *
 * This module is deliberately not attached to application startup, gameplay,
 * sockets, events, routes, or timers. Only a future trusted server-side caller
 * may supply the authoritative room requirements. A client-supplied descriptor
 * is not authoritative and this module adds no client-accessible route.
 *
 * Each required payment creates one PLAYER_STAKE ledger record. A separate
 * INCOMING_PRINCIPAL record is written only after the settlement coordinator
 * reports the reference as settled/already settled and RoomLedger verifies the
 * persisted SETTLED PaymentIntent itself. Intent creation, stake recording,
 * settlement, and principal recording are separate durable operations, not an
 * atomic transaction. Stable idempotency keys and authoritative replay checks
 * prevent a replay from double-booking a stake or principal.
 *
 * This adapter does not plan or execute payouts, sign/broadcast transfers,
 * perform refunds, or make chain-finality claims. Existing payout rules stay
 * in the ledger/payout modules and are not changed here.
 */

import { ROOM_LIFETIME_MS } from "../RoomPaymentConstants.js";
import { RoomWalletPaymentService } from "../RoomWalletPaymentService.js";
import { RoomPreparationManifestStore } from "../RoomPreparationManifestStore.js";
import { AssetDenomination } from "../AssetDenomination.js";
import { isPaymentReference } from "../incoming/PaymentReferenceCodec.js";
import {
    deriveTonAddressIdentity,
    isSupportedNetwork
} from "../incoming/index.js";
import { IncomingPaymentSettlementCoordinator } from "../incoming/IncomingPaymentSettlementCoordinator.js";
import { PAYMENT_INTENT_STATE } from "../PaymentIntentStatus.js";
import { assessThreePlayerPaymentGate } from "./ThreePlayerPaymentGate.js";
import {
    INCOMING_PRINCIPAL_CONFIRMATION_SOURCE,
    LEDGER_ENTRY_KIND,
    LedgerEntry,
    CANONICAL_TON_ASSET,
    GRAM_DISPLAY_SYMBOL,
    NANOTONS_PER_TON
} from "../ledger/index.js";

const DESCRIPTOR_STAKE_RELATION = "ONE_PLAYER_STAKE_AND_PRINCIPAL_PER_PAYMENT";
const DESCRIPTOR_KEYS = Object.freeze([
    "roomId",
    "roomCreatedAt",
    "network",
    "asset",
    "requiredPlayers",
    "stakeLedgerRelation"
]);
const PAYMENT_KEYS = Object.freeze([
    "roomId",
    "paymentReference",
    "playerId",
    "expectedSender",
    "amountAtomic"
]);
const OBSERVATION_REQUEST_KEYS = Object.freeze(["roomId", "observationSession"]);

export class RoomPaymentSessionValidationError extends Error {

    constructor(message, details = {}) {
        super(message);
        this.name = "RoomPaymentSessionValidationError";
        this.code = "ROOM_PAYMENT_SESSION_VALIDATION";
        this.details = Object.freeze({ ...details });
    }

}

function fail(message, details) {
    throw new RoomPaymentSessionValidationError(message, details);
}

function exactDataRecord(value, keys, label) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(`${label} must be a plain object`);
    }

    let prototype;
    let ownKeys;
    let descriptors;
    try {
        prototype = Object.getPrototypeOf(value);
        ownKeys = Reflect.ownKeys(value);
        descriptors = Object.getOwnPropertyDescriptors(value);
    } catch (error) {
        fail(`${label} could not be safely inspected`, { cause: error?.message });
    }

    if (prototype !== Object.prototype && prototype !== null) {
        fail(`${label} must be a plain object`);
    }

    if (ownKeys.some((key) => typeof key !== "string")
        || ownKeys.length !== keys.length
        || keys.some((key) => !ownKeys.includes(key))) {
        fail(`${label} has missing or unsupported fields`, {
            expected: [...keys],
            received: ownKeys.filter((key) => typeof key === "string")
        });
    }

    const result = Object.create(null);
    for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
            fail(`${label}.${key} must be an enumerable data property`, { field: key });
        }
        result[key] = descriptor.value;
    }
    return result;
}

function nonEmptyString(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
        fail(`${field} must be a non-empty string`, { field });
    }
    return value.trim();
}

function samePaymentIntent(intent, requirement, roomCreatedAt, network, asset) {
    return intent.roomId === requirement.roomId
        && intent.paymentReference === requirement.paymentReference
        && intent.playerId === requirement.playerId
        && intent.expectedSender === requirement.expectedSender
        && intent.amountAtomic === requirement.amountAtomic
        && intent.network === network
        && intent.asset === asset
        && intent.roomDeadlineMs === roomCreatedAt + ROOM_LIFETIME_MS;
}

function stakeKey(paymentReference) {
    return `ww:required-stake:${paymentReference}`;
}

function principalKey(paymentReference) {
    return `ww:incoming-principal:${paymentReference}`;
}

function verifyStakeEntry(entry, requirement, asset, network) {
    return entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
        && entry.roomId === requirement.roomId
        && entry.playerId === requirement.playerId
        && entry.amountAtomic === requirement.amountAtomic
        && entry.asset === asset
        && entry.network === network
        && entry.metadata?.paymentReference === requirement.paymentReference;
}

function findStakeByPaymentReference(store, paymentReference) {
    const matches = store.list().filter((entry) =>
        entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            && entry.metadata?.paymentReference === paymentReference
    );
    if (matches.length > 1) {
        fail("payment reference has multiple persisted player-stake entries", {
            paymentReference
        });
    }
    return matches[0] ?? null;
}

function validateStakeAppend(result, persistedEntry, requirement, asset, network) {
    if (result === null
        || typeof result !== "object"
        || typeof result.replay !== "boolean"
        || !(result.entry instanceof LedgerEntry)
        || result.entry !== persistedEntry
        || typeof result.entry.entryId !== "string"
        || result.entry.entryId.trim() === ""
        || !verifyStakeEntry(result.entry, requirement, asset, network)
        || result.entry.asset !== asset
        || result.entry.network !== network) {
        fail("room ledger did not return a usable persisted player-stake entry", {
            paymentReference: requirement.paymentReference
        });
    }
}

function verifyPrincipalEntry(entry, requirement, transactionId) {
    return entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL
        && entry.roomId === requirement.roomId
        && entry.playerId === requirement.playerId
        && entry.amountAtomic === requirement.amountAtomic
        && entry.metadata?.paymentReference === requirement.paymentReference
        && entry.metadata?.transactionId === transactionId
        && entry.metadata?.intentState === PAYMENT_INTENT_STATE.SETTLED
        && entry.metadata?.source === INCOMING_PRINCIPAL_CONFIRMATION_SOURCE;
}

function requireAuthoritativeDenomination(paymentService, ledger, network, asset) {
    if (typeof paymentService.requireAssetDenomination !== "function") {
        fail("payment service does not expose its public denomination lookup");
    }

    let mapping;
    try {
        mapping = paymentService.requireAssetDenomination(network, asset);
    } catch (error) {
        fail("payment service has no usable denomination mapping for the descriptor", {
            network,
            asset,
            cause: error?.message
        });
    }

    const currency = ledger.currency;
    const atomicUnitsPerUnit = mapping?.atomicUnitsPerUnit;
    if (!(mapping instanceof AssetDenomination)
        || mapping.asset !== asset
        || mapping?.network !== network
        || typeof mapping?.symbol !== "string"
        || mapping.symbol.trim() === ""
        || !Number.isSafeInteger(atomicUnitsPerUnit)
        || atomicUnitsPerUnit <= 0
        || !currency
        || currency.asset !== mapping.asset
        || currency.network !== mapping.network
        || currency.symbol !== mapping.symbol
        || currency.atomicUnitsPerUnit !== atomicUnitsPerUnit
        || (asset === CANONICAL_TON_ASSET
            && (mapping.symbol !== GRAM_DISPLAY_SYMBOL
                || atomicUnitsPerUnit !== NANOTONS_PER_TON))) {
        fail("payment service and room ledger denomination mappings are inconsistent", {
            network,
            asset
        });
    }

    return mapping;
}

function isUsablePrincipalAppendResult(result, persistedEntry, key, requirement, transactionId) {
    return result !== null
        && typeof result === "object"
        && typeof result.replay === "boolean"
        && result.entry instanceof LedgerEntry
        && result.entry === persistedEntry
        && typeof result.entry.entryId === "string"
        && result.entry.entryId.trim() !== ""
        && result.entry.idempotencyKey === key
        && verifyPrincipalEntry(result.entry, requirement, transactionId);
}

/**
 * Caller-driven room payment orchestration over the existing public services.
 * The input descriptor must be built from server-authoritative room/player
 * state by a future trusted integration.
 */
export class RoomPaymentSessionAdapter {

    #paymentService;
    #coordinator;
    #ledger;
    #manifestStore;
    #nowProvider;
    #sessions = new Map();

    constructor({ paymentService, coordinator, ledger, manifestStore, nowProvider = Date.now } = {}) {
        if (!(paymentService instanceof RoomWalletPaymentService)) {
            throw new RoomPaymentSessionValidationError(
                "paymentService must be a RoomWalletPaymentService instance"
            );
        }
        if (!(coordinator instanceof IncomingPaymentSettlementCoordinator)
            || coordinator.paymentService !== paymentService
            || coordinator.observationService !== paymentService.observationService) {
            throw new RoomPaymentSessionValidationError(
                "coordinator must use this exact payment service and its bound observation service"
            );
        }
        if (!ledger
            || typeof ledger.recordPlayerStake !== "function"
            || typeof ledger.recordIncomingPrincipal !== "function"
            || !ledger.store
            || typeof ledger.store.findByIdempotencyKey !== "function"
            || typeof ledger.store.list !== "function"
            || typeof ledger.network !== "string"
            || typeof ledger.asset !== "string") {
            throw new RoomPaymentSessionValidationError(
                "ledger must expose the RoomLedger stake, principal, and durable replay APIs"
            );
        }
        if (typeof nowProvider !== "function") {
            throw new RoomPaymentSessionValidationError("nowProvider must be a function");
        }

        this.#paymentService = paymentService;
        this.#coordinator = coordinator;
        this.#ledger = ledger;
        if (!(manifestStore instanceof RoomPreparationManifestStore)) {
            throw new RoomPaymentSessionValidationError(
                "manifestStore must be a RoomPreparationManifestStore instance"
            );
        }
        this.#manifestStore = manifestStore;
        this.#nowProvider = nowProvider;
    }

    /**
     * Validate a complete requirement descriptor before creating any intents
     * or ledger entries. Repeating an identical descriptor is idempotent.
     *
     * @returns {Readonly<{roomId: string, roomCreatedAt: number, network: string,
     *   asset: string, payments: ReadonlyArray<object>}>}
     */
    prepareRoom(descriptor) {
        const input = exactDataRecord(descriptor, DESCRIPTOR_KEYS, "descriptor");
        const roomId = nonEmptyString(input.roomId, "roomId");
        const roomCreatedAt = input.roomCreatedAt;
        if (!Number.isSafeInteger(roomCreatedAt) || roomCreatedAt <= 0
            || !Number.isSafeInteger(roomCreatedAt + ROOM_LIFETIME_MS)) {
            fail("roomCreatedAt must be a positive safe epoch-milliseconds value", {
                roomCreatedAt
            });
        }

        const network = nonEmptyString(input.network, "network").toLowerCase();
        if (network === "mainnet") {
            fail("mainnet room payments are not supported by the configured incoming provider", {
                network
            });
        }
        if (!isSupportedNetwork(network)) {
            fail("network is not supported by incoming payment observation", { network });
        }
        const asset = nonEmptyString(input.asset, "asset");
        if (asset !== this.#ledger.asset || network !== this.#ledger.network) {
            fail("descriptor asset/network must match the authoritative room ledger", {
                asset,
                network,
                ledgerAsset: this.#ledger.asset,
                ledgerNetwork: this.#ledger.network
            });
        }
        const denomination = requireAuthoritativeDenomination(
            this.#paymentService,
            this.#ledger,
            network,
            asset
        );
        if (input.stakeLedgerRelation !== DESCRIPTOR_STAKE_RELATION) {
            fail("stakeLedgerRelation must declare one player stake and principal per payment");
        }
        if (!Array.isArray(input.requiredPlayers) || input.requiredPlayers.length === 0) {
            fail("requiredPlayers must be a non-empty array");
        }
        if (Object.keys(input.requiredPlayers).length !== input.requiredPlayers.length
            || input.requiredPlayers.some((_, index) => !Object.hasOwn(input.requiredPlayers, index))) {
            fail("requiredPlayers must be a dense array without extra properties");
        }

        const references = new Set();
        const players = new Set();
        const payments = input.requiredPlayers.map((raw, index) => {
            const row = exactDataRecord(raw, PAYMENT_KEYS, `requiredPlayers[${index}]`);
            const paymentRoomId = nonEmptyString(row.roomId, `requiredPlayers[${index}].roomId`);
            if (paymentRoomId !== roomId) {
                fail("payment requirement belongs to a different room", {
                    index,
                    roomId,
                    paymentRoomId
                });
            }
            const paymentReference = nonEmptyString(
                row.paymentReference,
                `requiredPlayers[${index}].paymentReference`
            );
            if (!isPaymentReference(paymentReference)) {
                fail("paymentReference does not satisfy PaymentReferenceCodec rules", {
                    index,
                    paymentReference
                });
            }
            const playerId = nonEmptyString(row.playerId, `requiredPlayers[${index}].playerId`);
            const expectedSender = nonEmptyString(
                row.expectedSender,
                `requiredPlayers[${index}].expectedSender`
            );
            try {
                deriveTonAddressIdentity(expectedSender);
            } catch (error) {
                fail("expectedSender must be a valid TON address", {
                    index,
                    cause: error?.message
                });
            }
            const amountAtomic = row.amountAtomic;
            if (!Number.isSafeInteger(amountAtomic) || amountAtomic <= 0) {
                fail("amountAtomic must be a positive safe integer", { index, amountAtomic });
            }
            // WheelWin's second sector costs 1.5x the base stake.
            // The authoritative denomination must support exact half-GRAM
            // increments, without allowing arbitrary nanotons as a stake.
            if (!Number.isSafeInteger(denomination.atomicUnitsPerUnit / 2)
                || amountAtomic % (denomination.atomicUnitsPerUnit / 2) !== 0) {
                fail("amountAtomic must be an exact half-unit multiple of the configured payment denomination", {
                    index,
                    amountAtomic,
                    atomicUnitsPerUnit: denomination.atomicUnitsPerUnit
                });
            }
            if (references.has(paymentReference)) {
                fail("payment references must be unique", { paymentReference });
            }
            if (players.has(playerId)) {
                fail("each required player must have exactly one payment requirement", { playerId });
            }
            references.add(paymentReference);
            players.add(playerId);
            return Object.freeze({
                roomId,
                paymentReference,
                playerId,
                expectedSender,
                amountAtomic
            });
        });

        const now = this.#nowProvider();
        if (!Number.isSafeInteger(now) || now <= 0) {
            fail("nowProvider must return a positive safe epoch-milliseconds value", { now });
        }
        if (roomCreatedAt > now) {
            fail("roomCreatedAt cannot be later than the authoritative current time", {
                roomId,
                roomCreatedAt,
                now
            });
        }
        if (now >= roomCreatedAt + ROOM_LIFETIME_MS) {
            fail("room payment requirements cannot be prepared after the 300-second room deadline", {
                roomId,
                now,
                deadlineMs: roomCreatedAt + ROOM_LIFETIME_MS
            });
        }

        const frozenPayments = Object.freeze(payments);
        const session = Object.freeze({
            roomId,
            roomCreatedAt,
            network,
            asset,
            stakeLedgerRelation: DESCRIPTOR_STAKE_RELATION,
            payments: frozenPayments
        });
        const previous = this.#sessions.get(roomId);
        if (previous && !this.#sameSession(previous, session)) {
            fail("room descriptor differs from the one already prepared by this adapter", { roomId });
        }

        const manifestDescriptor = Object.freeze({
            roomId,
            roomCreatedAt,
            roomDeadlineMs: roomCreatedAt + ROOM_LIFETIME_MS,
            network,
            asset,
            denomination: Object.freeze({
                asset: denomination.asset,
                symbol: denomination.symbol,
                network: denomination.network,
                atomicUnitsPerUnit: denomination.atomicUnitsPerUnit
            }),
            stakeLedgerRelation: DESCRIPTOR_STAKE_RELATION,
            requiredPlayers: frozenPayments
        });

        let existingManifest;
        try {
            existingManifest = this.#manifestStore.get(roomId);
            if (existingManifest) {
                existingManifest = this.#manifestStore.createIfAbsent(
                    roomId,
                    manifestDescriptor,
                    now
                );
            }
        } catch (error) {
            fail("room preparation manifest is corrupt or conflicts with the retry descriptor", {
                roomId,
                cause: error?.message
            });
        }

        // Preflight all durable identities so a collision or disagreement is
        // rejected before this call makes any new intent or ledger entry.
        const wantedReferences = new Set(payments.map((payment) => payment.paymentReference));
        const existingIntents = this.#paymentService.listPaymentIntentsForRoom(roomId);
        for (const intent of existingIntents) {
            const requirement = payments.find((payment) =>
                payment.paymentReference === intent.paymentReference
            );
            if (!requirement || !samePaymentIntent(intent, requirement, roomCreatedAt, network, asset)) {
                fail("persisted room intents do not match the authoritative descriptor", {
                    paymentReference: intent.paymentReference
                });
            }
        }

        for (const payment of payments) {
            const intent = this.#paymentService.hasPaymentIntent(payment.paymentReference)
                ? this.#paymentService.getPaymentIntent(payment.paymentReference)
                : null;
            if (intent && !samePaymentIntent(intent, payment, roomCreatedAt, network, asset)) {
                fail("payment reference is already bound to inconsistent persisted intent data", {
                    paymentReference: payment.paymentReference
                });
            }
            const oldStakeByKey = this.#ledger.store.findByIdempotencyKey(
                stakeKey(payment.paymentReference)
            );
            const oldStakeByReference = findStakeByPaymentReference(
                this.#ledger.store,
                payment.paymentReference
            );
            if ((oldStakeByKey
                    && !verifyStakeEntry(oldStakeByKey, payment, asset, network))
                || (oldStakeByReference
                    && !verifyStakeEntry(oldStakeByReference, payment, asset, network))) {
                fail("payment reference is already bound to a different stake ledger record", {
                    paymentReference: payment.paymentReference
                });
            }
            if (oldStakeByKey && oldStakeByReference
                && oldStakeByKey !== oldStakeByReference) {
                fail("payment reference and idempotency key resolve to different stake records", {
                    paymentReference: payment.paymentReference
                });
            }
        }
        // Explicitly retain the reference set for completeness and make sure
        // no duplicate survives any future change to descriptor validation.
        if (wantedReferences.size !== payments.length) {
            fail("payment references must be unique");
        }

        if (!existingManifest) {
            const roomStakes = this.#ledger.store.listForRoom?.(roomId)?.filter((entry) =>
                entry.kind === LEDGER_ENTRY_KIND.PLAYER_STAKE
            ) ?? [];
            const assignedWallet = this.#paymentService.getWalletForRoom(roomId);
            if (existingIntents.length > 0 || roomStakes.length > 0 || assignedWallet) {
                fail("cannot create a preparation manifest from partial pre-existing financial state", {
                    roomId
                });
            }
            try {
                existingManifest = this.#manifestStore.createIfAbsent(
                    roomId,
                    manifestDescriptor,
                    now
                );
            } catch (error) {
                fail("room preparation manifest could not be durably created", {
                    roomId,
                    cause: error?.message
                });
            }
        }

        // Service creation reserves/reuses exactly one room wallet and applies
        // the immutable 300-second deadline. Ledger stakes represent required
        // obligations and do not claim that principal has arrived.
        for (const payment of payments) {
            if (!this.#paymentService.hasPaymentIntent(payment.paymentReference)) {
                this.#paymentService.createPaymentIntent({
                    ...payment,
                    roomCreatedAt,
                    network,
                    asset,
                    now: existingManifest.preparationStartedAtMs
                });
            }
        }
        for (const payment of payments) {
            const key = stakeKey(payment.paymentReference);
            const appendResult = this.#ledger.recordPlayerStake({
                idempotencyKey: key,
                roomId,
                playerId: payment.playerId,
                amountAtomic: payment.amountAtomic,
                paymentReference: payment.paymentReference
            });
            validateStakeAppend(
                appendResult,
                findStakeByPaymentReference(this.#ledger.store, payment.paymentReference),
                payment,
                asset,
                network
            );
        }

        const reservation = this.#paymentService.getWalletForRoom(roomId);
        const persistedIntents = payments.map((payment) =>
            this.#paymentService.getPaymentIntent(payment.paymentReference)
        );
        const hasOpenObligations = persistedIntents.some((intent) => intent.hasOpenObligation());
        if ((hasOpenObligations && !reservation)
            || persistedIntents.some((intent, index) =>
                !samePaymentIntent(
                    intent,
                    payments[index],
                    roomCreatedAt,
                    network,
                    asset
                )
                || (reservation
                    && (intent.destinationWalletId !== reservation.walletId
                        || intent.destinationWalletAddress !== reservation.address))
            )) {
            fail("persisted room preparation state does not match its immutable manifest", { roomId });
        }

        this.#sessions.set(roomId, session);
        return this.#publicSession(session);
    }

    /**
     * Perform one explicit settlement check for an already prepared room.
     * This accepts `{ roomId }` and an optional opaque observation session
     * opened by the configured evidence provider. It accepts no caller-
     * supplied transfer, observation result, confirmation, transaction ID, or
     * trust flag. If every intent is durably SETTLED, the coordinator may
     * instead return persisted recovery without querying a provider.
     */
    async observeRoomPayments(request) {
        // `observationSession` is an opaque handle created by the configured
        // evidence provider. It can only help the observation path establish
        // its own evidence; it is never accepted as settlement authority.
        const suppliedKeys = request && typeof request === "object"
            ? Reflect.ownKeys(request)
            : [];
        const keys = suppliedKeys.includes("observationSession")
            ? OBSERVATION_REQUEST_KEYS
            : ["roomId"];
        const input = exactDataRecord(request, keys, "observation request");
        const roomId = nonEmptyString(input.roomId, "roomId");
        const session = this.#sessions.get(roomId);
        if (!session) {
            fail("room must be prepared by this adapter before observation", { roomId });
        }

        // Exactly one coordinator entry point call; no loop, retry, or polling.
        const report = await this.#coordinator.settleRoomPayments({
            roomId,
            ...(keys.includes("observationSession")
                ? { observationSession: input.observationSession }
                : {})
        });
        if (!report || report.roomId !== roomId
            || !Array.isArray(report.settled)
            || !Array.isArray(report.alreadySettled)) {
            fail("settlement coordinator returned an invalid report", { roomId });
        }

        const persistedRecovery = report.mode === "PERSISTED_SETTLEMENT_RECOVERY";
        if (persistedRecovery) {
            if (report.refusal !== null
                || report.resultWindowComplete !== false
                || report.observation !== null
                || report.settled.length !== 0) {
                fail("persisted-settlement recovery report has an invalid observation shape", { roomId });
            }
        } else if (report.refusal !== null || report.resultWindowComplete !== true) {
            return Object.freeze({ report, principalEntries: Object.freeze([]) });
        }

        const candidates = [];
        const seen = new Set();
        const reportGroups = persistedRecovery
            ? [["alreadySettled", report.alreadySettled]]
            : [["settled", report.settled], ["alreadySettled", report.alreadySettled]];
        for (const [group, rows] of reportGroups) {
            for (const row of rows) {
                if (!row || typeof row !== "object" || typeof row.paymentReference !== "string") {
                    fail("settlement coordinator report contains a malformed candidate");
                }
                const payment = session.payments.find((item) => item.paymentReference === row.paymentReference);
                if (!payment || seen.has(payment.paymentReference)) {
                    fail("settlement coordinator report does not match the prepared requirements", {
                        paymentReference: row.paymentReference
                    });
                }
                seen.add(payment.paymentReference);
                const intent = this.#paymentService.getPaymentIntent(payment.paymentReference);
                if (intent.state !== PAYMENT_INTENT_STATE.SETTLED
                    || !samePaymentIntent(intent, payment, session.roomCreatedAt, session.network, session.asset)
                    || typeof intent.transactionId !== "string"
                    || intent.transactionId.trim() === ""
                    || row.transactionId !== intent.transactionId
                    || row.playerId !== payment.playerId
                    || (persistedRecovery && (row.roomId !== roomId
                        || row.amountAtomic !== intent.amountAtomic
                        || row.asset !== intent.asset
                        || row.network !== intent.network))) {
                    fail("reported payment is not the exact persisted SETTLED intent", {
                        paymentReference: payment.paymentReference,
                        group
                    });
                }
                if (group === "settled"
                    && (row.amountAtomic !== payment.amountAtomic
                        || row.asset !== session.asset
                        || row.network !== session.network)) {
                    fail("newly settled report fields differ from the prepared payment", {
                        paymentReference: payment.paymentReference
                    });
                }
                candidates.push({ payment, transactionId: intent.transactionId });
            }
        }

        if (persistedRecovery && seen.size !== session.payments.length) {
            fail("persisted-settlement recovery does not cover every prepared payment", {
                roomId,
                reported: seen.size,
                required: session.payments.length
            });
        }

        // Preflight every existing principal entry before writing any new one.
        for (const candidate of candidates) {
            const existing = this.#ledger.store.findByIdempotencyKey(
                principalKey(candidate.payment.paymentReference)
            );
            if (existing && !verifyPrincipalEntry(existing, candidate.payment, candidate.transactionId)) {
                fail("payment reference is already bound to a different principal ledger record", {
                    paymentReference: candidate.payment.paymentReference
                });
            }
        }

        const principalEntries = [];
        for (const candidate of candidates) {
            const key = principalKey(candidate.payment.paymentReference);
            const existing = this.#ledger.store.findByIdempotencyKey(key);
            const appendResult = existing
                ? { replay: true, entry: existing }
                : this.#ledger.recordIncomingPrincipal({
                    idempotencyKey: key,
                    roomId,
                    playerId: candidate.payment.playerId,
                    amountAtomic: candidate.payment.amountAtomic,
                    confirmation: {
                        paymentReference: candidate.payment.paymentReference,
                        transactionId: candidate.transactionId,
                        source: INCOMING_PRINCIPAL_CONFIRMATION_SOURCE
                    }
                });
            const persistedEntry = this.#ledger.store.findByIdempotencyKey(key);
            if (!isUsablePrincipalAppendResult(
                appendResult,
                persistedEntry,
                key,
                candidate.payment,
                candidate.transactionId
            )) {
                fail("room ledger did not return a usable persisted principal entry", {
                    paymentReference: candidate.payment.paymentReference
                });
            }
            principalEntries.push(Object.freeze({
                paymentReference: candidate.payment.paymentReference,
                entryId: appendResult.entry.entryId,
                replay: appendResult.replay
            }));
        }

        return Object.freeze({
            report,
            principalEntries: Object.freeze(principalEntries)
        });
    }

    /**
     * Read the durable, per-player settlement state used by gameplay start.
     * The roster must come from the server's authoritative room record.
     */
    getGameStartGateStatus(roomId, roomPlayerIds) {
        const session = this.#sessions.get(roomId);
        if (!session) {
            return Object.freeze({ eligible: false, reason: "payment_session_missing" });
        }

        let manifest;
        try {
            manifest = this.#manifestStore.get(roomId);
        } catch {
            return Object.freeze({ eligible: false, reason: "payment_requirements_unavailable" });
        }
        const persistedDescriptor = manifest?.descriptor;
        const persistedSession = persistedDescriptor && {
            roomId: persistedDescriptor.roomId,
            roomCreatedAt: persistedDescriptor.roomCreatedAt,
            network: persistedDescriptor.network,
            asset: persistedDescriptor.asset,
            payments: persistedDescriptor.requiredPlayers
        };
        if (!persistedSession
            || manifest.roomId !== roomId
            || persistedDescriptor.stakeLedgerRelation !== DESCRIPTOR_STAKE_RELATION
            || !this.#sameSession(session, persistedSession)) {
            return Object.freeze({ eligible: false, reason: "persisted_payment_requirements_missing_or_mismatched" });
        }

        let intents;
        try {
            intents = session.payments.map((payment) =>
                this.#paymentService.getPaymentIntent(payment.paymentReference)
            );
        } catch {
            return Object.freeze({ eligible: false, reason: "payment_state_unavailable" });
        }

        let principalEntries;
        try {
            principalEntries = this.#ledger.store.list().filter((entry) =>
                entry.kind === LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL
                    && entry.roomId === roomId
            );
        } catch {
            return Object.freeze({ eligible: false, reason: "payment_ledger_unavailable" });
        }

        return assessThreePlayerPaymentGate({
            roomId,
            roomPlayerIds,
            network: session.network,
            asset: session.asset,
            requirements: session.payments,
            intents,
            principalEntries,
            nowMs: this.#nowProvider()
        });
    }

    #sameSession(left, right) {
        return left.roomId === right.roomId
            && left.roomCreatedAt === right.roomCreatedAt
            && left.network === right.network
            && left.asset === right.asset
            && left.payments.length === right.payments.length
            && left.payments.every((payment, index) => {
                const other = right.payments[index];
                return payment.roomId === other.roomId
                    && payment.paymentReference === other.paymentReference
                    && payment.playerId === other.playerId
                    && payment.expectedSender === other.expectedSender
                    && payment.amountAtomic === other.amountAtomic;
            });
    }

    #publicSession(session) {
        const payments = session.payments.map((payment) => {
            const intent = this.#paymentService.getPaymentIntent(payment.paymentReference);
            return Object.freeze({
                paymentReference: intent.paymentReference,
                playerId: intent.playerId,
                expectedSender: intent.expectedSender,
                amountAtomic: intent.amountAtomic,
                asset: intent.asset,
                network: intent.network,
                destinationWalletAddress: intent.destinationWalletAddress,
                expiresAt: intent.expiresAt,
                state: intent.state
            });
        });
        return Object.freeze({
            roomId: session.roomId,
            roomCreatedAt: session.roomCreatedAt,
            network: session.network,
            asset: session.asset,
            payments: Object.freeze(payments)
        });
    }

}

export { DESCRIPTOR_STAKE_RELATION };
export default RoomPaymentSessionAdapter;
