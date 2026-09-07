import { EVENT_SOURCES } from "../../events/EventSources.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import { canonicalizeTonWalletAddress } from "../../models/TonWalletAddress.js";
import { SETTLEMENT_SESSION_STATUS } from "../SettlementSessionStates.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../../persistence/TonFinancialRecordTypes.js";
import {
    buildOwnerPayout,
    GRAM_NANO
} from "./RoomWalletFinancialPolicy.js";
import { createRoomWalletRegistryFromEnv } from "./RoomWalletRuntimeResolver.js";
import { getSealedTerminalSettlementEvidence } from "./sealedTerminalSettlementEvidence.js";
import {
    confirmPayoutOnChain,
    inspectRoomWalletHistory
} from "./roomWalletTerminalRecoveryChain.js";

const FORBIDDEN_OPERATOR_KEYS = Object.freeze([
    "winnerWallet",
    "ownerWallet",
    "winnerAmount",
    "organizerAmount",
    "prizeAmount",
    "amount",
    "destination",
    "recipient"
]);

export const OPERATOR_RECOVERY_CODES = Object.freeze({
    OPERATOR_OVERRIDE_FORBIDDEN: "OPERATOR_OVERRIDE_FORBIDDEN",
    PIN_MISMATCH: "PIN_MISMATCH",
    EVIDENCE_MISSING: "EVIDENCE_MISSING",
    EVIDENCE_INCONSISTENT: "EVIDENCE_INCONSISTENT",
    NOT_TERMINAL_FAILED: "NOT_TERMINAL_FAILED",
    ROOM_OCCUPIED: "ROOM_OCCUPIED",
    WALLET_REUSED: "WALLET_REUSED",
    DUPLICATE_PAYOUT: "DUPLICATE_PAYOUT",
    INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
    ADAPTER_UNAVAILABLE: "ADAPTER_UNAVAILABLE",
    PARTIAL: "PARTIAL",
    ALREADY_CONFIRMED: "ALREADY_CONFIRMED",
    CONFIRMED: "CONFIRMED",
    ADAPTER_FAILED: "ADAPTER_FAILED"
});

export class RoomWalletTerminalSettlementRecovery {
    constructor({
        logger = null,
        eventBus = null,
        financialPersistence = null,
        sessionHistoryArchive = null,
        settlementAdapter = null,
        tonService = null,
        roomManager = null,
        gameManager = null,
        ownerConfiguration = null,
        env = process.env,
        registry = null,
        getSealedEvidence = getSealedTerminalSettlementEvidence,
        inspectHistory = inspectRoomWalletHistory,
        confirmPayout = confirmPayoutOnChain,
        confirmTimeoutMs = 90_000,
        confirmPollMs = 2_000
    } = {}) {
        this._logger = logger;
        this._eventBus = eventBus;
        this._financialPersistence = financialPersistence;
        this._sessionHistoryArchive = sessionHistoryArchive;
        this._settlementAdapter = settlementAdapter;
        this._tonService = tonService;
        this._roomManager = roomManager;
        this._gameManager = gameManager;
        this._ownerConfiguration = ownerConfiguration;
        this._env = env;
        this._registry = registry;
        this._getSealedEvidence = getSealedEvidence;
        this._inspectHistory = inspectHistory;
        this._confirmPayout = confirmPayout;
        this._confirmTimeoutMs = confirmTimeoutMs;
        this._confirmPollMs = confirmPollMs;
        this._inflight = new Set();
    }

    bindSessionHistoryArchive(archive) {
        this._sessionHistoryArchive = archive;
        return this;
    }

    resolveAdapter() {
        return this._settlementAdapter?.activeAdapter ?? this._settlementAdapter;
    }

    async recover(pins = {}) {
        for (const key of FORBIDDEN_OPERATOR_KEYS) {
            if (pins[key] != null && pins[key] !== "") {
                return this._blocked(OPERATOR_RECOVERY_CODES.OPERATOR_OVERRIDE_FORBIDDEN, {
                    detail: key
                });
            }
        }

        const gameId = String(pins.gameId ?? "").trim();
        const roomNumber = Number(pins.roomNumber);
        const roomWalletAddress = String(pins.roomWalletAddress ?? "").trim();

        if (!gameId || !Number.isInteger(roomNumber) || !roomWalletAddress) {
            return this._blocked(OPERATOR_RECOVERY_CODES.PIN_MISMATCH, {
                detail: "gameId, roomNumber, and roomWalletAddress are required"
            });
        }

        if (this._inflight.has(gameId)) {
            return this._blocked(OPERATOR_RECOVERY_CODES.PARTIAL, {
                detail: "recovery already in flight"
            });
        }
        this._inflight.add(gameId);
        try {
            return await this._recoverAuthorized({ gameId, roomNumber, roomWalletAddress });
        } finally {
            this._inflight.delete(gameId);
        }
    }

    async _recoverAuthorized({ gameId, roomNumber, roomWalletAddress }) {
        const existingRecovery = this._loadRecovery(gameId);
        if (existingRecovery?.status === "CONFIRMED") {
            return Object.freeze({
                ok: true,
                code: OPERATOR_RECOVERY_CODES.ALREADY_CONFIRMED,
                idempotent: true,
                recovery: existingRecovery.payload ?? existingRecovery
            });
        }
        if (existingRecovery?.status === "PARTIAL") {
            return this._blocked(OPERATOR_RECOVERY_CODES.PARTIAL, {
                recovery: existingRecovery.payload ?? existingRecovery,
                originalSettlementFailed: true
            });
        }

        const evidence = this._reconstructEvidence(gameId);
        if (!evidence.ok) {
            return this._blocked(evidence.code, { detail: evidence.detail });
        }

        const reconstructed = evidence.evidence;
        const registry = this._registry ?? createRoomWalletRegistryFromEnv(this._env);
        const catalogWallet = registry.get(roomNumber)?.address ?? null;
        const configuredOwner = this._ownerConfiguration?.getOwnerWallet?.()
            ?? reconstructed.ownerWallet;

        if (reconstructed.roomNumber !== roomNumber) {
            return this._blocked(OPERATOR_RECOVERY_CODES.PIN_MISMATCH, {
                detail: "roomNumber"
            });
        }

        if (!addressesEqual(roomWalletAddress, reconstructed.roomWalletAddress)
            || !addressesEqual(roomWalletAddress, catalogWallet)) {
            return this._blocked(OPERATOR_RECOVERY_CODES.PIN_MISMATCH, {
                detail: "roomWalletAddress"
            });
        }

        if (!addressesEqual(configuredOwner, reconstructed.ownerWallet)) {
            return this._blocked(OPERATOR_RECOVERY_CODES.EVIDENCE_INCONSISTENT, {
                detail: "ownerWallet"
            });
        }

        const occupied = this._roomManager?.getRoomByNumber?.(roomNumber) ?? null;
        if (occupied) {
            return this._blocked(OPERATOR_RECOVERY_CODES.ROOM_OCCUPIED, {
                roomId: occupied.roomId ?? occupied.id ?? null
            });
        }

        const ownerPlan = buildOwnerPayout({
            ownerGrossNano: gramToNano(reconstructed.organizerAmount)
        });
        const winnerAmountNano = gramToNano(reconstructed.winnerAmount);
        const request = Object.freeze({
            gameId: reconstructed.gameId,
            roomId: reconstructed.roomId,
            roomNumber: reconstructed.roomNumber,
            winnerWallet: reconstructed.winnerWallet,
            ownerWallet: reconstructed.ownerWallet,
            winnerAmount: reconstructed.winnerAmount,
            organizerAmount: reconstructed.organizerAmount
        });

        const history = await this._inspectHistory({
            tonService: this._tonService,
            roomWalletAddress,
            cutoffLt: reconstructed.lastInboundLt,
            cutoffUtime: reconstructed.lastInboundUtime,
            winnerWallet: reconstructed.winnerWallet,
            ownerWallet: reconstructed.ownerWallet,
            winnerAmountNano,
            ownerAmountNano: ownerPlan.ownerPayoutNano
        });

        if (history.reused) {
            return this._blocked(OPERATOR_RECOVERY_CODES.WALLET_REUSED, {
                laterCount: history.laterCount
            });
        }

        if (history.winnerPayoutCount > 1 || history.ownerPayoutCount > 1) {
            return this._blocked(OPERATOR_RECOVERY_CODES.DUPLICATE_PAYOUT, {
                winnerPayoutCount: history.winnerPayoutCount,
                ownerPayoutCount: history.ownerPayoutCount
            });
        }

        if (history.winnerPayout && history.ownerPayout) {
            return this._confirmAdopted({
                reconstructed,
                request,
                ownerPlan,
                winnerTxHash: history.winnerPayout.hash,
                ownerTxHash: history.ownerPayout.hash,
                originalSettlementFailed: true
            });
        }

        if (history.winnerPayout && !history.ownerPayout) {
            this._persistRecovery(gameId, "PARTIAL", {
                reconstructed,
                request,
                ownerPlan,
                winnerTxHash: history.winnerPayout.hash,
                ownerTxHash: null,
                originalStatus: "SETTLEMENT_FAILED",
                originalFailureReason: reconstructed.originalFailureReason,
                recoveryStatus: "PARTIAL"
            });
            return this._blocked(OPERATOR_RECOVERY_CODES.PARTIAL, {
                winnerTxHash: history.winnerPayout.hash
            });
        }

        if (!history.winnerPayout && history.ownerPayout) {
            this._persistRecovery(gameId, "PARTIAL", {
                reconstructed,
                request,
                ownerPlan,
                winnerTxHash: null,
                ownerTxHash: history.ownerPayout.hash,
                originalStatus: "SETTLEMENT_FAILED",
                originalFailureReason: reconstructed.originalFailureReason,
                recoveryStatus: "PARTIAL"
            });
            return this._blocked(OPERATOR_RECOVERY_CODES.PARTIAL, {
                ownerTxHash: history.ownerPayout.hash
            });
        }

        const adapter = this.resolveAdapter();
        if (!adapter || typeof adapter.settleContract !== "function") {
            return this._blocked(OPERATOR_RECOVERY_CODES.ADAPTER_UNAVAILABLE);
        }

        if (typeof adapter.preflight === "function") {
            const preflight = await adapter.preflight(request);
            if (!preflight?.ok) {
                return this._blocked(OPERATOR_RECOVERY_CODES.INSUFFICIENT_BALANCE, {
                    preflight
                });
            }
        }

        this._persistRecovery(gameId, "BROADCAST", {
            reconstructed,
            request,
            ownerPlan: serializeOwnerPlan(ownerPlan),
            originalStatus: "SETTLEMENT_FAILED",
            originalFailureReason: reconstructed.originalFailureReason,
            recoveryStatus: "BROADCAST",
            authorizedAt: Date.now()
        });

        let adapterResult;
        try {
            adapterResult = await adapter.settleContract(request);
        } catch (error) {
            this._persistRecovery(gameId, "BLOCKED", {
                reconstructed,
                request,
                ownerPlan,
                originalStatus: "SETTLEMENT_FAILED",
                originalFailureReason: reconstructed.originalFailureReason,
                recoveryStatus: "BLOCKED",
                error: error?.message ?? String(error)
            });
            return this._blocked(OPERATOR_RECOVERY_CODES.ADAPTER_FAILED, {
                detail: error?.message ?? String(error)
            });
        }

        const winnerTxHash = adapterResult?.winner?.txHash
            ?? adapterResult?.txHash
            ?? null;
        const ownerTxHash = adapterResult?.owner?.txHash ?? null;

        if (adapterResult?.partial || (adapterResult?.ok !== true && winnerTxHash && !ownerTxHash)) {
            this._persistRecovery(gameId, "PARTIAL", {
                reconstructed,
                request,
                ownerPlan,
                winnerTxHash,
                ownerTxHash,
                originalStatus: "SETTLEMENT_FAILED",
                originalFailureReason: reconstructed.originalFailureReason,
                recoveryStatus: "PARTIAL",
                adapterCode: adapterResult?.code ?? null
            });
            return this._blocked(OPERATOR_RECOVERY_CODES.PARTIAL, {
                winnerTxHash,
                ownerTxHash,
                adapterCode: adapterResult?.code ?? null
            });
        }

        if (adapterResult?.ok !== true) {
            this._persistRecovery(gameId, "BLOCKED", {
                reconstructed,
                request,
                ownerPlan,
                originalStatus: "SETTLEMENT_FAILED",
                originalFailureReason: reconstructed.originalFailureReason,
                recoveryStatus: "BLOCKED",
                adapterCode: adapterResult?.code ?? null
            });
            return this._blocked(adapterResult?.code === "INSUFFICIENT_ROOM_WALLET_BALANCE"
                ? OPERATOR_RECOVERY_CODES.INSUFFICIENT_BALANCE
                : OPERATOR_RECOVERY_CODES.ADAPTER_FAILED, {
                adapterCode: adapterResult?.code ?? null
            });
        }

        const winnerConfirm = await this._confirmPayout({
            tonService: this._tonService,
            roomWalletAddress,
            expectedHash: winnerTxHash,
            destination: reconstructed.winnerWallet,
            amountNano: winnerAmountNano,
            timeoutMs: this._confirmTimeoutMs,
            pollIntervalMs: this._confirmPollMs
        });
        const ownerConfirm = await this._confirmPayout({
            tonService: this._tonService,
            roomWalletAddress,
            expectedHash: ownerTxHash,
            destination: reconstructed.ownerWallet,
            amountNano: ownerPlan.ownerPayoutNano,
            timeoutMs: this._confirmTimeoutMs,
            pollIntervalMs: this._confirmPollMs
        });

        if (!winnerConfirm?.ok || !ownerConfirm?.ok) {
            this._persistRecovery(gameId, "PARTIAL", {
                reconstructed,
                request,
                ownerPlan,
                winnerTxHash,
                ownerTxHash,
                winnerConfirmed: winnerConfirm?.ok === true,
                ownerConfirmed: ownerConfirm?.ok === true,
                originalStatus: "SETTLEMENT_FAILED",
                originalFailureReason: reconstructed.originalFailureReason,
                recoveryStatus: "PARTIAL"
            });
            return this._blocked(OPERATOR_RECOVERY_CODES.PARTIAL, {
                winnerConfirmed: winnerConfirm?.ok === true,
                ownerConfirmed: ownerConfirm?.ok === true,
                winnerTxHash,
                ownerTxHash
            });
        }

        return this._confirmAdopted({
            reconstructed,
            request,
            ownerPlan,
            winnerTxHash: winnerConfirm.hash ?? winnerTxHash,
            ownerTxHash: ownerConfirm.hash ?? ownerTxHash,
            originalSettlementFailed: true
        });
    }

    _reconstructEvidence(gameId) {
        const persisted = this._loadPersistedSettlement(gameId);
        const history = this._loadHistory(gameId);
        const sealed = this._getSealedEvidence(gameId);

        if (persisted && persisted.status !== SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED) {
            return {
                ok: false,
                code: OPERATOR_RECOVERY_CODES.NOT_TERMINAL_FAILED,
                detail: persisted.status
            };
        }

        const fromPersist = persisted ? evidenceFromSettlementRecord(persisted, sealed) : null;
        const fromHistory = history ? evidenceFromHistory(history, sealed) : null;
        const candidate = fromPersist ?? fromHistory ?? (sealed
            ? {
                ...sealed,
                winnerAmount: sealed.winnerAmount,
                organizerAmount: sealed.organizerAmount
            }
            : null);

        if (!candidate) {
            return {
                ok: false,
                code: OPERATOR_RECOVERY_CODES.EVIDENCE_MISSING
            };
        }

        if (sealed) {
            if (candidate.winnerAmount !== sealed.winnerAmount
                || candidate.organizerAmount !== sealed.organizerAmount
                || candidate.roomNumber !== sealed.roomNumber
                || !addressesEqual(candidate.winnerWallet, sealed.winnerWallet)
                || !addressesEqual(candidate.ownerWallet, sealed.ownerWallet)
                || !addressesEqual(candidate.roomWalletAddress, sealed.roomWalletAddress)) {
                return {
                    ok: false,
                    code: OPERATOR_RECOVERY_CODES.EVIDENCE_INCONSISTENT
                };
            }
        }

        if (candidate.winnerAmount == null || candidate.organizerAmount == null
            || !candidate.winnerWallet || !candidate.ownerWallet
            || candidate.roomNumber == null || !candidate.roomWalletAddress) {
            return {
                ok: false,
                code: OPERATOR_RECOVERY_CODES.EVIDENCE_MISSING
            };
        }

        return { ok: true, evidence: Object.freeze({ ...candidate, gameId }) };
    }

    _loadPersistedSettlement(gameId) {
        if (!this._financialPersistence?.loadSettlementRecord) {
            return null;
        }
        try {
            return this._financialPersistence.loadSettlementRecord(gameId);
        } catch {
            const records = this._financialPersistence.findByGame?.(gameId) ?? [];
            return records.find((record) => record.recordType === TON_FINANCIAL_RECORD_TYPES.SETTLEMENT)
                ?? null;
        }
    }

    _loadHistory(gameId) {
        const listed = this._sessionHistoryArchive?.listRecords?.({
            gameId,
            limit: 20,
            sort: "newest"
        });
        const records = listed?.records ?? listed ?? [];
        if (!Array.isArray(records)) {
            return null;
        }
        return records.find((record) => String(record.gameId) === String(gameId)) ?? null;
    }

    _loadRecovery(gameId) {
        if (!this._financialPersistence?.loadSettlementOperatorRecoveryRecord) {
            return null;
        }
        try {
            return this._financialPersistence.loadSettlementOperatorRecoveryRecord(gameId);
        } catch {
            return null;
        }
    }

    _persistRecovery(gameId, status, payload) {
        if (!this._financialPersistence?.createSettlementOperatorRecoveryRecord) {
            return;
        }
        const body = {
            gameId,
            ...payload,
            ownerPlan: payload.ownerPlan && typeof payload.ownerPlan === "object"
                ? serializeOwnerPlan(payload.ownerPlan)
                : payload.ownerPlan,
            status
        };
        const metadata = {
            gameId,
            roomId: payload?.reconstructed?.roomId ?? payload?.request?.roomId ?? null,
            status
        };
        const existing = this._loadRecovery(gameId);
        if (existing) {
            this._financialPersistence.updateSettlementOperatorRecoveryRecord(
                gameId,
                body,
                metadata
            );
            return;
        }
        this._financialPersistence.createSettlementOperatorRecoveryRecord(body, metadata);
    }

    async _confirmAdopted({
        reconstructed,
        request,
        ownerPlan,
        winnerTxHash,
        ownerTxHash
    }) {
        const confirmedAt = Date.now();
        this._persistRecovery(reconstructed.gameId, "CONFIRMED", {
            reconstructed,
            request,
            ownerPlan: {
                ownerGrossNano: String(ownerPlan.ownerGrossNano),
                ownerPayoutNano: String(ownerPlan.ownerPayoutNano),
                retainedNano: String(ownerPlan.retainedNano)
            },
            winnerTxHash,
            ownerTxHash,
            originalStatus: "SETTLEMENT_FAILED",
            originalFailureReason: reconstructed.originalFailureReason,
            recoveryStatus: "OPERATOR_RECOVERY_SUCCESSFUL",
            confirmedAt
        });

        this._eventBus?.emit?.({
            source: EVENT_SOURCES.ROOM_WALLET_TERMINAL_SETTLEMENT_RECOVERY,
            type: EVENT_TYPES.SETTLEMENT_CONFIRMED,
            payload: {
                gameId: reconstructed.gameId,
                roomId: reconstructed.roomId,
                roomNumber: reconstructed.roomNumber,
                winnerTxHash,
                ownerTxHash,
                transactionHash: winnerTxHash,
                operatorRecovery: true
            }
        });

        this._logger?.info?.(
            `OPERATOR_RECOVERY_SUCCESSFUL | gameId=${reconstructed.gameId} | `
                + `winnerTx=${winnerTxHash} | ownerTx=${ownerTxHash}`
        );

        return Object.freeze({
            ok: true,
            code: OPERATOR_RECOVERY_CODES.CONFIRMED,
            originalSettlementFailed: true,
            recoveryStatus: "OPERATOR_RECOVERY_SUCCESSFUL",
            request,
            winnerAmount: reconstructed.winnerAmount,
            organizerAmount: reconstructed.organizerAmount,
            ownerPayoutNano: ownerPlan.ownerPayoutNano,
            retainedNano: ownerPlan.retainedNano,
            winnerTxHash,
            ownerTxHash,
            confirmedAt
        });
    }

    _blocked(code, extra = {}) {
        return Object.freeze({
            ok: false,
            code,
            originalSettlementFailed: true,
            ...extra
        });
    }
}

function serializeOwnerPlan(ownerPlan) {
    if (!ownerPlan || typeof ownerPlan !== "object") {
        return ownerPlan ?? null;
    }

    return {
        ownerGrossNano: String(ownerPlan.ownerGrossNano ?? ""),
        ownerPayoutNano: String(ownerPlan.ownerPayoutNano ?? ""),
        retainedNano: String(ownerPlan.retainedNano ?? "")
    };
}

function gramToNano(grams) {
    return BigInt(Math.round(Number(grams) * Number(GRAM_NANO)));
}

function addressesEqual(left, right) {
    const a = canonicalizeTonWalletAddress(left);
    const b = canonicalizeTonWalletAddress(right);
    return Boolean(a && b && a === b);
}

function evidenceFromSettlementRecord(record, sealed) {
    const payload = record.payload ?? record;
    const request = payload.request ?? {};
    return {
        gameId: payload.gameId,
        roomId: payload.roomId ?? request.roomId,
        roomNumber: request.roomNumber ?? sealed?.roomNumber,
        roomWalletAddress: sealed?.roomWalletAddress,
        winnerId: payload.winnerId ?? request.winnerId,
        winnerWallet: payload.winnerWallet ?? request.winnerWallet,
        ownerWallet: payload.ownerWallet ?? request.ownerWallet,
        winnerAmount: payload.winnerAmount ?? payload.prizeAmount ?? request.winnerAmount,
        organizerAmount: payload.organizerAmount ?? request.organizerAmount,
        originalStatus: payload.status ?? record.status,
        originalFailureReason: payload.reason ?? record.reason ?? sealed?.originalFailureReason,
        lastInboundLt: sealed?.lastInboundLt,
        lastInboundUtime: sealed?.lastInboundUtime,
        source: "persistence"
    };
}

function evidenceFromHistory(record, sealed) {
    const settlement = record.blockchain?.settlement
        ?? record.settlement
        ?? {};
    return {
        gameId: record.gameId,
        roomId: record.roomId,
        roomNumber: sealed?.roomNumber,
        roomWalletAddress: sealed?.roomWalletAddress,
        winnerId: settlement.winnerId ?? null,
        winnerWallet: settlement.winnerWallet,
        ownerWallet: settlement.commissionWallet ?? sealed?.ownerWallet,
        winnerAmount: settlement.winnerAmount,
        organizerAmount: settlement.commissionAmount ?? settlement.organizerAmount,
        originalStatus: settlement.status ?? sealed?.originalStatus,
        originalFailureReason: settlement.error ?? sealed?.originalFailureReason,
        lastInboundLt: sealed?.lastInboundLt,
        lastInboundUtime: sealed?.lastInboundUtime,
        source: "session_history"
    };
}
