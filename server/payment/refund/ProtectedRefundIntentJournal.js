/**
 * PREPARATION ONLY — native-GRAM Testnet refund intent journal.
 *
 * This module has no signer, BOC, broadcaster, wallet release or chain-finalizer.
 * It binds a refundable debt to a verified settled SQLite payment intent, writes
 * one immutable fee plan, then permanently holds the wallet when a would-be
 * outgoing transfer is claimed. Locking requires ONE SHARED PERSISTENT VOLUME.
 * An ambiguous crash is intentionally left locked for later proof-based recovery.
 */
import { createHash, randomUUID } from "node:crypto";
import {
    mkdirSync, openSync, writeFileSync, readFileSync, linkSync,
    unlinkSync, renameSync, realpathSync, fsyncSync, closeSync, existsSync
} from "node:fs";
import { resolve, join } from "node:path";
import { Address } from "@ton/core";
import { inspectProtectedRefundV4Boc } from "./ProtectedRefundV4Boc.js";

export class ProtectedRefundIntentError extends Error {
    constructor(code) {
        super(code);
        this.name = "ProtectedRefundIntentError";
        this.code = code;
    }
}
const assert = (ok, code) => {
    if (!ok) throw new ProtectedRefundIntentError(code);
};
const sha = value => createHash("sha256").update(value).digest("hex");
const isHash = value => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const syncDir = path => {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
};
function identity(value) {
    try {
        const address = Address.parse(value);
        assert(address.workChain === 0, "REFUND_ADDRESS_WORKCHAIN");
        return address.toRawString().toLowerCase();
    } catch (error) {
        if (error instanceof ProtectedRefundIntentError) throw error;
        throw new ProtectedRefundIntentError("REFUND_ADDRESS_INVALID");
    }
}
function checksum(record) {
    const { checksum: unused, ...rest } = record;
    return sha(JSON.stringify(rest));
}
function seal(record) {
    const payload = { ...record };
    return { ...payload, checksum: checksum(payload) };
}
function durableNew(path, data, dir) {
    const tmp = path + "." + randomUUID() + ".tmp";
    const fd = openSync(tmp, "wx", 0o600);
    try {
        writeFileSync(fd, JSON.stringify(data) + "\n", "utf8");
        fsyncSync(fd);
    } finally { closeSync(fd); }
    try {
        linkSync(tmp, path); // atomic claim: fails if another writer won
        syncDir(dir);
    } finally {
        unlinkSync(tmp);
    }
}
function durableReplace(path, data, dir) {
    const tmp = path + "." + randomUUID() + ".tmp";
    const fd = openSync(tmp, "wx", 0o600);
    try {
        writeFileSync(fd, JSON.stringify(data) + "\n", "utf8");
        fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, path);
    syncDir(dir);
}
function readSealed(path) {
    const data = JSON.parse(readFileSync(path, "utf8"));
    assert(data && typeof data === "object" && data.checksum === checksum(data),
        "REFUND_JOURNAL_CORRUPT");
    return data;
}

export class ProtectedRefundIntentJournal {
    constructor({ directory, refundStore, intentStore } = {}) {
        assert(typeof directory === "string" && directory.length > 0,
            "REFUND_JOURNAL_DIRECTORY_REQUIRED");
        assert(typeof refundStore?.get === "function"
            && typeof refundStore?.getClosedRoom === "function"
            && typeof intentStore?.require === "function",
            "REFUND_AUTHORITATIVE_STORES_REQUIRED");
        this._refunds = refundStore;
        this._intents = intentStore;
        this._root = resolve(directory);
        this._records = join(this._root, "refund-intents");
        this._locks = join(this._root, "wallet-signing-holds");
        mkdirSync(this._records, { recursive: true, mode: 0o700 });
        mkdirSync(this._locks, { recursive: true, mode: 0o700 });
        this._records = realpathSync(this._records);
        this._locks = realpathSync(this._locks);
    }

    _source(obligationId) {
        const debt = this._refunds.get(obligationId);
        assert(debt && debt.networkName === "TESTNET" && debt.globalId === -3
            && debt.state === "PENDING" && debt.outgoingTransactionId === null
            && debt.finalizedEvidence === null, "REFUND_DEBT_NOT_PENDING");
        const closed = this._refunds.getClosedRoom(debt.roomId);
        assert(closed?.networkName === "TESTNET" && closed.globalId === -3
            && closed.roomNumber === debt.roomNumber
            && closed.closureReason === debt.closureReason,
            "REFUND_ROOM_NOT_DURABLY_CLOSED");
        const incoming = this._intents.require(debt.paymentIntentId);
        assert(incoming && incoming.state === "SETTLED"
            && incoming.network === "testnet"
            && incoming.roomId === debt.roomId
            && incoming.playerId === debt.playerId
            && incoming.paymentReference === debt.paymentIntentId
            && incoming.transactionId === debt.incomingTransactionId
            && incoming.amountAtomic === debt.amountAtomic
            && incoming.asset.toUpperCase() === "GRAM",
            "REFUND_PAYMENT_INTENT_MISMATCH");
        const payer = identity(incoming.expectedSender);
        const to = identity(debt.refundDestination);
        const from = identity(incoming.destinationWalletAddress);
        assert(payer === to && payer === identity(debt.payerAddress) && from !== to,
            "REFUND_ADDRESS_IDENTITY_MISMATCH");
        assert(Number.isSafeInteger(debt.amountAtomic) && debt.amountAtomic > 0,
            "REFUND_GROSS_INVALID");
        return {
            obligationId: debt.obligationId,
            roomId: debt.roomId,
            roomNumber: debt.roomNumber,
            playerId: debt.playerId,
            paymentReference: debt.paymentIntentId,
            incomingTransactionId: debt.incomingTransactionId,
            grossAtomic: debt.amountAtomic,
            fromWallet: from,
            toWallet: to
        };
    }

    /** Persist exactly one immutable plan. Gas is charged to this refundee. */
    plan({ obligationId, feeAtomic, feeQuoteHash } = {}) {
        const debt = this._source(obligationId);
        assert(Number.isSafeInteger(feeAtomic) && feeAtomic >= 0
            && feeAtomic < debt.grossAtomic, "REFUND_FEE_INVALID");
        assert(isHash(feeQuoteHash), "REFUND_FEE_PROVENANCE_REQUIRED");
        const intentId = "rwi_" + sha(debt.obligationId + "|" + debt.incomingTransactionId);
        const frozen = {
            schemaVersion: 1, intentId, role: "REFUND", network: "testnet",
            ...debt, feeAtomic, netAtomic: debt.grossAtomic - feeAtomic,
            feeQuoteHash: feeQuoteHash.toLowerCase()
        };
        const path = join(this._records, intentId + ".json");
        const record = seal({ ...frozen, state: "PLANNED", ownerToken: null,
            signedHash: null, seqno: null, validUntil: null });
        try {
            durableNew(path, record, this._records);
            return Object.freeze({ created: true, intentId });
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
            const old = readSealed(path);
            for (const [key, value] of Object.entries(frozen)) {
                assert(old[key] === value, "REFUND_IMMUTABLE_PLAN_CONFLICT");
            }
            return Object.freeze({ created: false, intentId, state: old.state });
        }
    }

    load(intentId) {
        assert(typeof intentId === "string" && /^rwi_[a-f0-9]{64}$/.test(intentId),
            "REFUND_INTENT_ID_INVALID");
        const path = join(this._records, intentId + ".json");
        assert(existsSync(path), "REFUND_INTENT_MISSING");
        const item = readSealed(path);
        assert(item.intentId === intentId && item.network === "testnet"
            && item.role === "REFUND" && ["PLANNED", "SIGNED_HELD", "CONFIRMATION_UNKNOWN"].includes(item.state),
            "REFUND_JOURNAL_INVALID_STATE");
        return Object.freeze(item);
    }

    /** Atomic across processes sharing the same durable filesystem. No TTL. */
    claimWallet(intentId) {
        const plan = this.load(intentId);
        assert(plan.state === "PLANNED", "REFUND_ALREADY_HELD");
        this._source(plan.obligationId); // reject a debt that changed since plan
        const lock = join(this._locks, sha(plan.fromWallet));
        try {
            mkdirSync(lock, { mode: 0o700 });
            syncDir(this._locks);
        } catch (error) {
            if (error?.code === "EEXIST") {
                throw new ProtectedRefundIntentError("WALLET_ALREADY_LOCKED");
            }
            throw error;
        }
        // A crash here retains the empty lock: no speculative recovery.
        const ownerToken = randomUUID();
        const metadata = { intentId, fromWallet: plan.fromWallet, ownerToken };
        const fd = openSync(join(lock, "owner.json"), "wx", 0o600);
        try {
            writeFileSync(fd, JSON.stringify(metadata) + "\n", "utf8");
            fsyncSync(fd);
        } finally { closeSync(fd); }
        syncDir(lock);
        return Object.freeze({ intentId, ownerToken, fromWallet: plan.fromWallet });
    }

    _assertOwner(item, ownerToken) {
        const lock = join(this._locks, sha(item.fromWallet), "owner.json");
        assert(existsSync(lock), "REFUND_WALLET_LOCK_MISSING");
        const data = JSON.parse(readFileSync(lock, "utf8"));
        assert(typeof ownerToken === "string" && data.ownerToken === ownerToken
            && data.intentId === item.intentId && data.fromWallet === item.fromWallet,
            "REFUND_LOCK_OWNER_MISMATCH");
    }

    /**
     * Persist only a parsed, structurally valid Wallet V4 external BOC.
     * THIS DOES NOT authenticate its Ed25519 signature and CANNOT broadcast.
     * Real signing authority and chain seqno checks require a later guarded
     * executor and cannot be bypassed with arbitrary user-provided hashes.
     */
    holdPreparedBoc({ intentId, ownerToken, bocBase64 } = {}) {
        const item = this.load(intentId);
        this._assertOwner(item, ownerToken);
        assert(item.state === "PLANNED", "REFUND_ALREADY_SIGNED");
        this._source(item.obligationId);
        const result = inspectProtectedRefundV4Boc({
            bocBase64, fromWallet: item.fromWallet,
            toWallet: item.toWallet, netAtomic: item.netAtomic
        });
        assert(result.broadcastAuthorized === false
            && result.signatureAuthenticated === false,
            "REFUND_PREPARATION_MUST_BE_OFFLINE");
        const next = seal({ ...item, state: "SIGNED_HELD",
            ownerToken, signedHash: result.signedHash,
            seqno: result.seqno, validUntil: result.validUntil,
            checksum: undefined });
        durableReplace(join(this._records, intentId + ".json"), next, this._records);
        return this.load(intentId);
    }

    // Retained as an explicit rejection for callers of the old API.
    // A supplied hash/amount/seqno is not evidence of any signed TON message.
    holdSignedIdentity() {
        throw new ProtectedRefundIntentError("REFUND_UNVERIFIED_SIGNED_IDENTITY_DISABLED");
    }

    /** Even an RPC timeout must NEVER turn an unknown send into a retry. */
    markUnknown({ intentId, ownerToken } = {}) {
        const item = this.load(intentId);
        this._assertOwner(item, ownerToken);
        assert(item.state === "SIGNED_HELD", "REFUND_NOT_SIGNED_HELD");
        const next = seal({ ...item, state: "CONFIRMATION_UNKNOWN", checksum: undefined });
        durableReplace(join(this._records, intentId + ".json"), next, this._records);
        return this.load(intentId);
    }
}
