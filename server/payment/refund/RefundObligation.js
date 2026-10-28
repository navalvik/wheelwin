import { createHash, randomBytes } from "node:crypto";

export const REFUND_NETWORK = Object.freeze({ TESTNET: "TESTNET", MAINNET: "MAINNET" });
export const REFUND_STATE = Object.freeze({
    PENDING: "PENDING",
    SUBMISSION_UNKNOWN: "SUBMISSION_UNKNOWN",
    SUBMITTED: "SUBMITTED",
    RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED",
    COMPLETE: "COMPLETE",
    BLOCKED: "BLOCKED"
});
export const REFUND_SCHEMA_VERSION = 1;

export class RefundObligationError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "RefundObligationError";
        this.code = "REFUND_OBLIGATION_INVALID";
        this.details = Object.freeze({ ...details });
    }
}

const text = (value, field) => {
    if (typeof value !== "string" || value.trim() === "") {
        throw new RefundObligationError(`${field} must be a non-empty string`, { field });
    }
    return value.trim();
};

export function createRefundObligationId(idempotencyKey = null) {
    const digest = idempotencyKey === null
        ? randomBytes(16).toString("hex")
        : createHash("sha256").update(text(idempotencyKey, "idempotencyKey")).digest("hex").slice(0, 32);
    return `rfd_${digest}`;
}

export function refundIdempotencyKey({ networkName, paymentIntentId, incomingTransactionId }) {
    return `${text(networkName, "networkName")}:${text(paymentIntentId, "paymentIntentId")}:${text(incomingTransactionId, "incomingTransactionId")}`;
}

export class RefundObligation {
    constructor(record) {
        if (!record || typeof record !== "object") throw new RefundObligationError("record must be an object");
        if (record.schemaVersion !== REFUND_SCHEMA_VERSION) throw new RefundObligationError("unsupported schemaVersion");
        this.obligationId = text(record.obligationId, "obligationId");
        this.idempotencyKey = text(record.idempotencyKey, "idempotencyKey");
        this.networkName = text(record.networkName, "networkName");
        if (!Object.values(REFUND_NETWORK).includes(this.networkName)) throw new RefundObligationError("unsupported networkName");
        if (!Number.isSafeInteger(record.globalId)) throw new RefundObligationError("globalId must be a safe integer");
        if (this.networkName === REFUND_NETWORK.TESTNET && record.globalId !== -3) throw new RefundObligationError("Testnet globalId must be -3");
        this.globalId = record.globalId;
        this.roomNumber = record.roomNumber;
        if (!Number.isSafeInteger(this.roomNumber) || this.roomNumber < 1) throw new RefundObligationError("roomNumber must be a positive integer");
        this.roomId = text(record.roomId, "roomId");
        this.playerId = text(record.playerId, "playerId");
        this.paymentIntentId = text(record.paymentIntentId, "paymentIntentId");
        this.incomingTransactionId = text(record.incomingTransactionId, "incomingTransactionId");
        if (!Number.isSafeInteger(record.amountAtomic) || record.amountAtomic <= 0) throw new RefundObligationError("amountAtomic must be a positive safe integer");
        this.amountAtomic = record.amountAtomic;
        // Gross obligation is immutable. For player-pays-gas refunds the
        // actually transmitted amount is smaller by an independently quoted,
        // persisted gas charge. Older obligations default to full gross.
        this.transferAmountAtomic = record.transferAmountAtomic ?? null;
        this.gasChargeAtomic = record.gasChargeAtomic ?? null;
        if ((this.transferAmountAtomic === null) !== (this.gasChargeAtomic === null)) {
            throw new RefundObligationError("refund net amount and charged gas must be persisted together");
        }
        if (this.transferAmountAtomic !== null) {
            if (!Number.isSafeInteger(this.transferAmountAtomic) || this.transferAmountAtomic <= 0
                || !Number.isSafeInteger(this.gasChargeAtomic) || this.gasChargeAtomic <= 0
                || this.transferAmountAtomic + this.gasChargeAtomic !== this.amountAtomic) {
                throw new RefundObligationError("refund amount plus player-paid gas must equal gross principal");
            }
            if (record.state === REFUND_STATE.PENDING) {
                throw new RefundObligationError("pending refund cannot already carry a signed transfer plan");
            }
        }
        this.denomination = text(record.denomination, "denomination");
        this.payerAddress = text(record.payerAddress, "payerAddress");
        this.refundDestination = text(record.refundDestination, "refundDestination");
        if (this.payerAddress !== this.refundDestination) throw new RefundObligationError("refund destination must match the verified payer address");
        this.closureReason = text(record.closureReason, "closureReason");
        if (!Number.isSafeInteger(record.createdAtMs) || record.createdAtMs <= 0) throw new RefundObligationError("createdAtMs must be a positive safe integer");
        this.createdAtMs = record.createdAtMs;
        if (!Object.values(REFUND_STATE).includes(record.state)) throw new RefundObligationError("unknown refund state");
        this.state = record.state;
        this.attempts = Object.freeze((record.attempts ?? []).map((attempt) => {
            const allowedAttemptFields = new Set([
                "networkName", "globalId", "idempotencyKey", "attemptId", "state",
                "startedAtMs", "completedAtMs", "outgoingTransactionId", "errorCode"
            ]);
            if (!attempt || typeof attempt !== "object"
                || Object.keys(attempt).some((key) => !allowedAttemptFields.has(key))) {
                throw new RefundObligationError("refund attempt contains unsupported or sensitive fields");
            }
            if (attempt.networkName !== this.networkName || attempt.globalId !== this.globalId
                || attempt.idempotencyKey !== this.idempotencyKey) {
                throw new RefundObligationError("refund attempt network or idempotency identity conflicts with its obligation");
            }
            return Object.freeze({ ...attempt });
        }));
        this.outgoingTransactionId = record.outgoingTransactionId ?? null;
        if (record.finalizedEvidence) {
            const allowedEvidenceFields = new Set([
                "networkName", "globalId", "transactionId", "amountAtomic",
                "destination", "finalized", "observedAtMs", "blockId"
            ]);
            if (Object.keys(record.finalizedEvidence).some((key) => !allowedEvidenceFields.has(key))) {
                throw new RefundObligationError("finalized evidence contains unsupported fields");
            }
            this.finalizedEvidence = Object.freeze({ ...record.finalizedEvidence });
        } else this.finalizedEvidence = null;
        if (record.lastError !== undefined && record.lastError !== null
            && (typeof record.lastError !== "string" || /secret|mnemonic|private.?key|api.?key/i.test(record.lastError))) {
            throw new RefundObligationError("lastError must be a safe, non-secret diagnostic code");
        }
        this.lastError = record.lastError ?? null;
        if (this.finalizedEvidence) {
            if (this.state !== REFUND_STATE.COMPLETE
                || this.finalizedEvidence.networkName !== this.networkName
                || this.finalizedEvidence.globalId !== this.globalId
                || this.finalizedEvidence.transactionId !== this.outgoingTransactionId
                || this.finalizedEvidence.amountAtomic !== (this.transferAmountAtomic ?? this.amountAtomic)
                || this.finalizedEvidence.destination !== this.refundDestination
                || this.finalizedEvidence.finalized !== true) {
                throw new RefundObligationError("finalized evidence does not match the outgoing refund identity");
            }
        } else if (this.state === REFUND_STATE.COMPLETE) {
            throw new RefundObligationError("refund cannot be complete without finalized evidence");
        }
        Object.freeze(this);
    }

    toRecord() {
        return Object.freeze({
            schemaVersion: REFUND_SCHEMA_VERSION,
            obligationId: this.obligationId,
            idempotencyKey: this.idempotencyKey,
            networkName: this.networkName,
            globalId: this.globalId,
            roomNumber: this.roomNumber,
            roomId: this.roomId,
            playerId: this.playerId,
            paymentIntentId: this.paymentIntentId,
            incomingTransactionId: this.incomingTransactionId,
            amountAtomic: this.amountAtomic,
            transferAmountAtomic: this.transferAmountAtomic,
            gasChargeAtomic: this.gasChargeAtomic,
            denomination: this.denomination,
            payerAddress: this.payerAddress,
            refundDestination: this.refundDestination,
            closureReason: this.closureReason,
            createdAtMs: this.createdAtMs,
            state: this.state,
            attempts: this.attempts,
            outgoingTransactionId: this.outgoingTransactionId,
            finalizedEvidence: this.finalizedEvidence,
            lastError: this.lastError
        });
    }

    static fromRecord(record) { return new RefundObligation(record); }
}
