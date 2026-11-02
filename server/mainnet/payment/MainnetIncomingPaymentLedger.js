import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { durableWriteJson } from "../../payment/DurableJson.js";
import { MAINNET_GLOBAL_ID } from "../config/MainnetRuntimeConfig.js";
import { mainnetAddressIdentity } from "./MainnetAddress.js";

const SCHEMA_VERSION = 1;
const STATES = new Set(["PENDING", "SETTLED"]);
const RECEIPT_STATES = new Set(["UNRESOLVED", "AMBIGUOUS", "PENDING_FINALITY", "CONFIRMED", "EXTRA_PAYMENT"]);
const REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function emptyState() {
    return { schemaVersion: SCHEMA_VERSION, network: "mainnet", globalId: MAINNET_GLOBAL_ID,
        intents: [], observations: [], receipts: [] };
}

function assertIntent(intent) {
    if (!intent || intent.network !== "mainnet" || intent.globalId !== MAINNET_GLOBAL_ID
        || typeof intent.paymentReference !== "string" || !REF_PATTERN.test(intent.paymentReference)
        || typeof intent.roomId !== "string" || !intent.roomId
        || typeof intent.playerId !== "string" || !intent.playerId
        || typeof intent.destinationWalletId !== "string" || !intent.destinationWalletId
        || typeof intent.destinationWalletAddress !== "string"
        || typeof intent.expectedSender !== "string"
        || typeof intent.amountAtomic !== "string" || !/^[1-9][0-9]*$/.test(intent.amountAtomic)
        || intent.asset !== "TON" || !Number.isSafeInteger(intent.createdAt)
        || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= intent.createdAt
        || !STATES.has(intent.state)
        || !(intent.confirmedTransactionId === null || typeof intent.confirmedTransactionId === "string")) {
        throw new Error("MAINNET_PAYMENT_INTENT_RECORD_INVALID");
    }
    mainnetAddressIdentity(intent.destinationWalletAddress);
    mainnetAddressIdentity(intent.expectedSender);
    if (intent.state === "SETTLED" && !intent.confirmedTransactionId) {
        throw new Error("MAINNET_SETTLED_INTENT_MISSING_TRANSACTION");
    }
}

export class MainnetIncomingPaymentLedger {
    constructor({ config, nowProvider = Date.now } = {}) {
        if (config?.network !== "mainnet" || config?.globalId !== MAINNET_GLOBAL_ID
            || typeof config?.dataDir !== "string" || !config.dataDir
            || typeof nowProvider !== "function") {
            throw new Error("MAINNET_INCOMING_LEDGER_CONFIG_REQUIRED");
        }
        this.network = "mainnet";
        this.globalId = MAINNET_GLOBAL_ID;
        this._file = join(config.dataDir, "incoming-payment-ledger", "state.json");
        this._now = nowProvider;
        this._state = emptyState();
        this._initialized = false;
    }

    initialize() {
        if (this._initialized) return this;
        mkdirSync(join(this._file, ".."), { recursive: true });
        if (existsSync(this._file)) {
            let state;
            try { state = JSON.parse(readFileSync(this._file, "utf8")); }
            catch { throw new Error("MAINNET_INCOMING_LEDGER_CORRUPT"); }
            this._validateState(state);
            this._state = {
                ...state,
                intents: state.intents.map((item) => Object.freeze(item)),
                observations: state.observations.map((item) => Object.freeze(item)),
                receipts: state.receipts.map((item) => Object.freeze(item))
            };
        } else {
            durableWriteJson(this._file, this._state, { exclusive: true });
        }
        this._initialized = true;
        return this;
    }

    createRoomPaymentIntents({ roomId, wallet, players, createdAt = this._now(), expiresAt } = {}) {
        this._assertInitialized();
        const normalizedRoomId = typeof roomId === "string" ? roomId.trim() : "";
        if (!normalizedRoomId
            || wallet?.network !== "mainnet" || wallet?.globalId !== MAINNET_GLOBAL_ID
            || typeof wallet.walletId !== "string" || !wallet.walletId
            || !Array.isArray(players) || players.length !== 3
            || !Number.isSafeInteger(createdAt) || createdAt <= 0
            || !Number.isSafeInteger(expiresAt) || expiresAt <= createdAt) {
            throw new Error("MAINNET_ROOM_PAYMENT_INTENTS_INVALID");
        }
        mainnetAddressIdentity(wallet.address);
        if (this._state.intents.some((intent) => intent.roomId === normalizedRoomId)) {
            throw new Error("MAINNET_ROOM_PAYMENT_INTENTS_ALREADY_EXIST");
        }
        const playerIds = new Set();
        const references = new Set();
        const intents = players.map((player) => {
            const playerId = typeof player?.playerId === "string" ? player.playerId.trim() : "";
            if (!player || !playerId
                || playerIds.has(playerId)
                || typeof player.amountAtomic !== "string" && !Number.isSafeInteger(player.amountAtomic)) {
                throw new Error("MAINNET_PAYMENT_PLAYER_INVALID");
            }
            const amount = String(player.amountAtomic);
            if (!/^[1-9][0-9]*$/.test(amount)) throw new Error("MAINNET_PAYMENT_AMOUNT_INVALID");
            const reference = player.paymentReference ?? `mn_${randomUUID().replaceAll("-", "")}`;
            if (typeof reference !== "string" || !REF_PATTERN.test(reference) || references.has(reference)
                || this._state.intents.some((item) => item.paymentReference === reference)) {
                throw new Error("MAINNET_PAYMENT_REFERENCE_INVALID_OR_DUPLICATE");
            }
            mainnetAddressIdentity(player.expectedSender);
            playerIds.add(playerId);
            references.add(reference);
            const intent = Object.freeze({
                paymentReference: reference,
                roomId: normalizedRoomId,
                playerId,
                network: "mainnet",
                globalId: MAINNET_GLOBAL_ID,
                destinationWalletId: wallet.walletId,
                destinationWalletAddress: wallet.address,
                expectedSender: player.expectedSender,
                amountAtomic: amount,
                asset: "TON",
                createdAt,
                expiresAt,
                state: "PENDING",
                confirmedTransactionId: null,
                settledAt: null
            });
            assertIntent(intent);
            return intent;
        });
        const next = { ...this._state, intents: [...this._state.intents, ...intents] };
        this._persist(next);
        return Object.freeze([...intents]);
    }

    listRoomIntents(roomId) {
        this._assertInitialized();
        return Object.freeze(this._state.intents.filter((intent) => intent.roomId === roomId));
    }

    listAllIntents() {
        this._assertInitialized();
        return Object.freeze([...this._state.intents]);
    }

    getIntent(paymentReference) {
        this._assertInitialized();
        return this._state.intents.find((intent) => intent.paymentReference === paymentReference) ?? null;
    }

    getRoomPaymentStatus(roomId) {
        this._assertInitialized();
        const intents = this.listRoomIntents(roomId);
        const confirmedCount = intents.filter((intent) => intent.state === "SETTLED").length;
        return Object.freeze({
            roomId,
            network: "mainnet",
            globalId: MAINNET_GLOBAL_ID,
            confirmedCount,
            requiredCount: 3,
            financialReady: intents.length === 3 && confirmedCount === 3,
            page5Enabled: false,
            status: `${confirmedCount}/3`
        });
    }

    getReceipt(transactionId) {
        this._assertInitialized();
        return this._state.receipts.find((receipt) => receipt.transactionId === transactionId) ?? null;
    }

    listReceipts(roomId = null) {
        this._assertInitialized();
        return Object.freeze(this._state.receipts.filter((receipt) => roomId === null || receipt.roomId === roomId));
    }

    listObservations(roomId = null) {
        this._assertInitialized();
        return Object.freeze(this._state.observations.filter((entry) => roomId === null || entry.roomId === roomId));
    }

    ensureObservationConsistent(observation) {
        this._assertInitialized();
        const prior = this._state.observations.find((entry) => entry.transactionId === observation.transactionId);
        if (prior && prior.payloadFingerprint !== observation.payloadFingerprint) {
            throw new Error("MAINNET_TRANSACTION_IDENTITY_CONFLICT");
        }
        return prior ?? null;
    }

    /** Persist observation, receipt, and any confirmed intent transition in one atomic snapshot. */
    recordTransfer({ observation, receipt, settleReference = null } = {}) {
        this._assertInitialized();
        if (!observation || observation.network !== "mainnet" || observation.globalId !== MAINNET_GLOBAL_ID
            || typeof observation.transactionId !== "string" || !observation.transactionId
            || typeof observation.payloadFingerprint !== "string"
            || !receipt || receipt.transactionId !== observation.transactionId
            || receipt.network !== "mainnet" || receipt.globalId !== MAINNET_GLOBAL_ID
            || !RECEIPT_STATES.has(receipt.status)) {
            throw new Error("MAINNET_RECEIPT_RECORD_INVALID");
        }
        const existingObservation = this.ensureObservationConsistent(observation);
        const currentReceipt = this.getReceipt(receipt.transactionId);
        let intentUpdates = this._state.intents;
        if (settleReference !== null) {
            const intent = this.getIntent(settleReference);
            if (!intent) throw new Error("MAINNET_SETTLEMENT_INTENT_NOT_FOUND");
            if (intent.state === "SETTLED") {
                if (intent.confirmedTransactionId !== observation.transactionId) {
                    throw new Error("MAINNET_INTENT_ALREADY_SETTLED_BY_OTHER_TRANSACTION");
                }
            } else {
                if (intent.roomId !== receipt.roomId || receipt.status !== "CONFIRMED") {
                    throw new Error("MAINNET_SETTLEMENT_RECEIPT_BINDING_INVALID");
                }
                intentUpdates = this._state.intents.map((item) => item.paymentReference === settleReference
                    ? Object.freeze({ ...item, state: "SETTLED", confirmedTransactionId: observation.transactionId,
                        settledAt: this._now() }) : item);
            }
        }
        if (receipt.status === "CONFIRMED" && settleReference === null) {
            throw new Error("MAINNET_CONFIRMED_RECEIPT_MISSING_INTENT");
        }
        const stableReceipt = currentReceipt?.status === "CONFIRMED" || currentReceipt?.status === "EXTRA_PAYMENT"
            ? currentReceipt : Object.freeze(receipt);
        const observations = existingObservation
            ? this._state.observations : [...this._state.observations, Object.freeze(observation)];
        const receipts = currentReceipt
            ? this._state.receipts.map((item) => item.transactionId === receipt.transactionId ? stableReceipt : item)
            : [...this._state.receipts, stableReceipt];
        const unchanged = existingObservation && currentReceipt
            && stableReceipt.status === currentReceipt.status
            && JSON.stringify(intentUpdates) === JSON.stringify(this._state.intents);
        if (unchanged) return Object.freeze({ duplicate: true, receipt: currentReceipt });
        const next = { ...this._state, observations, receipts, intents: intentUpdates };
        this._validateState(next);
        this._persist(next);
        return Object.freeze({ duplicate: false, receipt: stableReceipt });
    }

    _persist(state) {
        durableWriteJson(this._file, state);
        this._state = state;
    }

    _validateState(state) {
        if (!state || state.schemaVersion !== SCHEMA_VERSION || state.network !== "mainnet"
            || state.globalId !== MAINNET_GLOBAL_ID || !Array.isArray(state.intents)
            || !Array.isArray(state.observations) || !Array.isArray(state.receipts)) {
            throw new Error("MAINNET_INCOMING_LEDGER_IDENTITY_OR_SCHEMA_INVALID");
        }
        const refs = new Set();
        for (const intent of state.intents) {
            assertIntent(intent);
            if (refs.has(intent.paymentReference)) throw new Error("MAINNET_PAYMENT_REFERENCE_DUPLICATE");
            refs.add(intent.paymentReference);
        }
        const observationIds = new Set();
        for (const item of state.observations) {
            if (!item || item.network !== "mainnet" || item.globalId !== MAINNET_GLOBAL_ID
                || typeof item.transactionId !== "string" || !item.transactionId
                || typeof item.payloadFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.payloadFingerprint)
                || typeof item.roomId !== "string" || !item.roomId
                || !Number.isSafeInteger(item.transactionTime) || !Number.isSafeInteger(item.observedAt)
                || observationIds.has(item.transactionId)) {
                throw new Error("MAINNET_OBSERVATION_LEDGER_INVALID");
            }
            mainnetAddressIdentity(item.sourceAddress);
            mainnetAddressIdentity(item.destinationAddress);
            if (typeof item.amountAtomic !== "string" || !/^[1-9][0-9]*$/.test(item.amountAtomic)
                || item.asset !== "TON") throw new Error("MAINNET_OBSERVATION_LEDGER_INVALID");
            observationIds.add(item.transactionId);
        }
        const receiptIds = new Set();
        for (const receipt of state.receipts) {
            if (!receipt || receipt.network !== "mainnet" || receipt.globalId !== MAINNET_GLOBAL_ID
                || typeof receipt.transactionId !== "string" || !observationIds.has(receipt.transactionId)
                || !RECEIPT_STATES.has(receipt.status) || receiptIds.has(receipt.transactionId)
                || typeof receipt.roomId !== "string" || !receipt.roomId
                || typeof receipt.reason !== "string" && receipt.reason !== null
                || !Number.isSafeInteger(receipt.transactionTime) || !Number.isSafeInteger(receipt.updatedAt)
                || typeof receipt.amountAtomic !== "string" || !/^[1-9][0-9]*$/.test(receipt.amountAtomic)
                || receipt.asset !== undefined && receipt.asset !== "TON") {
                throw new Error("MAINNET_RECEIPT_LEDGER_INVALID");
            }
            mainnetAddressIdentity(receipt.sourceAddress);
            mainnetAddressIdentity(receipt.destinationAddress);
            receiptIds.add(receipt.transactionId);
            if (receipt.status === "CONFIRMED") {
                const intent = state.intents.find((item) => item.paymentReference === receipt.paymentReference);
                if (!intent || intent.state !== "SETTLED" || intent.confirmedTransactionId !== receipt.transactionId) {
                    throw new Error("MAINNET_RECEIPT_INTENT_BINDING_INVALID");
                }
            }
        }
        for (const intent of state.intents) {
            if (intent.state === "SETTLED"
                && !state.receipts.some((receipt) => receipt.status === "CONFIRMED"
                    && receipt.paymentReference === intent.paymentReference
                    && receipt.transactionId === intent.confirmedTransactionId)) {
                throw new Error("MAINNET_SETTLED_INTENT_RECEIPT_MISSING");
            }
        }
    }

    _assertInitialized() {
        if (!this._initialized) throw new Error("MAINNET_INCOMING_LEDGER_NOT_INITIALIZED");
    }
}
