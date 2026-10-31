/**
 * Mainnet phase 4B: append-only durable REVIEW journal, not a payment ledger.
 *
 * One file per Mainnet transaction hash, on a server-owned persistent volume.
 * The exclusive durable write enforces one immutable claim across process
 * crashes and concurrent writers. Duplicate transaction or reference claims
 * with incompatible room/player identities fail closed. No SETTLED state,
 * wallet capability, payout, refund, game-start authorization or RPC exists.
 *
 * Records loaded after restart are still candidates, NEVER finality proofs.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { durableWriteJson } from "../payment/DurableJson.js";
import { parseTonAddress } from "../payment/incoming/TonAddressIdentity.js";
import { isMainnetCandidateReport } from "./MainnetPaymentCandidateEvaluator.js";

function fail(code) { throw new Error(code); }
function nonEmpty(value, max = 256) {
    return typeof value === "string" && value.length > 0
        && value.length <= max && value.trim() === value;
}
function canonical(value) {
    try {
        const parsed = parseTonAddress(value);
        return parsed.workchain === 0 && parsed.testOnly !== true
            ? parsed.identity : null;
    } catch {
        return null;
    }
}
function fileName(txId) {
    return createHash("sha256").update("mainnet:"+txId).digest("hex")+".json";
}
function referenceFileName(reference) {
    return createHash("sha256").update("mainnet:reference:"+reference).digest("hex")+".json";
}
function toRecord(candidate) {
    return Object.freeze({
        schemaVersion: 1,
        network: "mainnet",
        asset: "TON",
        status: "PROVIDER_INDEXED_CANDIDATE",
        roomId: candidate.roomId,
        playerId: candidate.playerId,
        paymentReference: candidate.paymentReference,
        transactionId: candidate.transactionId,
        roomWalletAddress: candidate.roomWalletAddress,
        senderAddress: candidate.senderAddress,
        amountAtomic: candidate.amountAtomic,
        transactionTimeMs: candidate.transactionTimeMs,
        masterchainInclusionSeqno: candidate.masterchainInclusionSeqno,
        settlementAuthorized: false,
        gameStartAuthorized: false
    });
}
function validate(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)
        || record.schemaVersion !== 1
        || record.network !== "mainnet" || record.asset !== "TON"
        || record.status !== "PROVIDER_INDEXED_CANDIDATE"
        || record.settlementAuthorized !== false
        || record.gameStartAuthorized !== false
        || !nonEmpty(record.roomId)
        || !nonEmpty(record.playerId)
        || !nonEmpty(record.transactionId)
        || typeof record.paymentReference !== "string"
        || !/^[A-Za-z0-9_-]{1,64}$/.test(record.paymentReference)
        || !canonical(record.roomWalletAddress)
        || !canonical(record.senderAddress)
        || record.roomWalletAddress !== canonical(record.roomWalletAddress)
        || record.senderAddress !== canonical(record.senderAddress)
        || typeof record.amountAtomic !== "string"
        || !/^[1-9][0-9]*$/.test(record.amountAtomic)
        || !Number.isSafeInteger(record.transactionTimeMs)
        || record.transactionTimeMs <= 0
        || !Number.isSafeInteger(record.masterchainInclusionSeqno)
        || record.masterchainInclusionSeqno <= 0) {
        fail("MAINNET_CANDIDATE_RECORD_INVALID");
    }
    const exact = toRecord(record);
    if (Object.keys(record).length !== Object.keys(exact).length
        || Object.keys(exact).some(key => record[key] !== exact[key])) {
        fail("MAINNET_CANDIDATE_RECORD_INVALID");
    }
    return Object.freeze(exact);
}

function readRecord(path) {
    try {
        return validate(JSON.parse(readFileSync(path, "utf8")));
    } catch {
        fail("MAINNET_CANDIDATE_JOURNAL_CORRUPT");
    }
}

export class MainnetCandidateReviewJournal {
    constructor({ dataDir } = {}) {
        if (!nonEmpty(dataDir, 4096)) fail("MAINNET_CANDIDATE_DATA_DIR_REQUIRED");
        this._dir = join(dataDir, "mainnet-candidate-review", "records");
        this._claimsDir = join(dataDir, "mainnet-candidate-review", "references");
        this._byTransaction = new Map();
        this._byReference = new Map();
        this._initialized = false;
    }

    initialize() {
        mkdirSync(this._dir, { recursive: true });
        mkdirSync(this._claimsDir, { recursive: true });
        const rows = new Map(), refs = new Map(), claims = new Map();
        for (const name of readdirSync(this._dir)) {
            if (!name.endsWith(".json")) continue;
            const row = readRecord(join(this._dir, name));
            if (name !== fileName(row.transactionId)
                || rows.has(row.transactionId)
                || (refs.has(row.paymentReference)
                    && refs.get(row.paymentReference) !== row.transactionId)) {
                fail("MAINNET_CANDIDATE_JOURNAL_CONFLICT");
            }
            rows.set(row.transactionId, row);
            refs.set(row.paymentReference, row.transactionId);
        }

        // A reference claim is created *before* its transaction record.
        // Recover a crash between those two durable exclusive writes, but
        // never accept a transaction record lacking an immutable claim.
        for (const name of readdirSync(this._claimsDir)) {
            if (!name.endsWith(".json")) continue;
            const claim = readRecord(join(this._claimsDir, name));
            if (name !== referenceFileName(claim.paymentReference)
                || claims.has(claim.paymentReference)
                || (refs.has(claim.paymentReference)
                    && refs.get(claim.paymentReference) !== claim.transactionId)) {
                fail("MAINNET_CANDIDATE_JOURNAL_CONFLICT");
            }
            claims.set(claim.paymentReference, claim);
            const present = rows.get(claim.transactionId);
            if (present && JSON.stringify(present) !== JSON.stringify(claim)) {
                fail("MAINNET_CANDIDATE_JOURNAL_CONFLICT");
            }
            if (!present) {
                const path = join(this._dir, fileName(claim.transactionId));
                try {
                    durableWriteJson(path, claim, { exclusive: true });
                } catch (error) {
                    if (error.code !== "EEXIST") throw error;
                    if (JSON.stringify(readRecord(path)) !== JSON.stringify(claim)) {
                        fail("MAINNET_CANDIDATE_JOURNAL_CONFLICT");
                    }
                }
                rows.set(claim.transactionId, claim);
            }
            refs.set(claim.paymentReference, claim.transactionId);
        }
        for (const row of rows.values()) {
            const claim = claims.get(row.paymentReference);
            if (!claim || JSON.stringify(claim) !== JSON.stringify(row)) {
                fail("MAINNET_CANDIDATE_REFERENCE_CLAIM_MISSING_OR_CONFLICT");
            }
        }
        this._byTransaction = rows;
        this._byReference = refs;
        this._initialized = true;
    }

    /**
     * A trusted candidate report is produced only from the provenance-bound
     * Mainnet inspection. Even three recorded candidates cannot start Page5.
     * A crash midway leaves earlier candidate records intact for safe replay.
     */
    recordCandidates(report) {
        if (!this._initialized) fail("MAINNET_CANDIDATE_JOURNAL_NOT_INITIALIZED");
        if (!isMainnetCandidateReport(report)
            || !Array.isArray(report.candidates)
            || report.network !== "mainnet"
            || report.settlementAuthorized !== false
            || report.gameStartAuthorized !== false) {
            fail("MAINNET_CANDIDATE_REPORT_UNTRUSTED");
        }
        const candidates = report.candidates.map(toRecord).map(validate);
        if (candidates.some(r => r.roomId !== report.roomId)) {
            fail("MAINNET_CANDIDATE_REPORT_UNTRUSTED");
        }
        // Pre-validate all local collisions before touching disk.
        for (const record of candidates) {
            this._assertNoConflicts(record);
        }
        let added = 0;
        for (const record of candidates) {
            const path = join(this._dir, fileName(record.transactionId));
            const referencePath = join(this._claimsDir, referenceFileName(record.paymentReference));

            // Preflight the transaction record too: another initialized
            // process may already have written it since our initialize().
            // O_EXCL below remains the authority in the concurrent race.
            if (existsSync(path)) {
                this._assertNoConflicts(record, readRecord(path));
            }

            // Enforce the same reference -> transaction identity across
            // *processes*, not just the stale in-memory _byReference map.
            try {
                durableWriteJson(referencePath, record, { exclusive: true });
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
                const claimed = readRecord(referencePath);
                if (JSON.stringify(claimed) !== JSON.stringify(record)) {
                    fail("MAINNET_CANDIDATE_REFERENCE_REUSE");
                }
            }
            try {
                durableWriteJson(path, record, { exclusive: true });
                added += 1;
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
                this._assertNoConflicts(record, readRecord(path));
            }
            this._byTransaction.set(record.transactionId, record);
            this._byReference.set(record.paymentReference, record.transactionId);
        }
        return Object.freeze({
            network: "mainnet",
            candidateCount: candidates.length,
            newlyRecorded: added,
            journalOnly: true,
            settlementAuthorized: false,
            gameStartAuthorized: false
        });
    }

    _assertNoConflicts(record, diskRecord = null) {
        const former = diskRecord ?? this._byTransaction.get(record.transactionId);
        if (former && JSON.stringify(former) !== JSON.stringify(record)) {
            fail("MAINNET_CANDIDATE_TRANSACTION_REUSE");
        }
        const refTx = this._byReference.get(record.paymentReference);
        if (refTx && refTx !== record.transactionId) {
            fail("MAINNET_CANDIDATE_REFERENCE_REUSE");
        }
    }

    getByTransactionId(txId) {
        if (!this._initialized) fail("MAINNET_CANDIDATE_JOURNAL_NOT_INITIALIZED");
        return this._byTransaction.get(txId) ?? null;
    }
    listRoom(roomId) {
        if (!this._initialized) fail("MAINNET_CANDIDATE_JOURNAL_NOT_INITIALIZED");
        return Object.freeze([...this._byTransaction.values()]
            .filter(row => row.roomId === roomId));
    }
}
