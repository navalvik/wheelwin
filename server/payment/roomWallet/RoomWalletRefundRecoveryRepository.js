/**
 * Durable, read-only ledger of unpaid pre-Page5 Room Wallet refunds.
 *
 * An expired Room Wallet must not become allocatable merely because RoomManager
 * destroyed the room or PaymentSessionManager recorded receivedPayments=[].
 * This repository persists a quarantine marker FIRST, followed by immutable
 * identities of the blockchain-backed refund obligations. It NEVER signs,
 * broadcasts, marks transfers confirmed, or automatically clears quarantine.
 *
 * TonFinancialPersistence is a single-writer filesystem, not a distributed
 * lock. Multi-process senders require an independent transactional lock.
 */
import { createHash } from "node:crypto";
import { Address } from "@ton/core";
import { normalizeRoomNumber } from "./RoomWalletRegistry.js";

const KIND_QUARANTINE = "ROOM_WALLET_REFUND_QUARANTINE";
const KIND_SETTLEMENT_QUARANTINE = "ROOM_WALLET_SETTLEMENT_QUARANTINE";
const KIND_OBLIGATION = "ROOM_WALLET_REFUND_OBLIGATION";
const PREFIX = "rwrefund_guard_";

export class RoomWalletRefundStoreError extends Error {
    constructor(code, detail = "") {
        super(detail ? code + ": " + detail : code);
        this.name = "RoomWalletRefundStoreError";
        this.code = code;
    }
}

function assert(condition, code) {
    if (!condition) throw new RoomWalletRefundStoreError(code);
}

function key(parts) {
    return PREFIX + createHash("sha256").update(parts.join("|")).digest("hex");
}

function rawAddress(value) {
    try {
        return typeof value === "string" ? Address.parse(value).toRawString().toLowerCase() : null;
    } catch {
        return null;
    }
}

function stableIdentity(obligation) {
    const roomWallet = rawAddress(obligation.fromRoomWallet);
    const playerWallet = rawAddress(obligation.recipientWallet);
    const hash = String(obligation.inboundTxHash ?? "").toLowerCase();
    const lt = String(obligation.inboundLt ?? "");
    const value = String(obligation.grossRefundNano ?? "");
    assert(
        obligation.kind === KIND_OBLIGATION
        && obligation.state === "REFUND_RECONCILIATION_REQUIRED"
        && typeof obligation.obligationId === "string"
        && /^rwrefund_[0-9a-f]{64}$/.test(obligation.obligationId)
        && /^[0-9a-f]{64}$/.test(hash)
        && /^\d+$/.test(lt)
        && /^\d+$/.test(value)
        && BigInt(value) > 0n
        && Number.isInteger(obligation.roomNumber)
        && roomWallet && playerWallet
        && obligation.network === "testnet"
        && typeof obligation.roomId === "string" && obligation.roomId.length > 0
        && typeof obligation.paymentSessionId === "string" && obligation.paymentSessionId.length > 0
        && typeof obligation.gameId === "string" && obligation.gameId.length > 0
        && typeof obligation.playerId === "string" && obligation.playerId.length > 0,
        "INVALID_REFUND_OBLIGATION"
    );
    return {
        network: obligation.network,
        roomId: obligation.roomId,
        roomNumber: normalizeRoomNumber(obligation.roomNumber),
        gameId: obligation.gameId,
        paymentSessionId: obligation.paymentSessionId,
        playerId: obligation.playerId,
        fromRoomWallet: roomWallet,
        recipientWallet: playerWallet,
        inboundTxHash: hash,
        inboundLt: lt,
        grossRefundNano: value,
        inboundUtime: Number(obligation.inboundUtime),
        obligationId: obligation.obligationId
    };
}

function sameIdentity(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

export class RoomWalletRefundRecoveryRepository {
    constructor({ financialPersistence } = {}) {
        if (!financialPersistence
            || typeof financialPersistence.createRecoveryDataRecord !== "function"
            || typeof financialPersistence.loadRecoveryDataRecord !== "function"
            || typeof financialPersistence.listActiveRecoveryDataRecords !== "function") {
            throw new TypeError("RoomWalletRefundRecoveryRepository requires TonFinancialPersistence");
        }
        this._persistence = financialPersistence;
        // One O(1) safety lookup per room-number allocation; no full-disk
        // scan for each of the 50 simultaneous rooms.
        this._quarantinedRoomNumbers = new Set();
        for (const record of this.listAllocationBlocks()) {
            this._quarantinedRoomNumbers.add(normalizeRoomNumber(record.payload.roomNumber));
        }
    }

    /**
     * Must run BEFORE releasing/reusing a room wallet on failed game expiry.
     * If persisted, a process restart alone cannot clear the quarantine.
     */
    beginQuarantine({
        network = "testnet", roomId, roomNumber, gameId, paymentSessionId,
        roomWallet, reason = "SETUP_EXPIRED"
    } = {}) {
        assert(network === "testnet", "WRONG_NETWORK");
        const number = normalizeRoomNumber(roomNumber);
        const address = rawAddress(roomWallet);
        assert(
            typeof roomId === "string" && roomId.length > 0
            && typeof gameId === "string" && gameId.length > 0
            && typeof paymentSessionId === "string" && paymentSessionId.length > 0
            && address !== null && reason === "SETUP_EXPIRED",
            "INVALID_QUARANTINE_IDENTITY"
        );
        const recordId = key([network, String(number), roomId, paymentSessionId]);
        const payload = {
            recoveryRecordId: recordId,
            kind: KIND_QUARANTINE,
            status: "ACTIVE",
            network, roomId, roomNumber: number, gameId, paymentSessionId,
            roomWallet: address,
            reason,
            state: "RECONCILIATION_REQUIRED",
            reconciliationComplete: false
        };
        let existing = this._getById(recordId);
        if (existing) {
            assert(existing.payload.kind === KIND_QUARANTINE, "RECORD_ID_CONFLICT");
            for (const field of [
                "network", "roomId", "roomNumber", "gameId", "paymentSessionId", "roomWallet", "reason"
            ]) {
                assert(existing.payload[field] === payload[field], "QUARANTINE_IDENTITY_CONFLICT");
            }
            // Repeated lifecycle callbacks after a proven closure must not
            // re-block this number. The durable record remains authoritative.
            if (existing.status === "ACTIVE") {
                this._quarantinedRoomNumbers.add(number);
            }
            return Object.freeze({ created: false, recordId, record: existing });
        }
        existing = this._persistence.createRecoveryDataRecord(payload, {
            recoveryRecordId: recordId,
            status: "ACTIVE",
            roomId,
            gameId,
            tonNetwork: network
        });
        this._quarantinedRoomNumbers.add(number);
        return Object.freeze({ created: true, recordId, record: existing });
    }

    /**
     * Page5 already started: do not treat it as a refund case. Instead
     * quarantine the wallet for winner and owner settlement reconciliation.
     * This marker is created even if settlement payouts have not been planned
     * yet, because the server must not give its wallet to another room.
     */
    beginSettlementQuarantine({
        network = "testnet", roomId, roomNumber, gameId, roomWallet
    } = {}) {
        assert(network === "testnet", "WRONG_NETWORK");
        const number = normalizeRoomNumber(roomNumber);
        const address = rawAddress(roomWallet);
        assert(address && typeof roomId === "string" && roomId.length > 0
            && typeof gameId === "string" && gameId.length > 0,
            "INVALID_SETTLEMENT_QUARANTINE_IDENTITY");
        const recordId = key([network, String(number), roomId, gameId, "POST_PAGE5"]);
        const payload = {
            recoveryRecordId: recordId,
            kind: KIND_SETTLEMENT_QUARANTINE,
            status: "ACTIVE",
            network, roomId, roomNumber: number, gameId,
            roomWallet: address,
            state: "SETTLEMENT_CHAIN_RECONCILIATION_REQUIRED",
            reconciliationComplete: false
        };
        const existing = this._getById(recordId);
        if (existing) {
            assert(existing.payload.kind === KIND_SETTLEMENT_QUARANTINE,
                "RECORD_ID_CONFLICT");
            for (const field of [
                "network", "roomId", "roomNumber", "gameId", "roomWallet"
            ]) assert(existing.payload[field] === payload[field],
                "SETTLEMENT_QUARANTINE_IDENTITY_CONFLICT");
            // Repeated lifecycle callbacks after a proven closure must not
            // re-block this number. The durable record remains authoritative.
            if (existing.status === "ACTIVE") {
                this._quarantinedRoomNumbers.add(number);
            }
            return Object.freeze({ created: false, recordId, record: existing });
        }
        const stored = this._persistence.createRecoveryDataRecord(payload, {
            recoveryRecordId: recordId,
            status: "ACTIVE", roomId, gameId, tonNetwork: network
        });
        this._quarantinedRoomNumbers.add(number);
        return Object.freeze({ created: true, recordId, record: stored });
    }

    /**
     * Plan comes from the dual-provider evidence planner.
     * Guard is written first; a partial batch remains blocked after crash.
     * This method never authorizes transfer or clears a quarantine.
     */
    persistReconciliation({ plan, session, gameReachedPage5 } = {}) {
        assert(gameReachedPage5 === false, "PAGE5_OWNERSHIP_NOT_EXCLUDED");
        assert(plan && plan.quarantineRequired === true
            && Array.isArray(plan.obligations)
            && typeof plan.roomId === "string"
            && session && plan.roomId === session.roomId
            && plan.paymentSessionId === session.paymentSessionId,
            "UNSAFE_RECONCILIATION_PLAN");
        const number = normalizeRoomNumber(session.roomNumber);
        const wallet = rawAddress(session.roomWalletAddress);
        assert(wallet && wallet === rawAddress(plan.roomWallet), "ROOM_WALLET_MISMATCH");

        const normalized = plan.obligations.map(item => {
            const identity = stableIdentity(item);
            assert(
                identity.roomNumber === number
                && identity.roomId === session.roomId
                && identity.paymentSessionId === session.paymentSessionId
                && identity.gameId === session.gameId
                && identity.fromRoomWallet === wallet,
                "OBLIGATION_ROOM_MISMATCH"
            );
            return { obligation: item, identity };
        });
        assert(
            normalized.length === new Set(normalized.map(x => x.identity.obligationId)).size,
            "DUPLICATE_OBLIGATION"
        );

        const quarantine = this.beginQuarantine({
            roomId: session.roomId,
            roomNumber: number,
            roomWallet: wallet,
            gameId: session.gameId,
            paymentSessionId: session.paymentSessionId
        });
        let created = 0;
        for (const { obligation, identity } of normalized) {
            const id = identity.obligationId;
            const existing = this._getById(id);
            if (existing) {
                assert(existing.payload.kind === KIND_OBLIGATION, "RECORD_ID_CONFLICT");
                assert(sameIdentity(stableIdentity(existing.payload), identity), "OBLIGATION_EVIDENCE_CONFLICT");
                continue;
            }
            this._persistence.createRecoveryDataRecord({
                ...obligation,
                recoveryRecordId: id,
                status: "ACTIVE"
            }, {
                recoveryRecordId: id,
                status: "ACTIVE",
                roomId: session.roomId,
                gameId: session.gameId,
                tonNetwork: "testnet"
            });
            created++;
        }
        return Object.freeze({
            quarantineRecordId: quarantine.recordId,
            quarantineCreated: quarantine.created,
            obligationsCreated: created,
            obligationsKnown: normalized.length,
            walletQuarantined: this.isRoomNumberQuarantined(number)
        });
    }

    /**
     * Persist closure ONLY after RoomWalletQuarantineReleaseGuard has
     * independently verified fresh double-source history and all immutable
     * liabilities. Never call from room destruction, timeout or API response.
     * A failed write leaves the in-memory allocation block intact.
     */
    closeWithChainEvidence({ recordId, evidence } = {}) {
        assert(typeof recordId === "string" && recordId.length > 0
            && evidence?.kind === "DOUBLE_SOURCE_ROOM_WALLET_CLOSURE_V1"
            && evidence?.complete === true
            && typeof evidence?.historyHash === "string"
            && /^[0-9a-f]{64}$/.test(evidence.historyHash)
            && typeof evidence?.headHash === "string"
            && /^[0-9a-f]{64}$/.test(evidence.headHash)
            && typeof evidence?.headLt === "string"
            && /^\d+$/.test(evidence.headLt)
            && Number.isSafeInteger(evidence.verifiedAtMs)
            && Array.isArray(evidence.settledIntents)
            && evidence.settledIntents.every(x => /^rwout_[0-9a-f]{64}$/.test(x)),
            "QUARANTINE_CLOSURE_PROOF_REQUIRED");
        const existing = this._getById(recordId);
        assert(existing && [KIND_QUARANTINE, KIND_SETTLEMENT_QUARANTINE]
            .includes(existing.payload?.kind),
            "QUARANTINE_CLOSURE_RECORD_INVALID");
        const p = existing.payload;
        const number = normalizeRoomNumber(p.roomNumber);
        assert(evidence.network === "testnet"
            && evidence.roomNumber === number
            && evidence.roomId === p.roomId
            && evidence.gameId === p.gameId
            && rawAddress(evidence.roomWallet) === rawAddress(p.roomWallet),
            "QUARANTINE_CLOSURE_IDENTITY_MISMATCH");

        if (existing.status === "SETTLED"
            && p.state === "CHAIN_RECONCILED_CLOSED") {
            return Object.freeze({ changed: false, recordId, roomNumber: number });
        }
        assert(existing.status === "ACTIVE"
            && ["RECONCILIATION_REQUIRED", "SETTLEMENT_CHAIN_RECONCILIATION_REQUIRED"]
                .includes(p.state),
            "QUARANTINE_CLOSURE_STATE_INVALID");

        this._persistence.updateRecoveryDataRecord(recordId, {
            ...p,
            status: "SETTLED",
            state: "CHAIN_RECONCILED_CLOSED",
            reconciliationComplete: true,
            chainClosure: Object.freeze({
                headHash: evidence.headHash,
                headLt: evidence.headLt,
                historyHash: evidence.historyHash,
                verifiedAtMs: evidence.verifiedAtMs,
                settledIntents: Object.freeze([...evidence.settledIntents])
            })
        }, { status: "SETTLED" });

        // Distinct quarantine markers may share one wallet number. Never
        // unblock a number while ANY other durable marker still holds it.
        const otherHolds = this.listAllocationBlocks()
            .some(x => normalizeRoomNumber(x.payload.roomNumber) === number);
        if (!otherHolds) this._quarantinedRoomNumbers.delete(number);
        return Object.freeze({
            changed: true, recordId, roomNumber: number,
            unblocked: !otherHolds
        });
    }

    listOpenQuarantines() {
        return Object.freeze(
            this._persistence.listActiveRecoveryDataRecords()
                .filter(x => x.payload?.kind === KIND_QUARANTINE && x.status === "ACTIVE"
                    && x.payload?.state === "RECONCILIATION_REQUIRED")
        );
    }

    listOpenSettlementQuarantines() {
        return Object.freeze(
            this._persistence.listActiveRecoveryDataRecords()
                .filter(x => x.payload?.kind === KIND_SETTLEMENT_QUARANTINE
                    && x.status === "ACTIVE"
                    && x.payload?.state === "SETTLEMENT_CHAIN_RECONCILIATION_REQUIRED")
        );
    }

    listAllocationBlocks() {
        return Object.freeze([
            ...this.listOpenQuarantines(),
            ...this.listOpenSettlementQuarantines()
        ]);
    }

    isRoomNumberQuarantined(roomNumber) {
        const number = normalizeRoomNumber(roomNumber);
        return this._quarantinedRoomNumbers.has(number);
    }

    listRefundObligations({ roomId = null } = {}) {
        return Object.freeze(
            this._persistence.listActiveRecoveryDataRecords()
                .filter(x => x.payload?.kind === KIND_OBLIGATION
                    && (roomId == null || x.payload.roomId === roomId))
        );
    }

    _getById(recordId) {
        try {
            return this._persistence.loadRecoveryDataRecord(recordId);
        } catch (error) {
            if (error?.name === "RecordNotFoundError") return null;
            throw error;
        }
    }
}
