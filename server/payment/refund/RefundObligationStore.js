import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { RefundObligation, RefundObligationError } from "./RefundObligation.js";
import { deriveTonAddressIdentity } from "../incoming/TonAddressIdentity.js";

function flushFile(path, record) {
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
}

function flushDirectory(path) {
    // Windows does not expose directory fsync. Process-crash recovery is
    // supported there; power-loss durability requires filesystem validation.
    if (process.platform === "win32") return;
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeAtomic(path, record) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    flushFile(temp, record);
    renameSync(temp, path);
    flushDirectory(dirname(path));
}

function writeExclusive(path, record) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    flushFile(temp, record);
    try { linkSync(temp, path); flushDirectory(dirname(path)); }
    finally { try { unlinkSync(temp); } catch {} }
}

export class RefundObligationStore {
    constructor({ dataDir, logger = null } = {}) {
        if (typeof dataDir !== "string" || dataDir.trim() === "") throw new RefundObligationError("dataDir must be a non-empty string");
        this._dataDir = dataDir;
        this._recordsDir = join(dataDir, "refund-obligations");
        this._closedRoomsDir = join(dataDir, "closed-refund-rooms");
        this._logger = logger;
        this._byId = new Map();
        this._byIdempotency = new Map();
        this._initialized = false;
    }
    get dataDir() { return this._dataDir; }
    get size() { return this._byId.size; }
    initialize() {
        mkdirSync(this._recordsDir, { recursive: true });
        mkdirSync(this._closedRoomsDir, { recursive: true });
        this._byId.clear();
        this._byIdempotency.clear();
        for (const name of readdirSync(this._recordsDir).filter((entry) => entry.endsWith(".json"))) {
            let obligation;
            try { obligation = RefundObligation.fromRecord(JSON.parse(readFileSync(join(this._recordsDir, name), "utf8"))); }
            catch (error) { throw new RefundObligationError(`invalid persisted refund obligation ${name}`, { cause: error?.message }); }
            if (name !== `${obligation.obligationId}.json` || this._byId.has(obligation.obligationId)
                || this._byIdempotency.has(obligation.idempotencyKey)) {
                throw new RefundObligationError(`duplicate or misnamed refund obligation ${name}`);
            }
            this._index(obligation);
        }
        this._initialized = true;
        this._logger?.info?.(`RefundObligationStore ready | obligations=${this.size}`);
        return this;
    }
    create(record) {
        this._assertInitialized();
        const obligation = record instanceof RefundObligation ? record : RefundObligation.fromRecord(record);
        if (obligation.state !== "PENDING" || obligation.outgoingTransactionId !== null
            || obligation.finalizedEvidence !== null || obligation.attempts.length !== 0) {
            throw new RefundObligationError("new refund obligations must begin in the PENDING state with no attempts");
        }
        const existingId = this._byIdempotency.get(obligation.idempotencyKey);
        if (existingId) {
            const existing = this._byId.get(existingId);
            const replayComparable = (item) => {
                const { obligationId, createdAtMs, ...identity } = item.toRecord();
                return JSON.stringify(identity);
            };
            const left = replayComparable(existing);
            const right = replayComparable(obligation);
            if (left !== right) throw new RefundObligationError("idempotency key conflicts with a different refund obligation", { idempotencyKey: obligation.idempotencyKey });
            return Object.freeze({ replay: true, obligation: existing });
        }
        if (this._byId.has(obligation.obligationId)) throw new RefundObligationError("obligationId already exists");
        const path = join(this._recordsDir, `${obligation.obligationId}.json`);
        try {
            writeExclusive(path, obligation.toRecord());
        } catch (error) {
            if (error?.code !== "EEXIST" || !existsSync(path)) throw error;
            const persisted = RefundObligation.fromRecord(JSON.parse(readFileSync(path, "utf8")));
            const comparable = (item) => {
                const { obligationId, createdAtMs, ...identity } = item.toRecord();
                return JSON.stringify(identity);
            };
            if (comparable(persisted) !== comparable(obligation)) {
                throw new RefundObligationError("stable obligation identity conflicts with an existing record", { obligationId: obligation.obligationId });
            }
            this._index(persisted);
            return Object.freeze({ replay: true, obligation: persisted });
        }
        this._index(obligation);
        return Object.freeze({ replay: false, obligation });
    }
    update(record) {
        this._assertInitialized();
        const next = record instanceof RefundObligation ? record : RefundObligation.fromRecord(record);
        // The original fail-closed guard is retained for direct `update()`
        // callers. The authorized outgoing path advances SUBMITTED/COMPLETE
        // ONLY through the guarded transition methods below, which additionally
        // require a real outgoing transaction identity and validated finalized
        // evidence. This keeps the historical test contract intact.
        if (next.state === "SUBMITTED" || next.state === "COMPLETE") {
            throw new RefundObligationError("outgoing submission and completion are disabled until an authorized Testnet transfer and finalized-evidence provider exist");
        }
        return this._commitTransition(next);
    }

    /**
     * Shared, minimized transition gate: existence, immutable identity, the
     * state machine, and the single outgoing-transaction-identity rule. Both
     * `update()` and the guarded transition methods persist through here.
     */
    _commitTransition(next, expected = null, sourceWalletAddress = null) {
        // Cross-process compare-and-swap. Never steal a lock left by a crash:
        // it requires operator reconciliation, not a timeout-based resend.
        const lock = join(this._dataDir, "refund-transition.lock");
        mkdirSync(lock);
        try {
            flushDirectory(this._dataDir);
            return this._commitLocked(next, expected, sourceWalletAddress);
        } finally { rmdirSync(lock); flushDirectory(this._dataDir); }
    }

    _commitLocked(next, expected, sourceWalletAddress) {
        this._assertInitialized();
        const current = this.get(next.obligationId);
        if (!current) throw new RefundObligationError("refund obligation does not exist");
        if (expected && JSON.stringify(current.toRecord()) !== JSON.stringify(expected.toRecord())) {
            throw new RefundObligationError("refund changed in another worker; reconciliation required");
        }
        const immutableFields = [
            "idempotencyKey", "networkName", "globalId", "roomNumber", "roomId", "playerId",
            "paymentIntentId", "incomingTransactionId", "amountAtomic", "denomination",
            "payerAddress", "refundDestination", "closureReason", "createdAtMs"
        ];
        for (const field of immutableFields) {
            if (current[field] !== next[field]) throw new RefundObligationError(`refund obligation identity is immutable: ${field}`);
        }
        const allowed = {
            PENDING: ["SUBMISSION_UNKNOWN", "BLOCKED"],
            SUBMISSION_UNKNOWN: ["SUBMITTED", "RECONCILIATION_REQUIRED", "BLOCKED"],
            SUBMITTED: ["RECONCILIATION_REQUIRED", "COMPLETE", "BLOCKED"],
            RECONCILIATION_REQUIRED: ["COMPLETE", "BLOCKED"],
            BLOCKED: [],
            COMPLETE: []
        };
        if (next.state !== current.state && !allowed[current.state]?.includes(next.state)) {
            throw new RefundObligationError(`invalid refund state transition: ${current.state} -> ${next.state}`);
        }
        if (current.outgoingTransactionId && next.outgoingTransactionId !== current.outgoingTransactionId) {
            throw new RefundObligationError("outgoing transaction identity cannot be replaced");
        }
        if (next.state === "SUBMITTED" && !next.outgoingTransactionId) {
            throw new RefundObligationError("submitted refund requires an outgoing transaction identity");
        }
        if (sourceWalletAddress !== null) {
            if (current.state !== "PENDING" || next.state !== "SUBMISSION_UNKNOWN")
                throw new RefundObligationError("wallet claim requires a new submission");
            const source = deriveTonAddressIdentity(sourceWalletAddress);
            const claims = join(this._dataDir, "refund-wallet-claims");
            mkdirSync(claims, { recursive: true });
            const path = join(claims, createHash("sha256").update(source).digest("hex") + ".json");
            if (existsSync(path)) {
                const claim = JSON.parse(readFileSync(path, "utf8"));
                if (claim.source !== source || this.get(claim.obligationId)?.state !== "COMPLETE")
                    throw new RefundObligationError("room wallet has an unresolved refund submission");
                unlinkSync(path);
            }
            // Persist the wallet hold first. A crash before UNKNOWN is written
            // still blocks this wallet; another refund cannot reuse its seqno.
            writeExclusive(path, { source, obligationId: next.obligationId });
            flushDirectory(this._dataDir);
        }
        writeAtomic(join(this._recordsDir, `${next.obligationId}.json`), next.toRecord());
        this._byId.set(next.obligationId, next);
        return next;
    }

    /** Record an in-flight (or failed) submission attempt WITHOUT changing state. */
    recordSubmissionAttempt(obligationId, { attempt, lastError = null } = {}) {
        const current = this._requireExisting(attempt, obligationId);
        const next = RefundObligation.fromRecord({
            ...current.toRecord(),
            attempts: [...current.attempts, attempt],
            lastError: lastError ?? current.lastError
        });
        return this._commitTransition(next, current);
    }

    /** PENDING -> SUBMISSION_UNKNOWN: an authorized submission was attempted. */
    markSubmissionUnknown(obligationId, { attempt, lastError = null, sourceWalletAddress = null } = {}) {
        const current = this._requireExisting(attempt, obligationId);
        if (current.state !== "PENDING") {
            throw new RefundObligationError("only a PENDING refund obligation can begin submission");
        }
        const next = RefundObligation.fromRecord({
            ...current.toRecord(),
            state: "SUBMISSION_UNKNOWN",
            attempts: [...current.attempts, attempt],
            lastError
            });
        return this._commitTransition(next, current, sourceWalletAddress);
    }

    /** SUBMISSION_UNKNOWN -> SUBMITTED: the outgoing transaction is known. */
    markSubmitted(obligationId, { outgoingTransactionId, attempt, lastError = null } = {}) {
        const current = this._requireExisting(attempt, obligationId);
        if (current.state !== "SUBMISSION_UNKNOWN") {
            throw new RefundObligationError("only a SUBMISSION_UNKNOWN refund obligation can be marked submitted");
        }
        if (typeof outgoingTransactionId !== "string" || outgoingTransactionId.trim() === "") {
            throw new RefundObligationError("a submitted refund requires a non-empty outgoing transaction identity");
        }
        const next = RefundObligation.fromRecord({
            ...current.toRecord(),
            state: "SUBMITTED",
            outgoingTransactionId: outgoingTransactionId.trim(),
            attempts: [...current.attempts, attempt],
            lastError
        });
        return this._commitTransition(next, current);
    }

    /** SUBMITTED/SUBMISSION_UNKNOWN -> RECONCILIATION_REQUIRED: manual resolution. */
    markReconciliationRequired(obligationId, { attempt = null, lastError = null } = {}) {
        const current = this._requireExisting(attempt, obligationId);
        const next = RefundObligation.fromRecord({
            ...current.toRecord(),
            state: "RECONCILIATION_REQUIRED",
            attempts: attempt === null ? current.attempts : [...current.attempts, attempt],
            lastError
        });
        return this._commitTransition(next, current);
    }

    /**
     * SUBMITTED/RECONCILIATION_REQUIRED -> COMPLETE. The obligation is only
     * persisted COMPLETE when it already carries the recorded outgoing
     * transaction identity AND independently validated finalized evidence that
     * matches the obligation exactly (enforced by the RefundObligation model).
     */
    markComplete(obligationId, { finalizedEvidence, attempt = null } = {}) {
        const current = this._requireExisting(attempt, obligationId);
        if (!finalizedEvidence || typeof finalizedEvidence !== "object") {
            throw new RefundObligationError("finalized evidence is required to complete a refund obligation");
        }
        if (finalizedEvidence.transactionId !== current.outgoingTransactionId
            || !current.outgoingTransactionId) {
            throw new RefundObligationError("finalized evidence does not match the recorded outgoing transaction identity");
        }
        const next = RefundObligation.fromRecord({
            ...current.toRecord(),
            state: "COMPLETE",
            attempts: attempt === null ? current.attempts : [...current.attempts, attempt],
            finalizedEvidence
        });
        return this._commitTransition(next, current);
    }

    /**
     * Persist a fee-funded native TON refund only after the coordinator has
     * obtained independent finality and a matching immutable fee plan.
     * Gross amount remains the original stake; finalizedEvidence records NET.
     */
    markPlannedComplete(obligationId, { plan, verification, attempt = null } = {}) {
        const current = this._requireExisting(attempt, obligationId);
        if (current.state !== "SUBMITTED" && current.state !== "RECONCILIATION_REQUIRED") {
            throw new RefundObligationError("planned refund is not awaiting completion");
        }
        if (!verification || verification.verified !== true ||
            verification.obligationId !== current.obligationId ||
            verification.outgoingTransactionId !== current.outgoingTransactionId ||
            !current.outgoingTransactionId ||
            !plan || plan.obligationId !== current.obligationId ||
            plan.idempotencyKey !== current.idempotencyKey ||
            plan.networkName !== current.networkName || plan.globalId !== current.globalId ||
            plan.denomination !== current.denomination ||
            plan.refundDestination !== current.refundDestination ||
            plan.originalPaidAmountAtomic !== String(current.amountAtomic) ||
            plan.refundAmountAtomic !== verification.refundAmountAtomic ||
            plan.reservedFeeAtomic !== verification.reservedFeeAtomic ||
            verification.actualFeeAtomic !== plan.reservedFeeAtomic ||
            !/^[a-f0-9]{64}$/.test(verification.signedBodyHash) ||
            plan.sendRemainingBalance !== false ||
            !/^[1-9][0-9]*$/.test(plan.refundAmountAtomic) ||
            !/^[1-9][0-9]*$/.test(plan.reservedFeeAtomic) ||
            BigInt(plan.refundAmountAtomic) + BigInt(plan.reservedFeeAtomic) !==
                BigInt(current.amountAtomic) ||
            BigInt(plan.refundAmountAtomic) > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new RefundObligationError("planned refund evidence conflicts with immutable payment identity");
        }
        // This method is intentionally NOT an independent evidence validator.
        // Only the coordinator may pass its independently verified result.
        const finalizedEvidence = Object.freeze({
            networkName: current.networkName,
            globalId: current.globalId,
            transactionId: current.outgoingTransactionId,
            amountAtomic: Number(plan.refundAmountAtomic),
            originalPaidAmountAtomic: plan.originalPaidAmountAtomic,
            reservedFeeAtomic: plan.reservedFeeAtomic,
            actualFeeAtomic: verification.actualFeeAtomic,
            signedBodyHash: verification.signedBodyHash,
            destination: current.refundDestination,
            finalized: true,
            observedAtMs: verification.observedAtMs,
            blockId: verification.blockId
        });
        const next = RefundObligation.fromRecord({
            ...current.toRecord(),
            state: "COMPLETE",
            attempts: attempt === null ? current.attempts : [...current.attempts, attempt],
            finalizedEvidence
        });
        return this._commitTransition(next, current);
    }

    /** Any non-terminal -> BLOCKED (safe terminal hold with a diagnostic code). */
    markBlocked(obligationId, { attempt = null, lastError = null } = {}) {
        const current = this._requireExisting(attempt, obligationId);
        const next = RefundObligation.fromRecord({
            ...current.toRecord(),
            state: "BLOCKED",
            attempts: attempt === null ? current.attempts : [...current.attempts, attempt],
            lastError
        });
        return this._commitTransition(next, current);
    }

    _requireExisting(attempt, obligationId) {
        const current = this.get(obligationId);
        if (!current) throw new RefundObligationError("refund obligation does not exist");
        if (attempt !== undefined && attempt !== null && !this._isValidAttempt(attempt)) {
            throw new RefundObligationError("refund attempt is not well-formed");
        }
        return current;
    }

    _isValidAttempt(attempt) {
        if (!attempt || typeof attempt !== "object") return false;
        const allowedAttemptFields = new Set([
            "networkName", "globalId", "idempotencyKey", "attemptId", "state",
            "startedAtMs", "completedAtMs", "outgoingTransactionId", "errorCode"
        ]);
        return Object.keys(attempt).every((key) => allowedAttemptFields.has(key));
    }
    get(obligationId) {
        this._assertInitialized();
        // IDs come from durable obligations, but reject path traversal even
        // for an incorrectly wired caller or corrupted wallet claim.
        if (typeof obligationId !== "string" || !/^[A-Za-z0-9_-]+$/.test(obligationId))
            throw new RefundObligationError("invalid refund obligation identifier");
        const path = join(this._recordsDir, `${obligationId}.json`);
        if (!existsSync(path)) return null;
        const record = RefundObligation.fromRecord(JSON.parse(readFileSync(path, "utf8")));
        if (record.obligationId !== obligationId) throw new RefundObligationError("refund identity mismatch");
        this._index(record);
        return record;
    }
    findByIdempotencyKey(key) { this._assertInitialized(); const id = this._byIdempotency.get(key); return id ? this._byId.get(id) : null; }
    list() { this._assertInitialized(); return readdirSync(this._recordsDir).filter(name => name.endsWith(".json")).map(name => this.get(name.slice(0, -5))).sort((a, b) => a.createdAtMs - b.createdAtMs || a.obligationId.localeCompare(b.obligationId)); }
    listPending() { return this.list().filter((record) => record.state !== "COMPLETE"); }
    recordClosedRoom({ roomId, roomNumber, closureReason, closedAtMs, networkName = "TESTNET", globalId = -3 }) {
        this._assertInitialized();
        if (typeof roomId !== "string" || !roomId.trim()
            || !Number.isSafeInteger(roomNumber) || roomNumber < 1
            || typeof closureReason !== "string" || !closureReason.trim()
            || !Number.isSafeInteger(closedAtMs) || closedAtMs <= 0
            || networkName !== "TESTNET" || globalId !== -3) {
            throw new RefundObligationError("closed-room refund context must have explicit Testnet identity and valid room fields");
        }
        const roomKey = createHash("sha256").update(roomId).digest("hex");
        const path = join(this._closedRoomsDir, `${roomKey}.json`);
        const context = Object.freeze({ schemaVersion: 1, roomId, roomNumber, closureReason, closedAtMs, networkName, globalId });
        if (existsSync(path)) {
            const existing = JSON.parse(readFileSync(path, "utf8"));
            const originalIdentity = ({ roomId: id, roomNumber: number, closureReason: reason, networkName: network, globalId }) =>
                JSON.stringify({ roomId: id, roomNumber: number, closureReason: reason, networkName: network, globalId });
            if (originalIdentity(existing) !== originalIdentity(context)) throw new RefundObligationError("closed-room refund context conflicts with its durable original");
            return Object.freeze({ replay: true, context: Object.freeze(existing) });
        }
        writeExclusive(path, context);
        return Object.freeze({ replay: false, context });
    }
    getClosedRoom(roomId) {
        this._assertInitialized();
        const roomKey = createHash("sha256").update(roomId).digest("hex");
        const path = join(this._closedRoomsDir, `${roomKey}.json`);
        if (!existsSync(path)) return null;
        const context = JSON.parse(readFileSync(path, "utf8"));
        if (context?.schemaVersion !== 1 || context.roomId !== roomId
            || !Number.isSafeInteger(context.roomNumber) || context.roomNumber < 1
            || context.networkName !== "TESTNET" || context.globalId !== -3) {
            throw new RefundObligationError("persisted closed-room refund context is invalid");
        }
        return Object.freeze(context);
    }
    _index(obligation) { this._byId.set(obligation.obligationId, obligation); this._byIdempotency.set(obligation.idempotencyKey, obligation.obligationId); }
    _assertInitialized() { if (!this._initialized) throw new RefundObligationError("RefundObligationStore is not initialized"); }
}
