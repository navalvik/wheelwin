import { randomUUID } from "node:crypto";

import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { OwnerConfiguration } from "../config/OwnerConfiguration.js";
import { SettlementSession } from "./SettlementSession.js";
import {
    SETTLEMENT_SESSION_STATUS,
    isSettlementSessionTerminal
} from "./SettlementSessionStates.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialPersistence.js";
import { maskWalletAddress } from "./maskWalletAddress.js";
import { tryNormalizeRoomNumber } from "./roomWallet/RoomWalletRegistry.js";
import {
    ROOM_WALLET_SETTLEMENT_SAFETY_CODES
} from "./roomWallet/RoomWalletSettlementAdapter.js";
import {
    reconstructHistoricalRoomWalletRequest
} from "./roomWallet/historicalRoomWalletSettlementReentry.js";
import { shouldPreserveFinancialEvidence } from "../gameplay/financialEvidenceGuards.js";

export const DEFAULT_SETTLEMENT_TIMEOUT_MS = 10 * 60 * 1000;

export const ON_CHAIN_SETTLEMENT_PROBE_STATUS = Object.freeze({
    SETTLED: "SETTLED",
    NOT_SETTLED: "NOT_SETTLED",
    UNKNOWN: "UNKNOWN"
});

function roundMoney(value) {
    return Math.round(Number(value) * 100) / 100;
}

function resolveFeeRate(configurationEngine, gameCatalog, gameId) {
    const economy = configurationEngine?.getEconomy?.(gameId) ?? null;
    const direct = Number(economy?.organizerFeeRate);
    if (Number.isFinite(direct) && direct >= 0 && direct < 1) return direct;
    const ownerPercent = Number(economy?.ownerFeePercent);
    if (Number.isFinite(ownerPercent) && ownerPercent >= 0 && ownerPercent < 100) {
        return ownerPercent / 100;
    }
    const catalogRate = Number(gameCatalog?.getPaymentRules?.()?.platformFeeRate);
    return Number.isFinite(catalogRate) && catalogRate >= 0 && catalogRate < 1
        ? catalogRate
        : 0.05;
}

export class RoomWalletSettlementManager {

    constructor({
        logger,
        eventBus,
        winnerEngine,
        configurationEngine = null,
        gameCatalog = null,
        settlementAdapter,
        financialPersistence = null,
        auditLedger = null,
        paymentSessionManager = null,
        walletManager = null,
        gameplayContextResolver = null,
        gameManager = null,
        roomManager = null,
        ownerConfiguration = OwnerConfiguration,
        tonNetwork = null,
        settlementTimeoutMs = DEFAULT_SETTLEMENT_TIMEOUT_MS,
        roomWalletRetryDelayMs = 2_000
    }) {
        if (!settlementAdapter) throw new Error("RoomWalletSettlementManager requires settlementAdapter");

        this._logger = logger;
        this._eventBus = eventBus;
        this._winnerEngine = winnerEngine;
        this._configurationEngine = configurationEngine;
        this._gameCatalog = gameCatalog;
        this._settlementAdapter = settlementAdapter;
        this._financialPersistence = financialPersistence;
        this._auditLedger = auditLedger;
        this._paymentSessionManager = paymentSessionManager;
        this._walletManager = walletManager;
        this._gameplayContextResolver = gameplayContextResolver;
        this._gameManager = gameManager;
        this._roomManager = roomManager;
        this._ownerConfiguration = ownerConfiguration;
        this._tonNetwork = tonNetwork ?? null;
        this._settlementTimeoutMs = Number.isFinite(Number(settlementTimeoutMs)) && Number(settlementTimeoutMs) > 0
            ? Number(settlementTimeoutMs) : DEFAULT_SETTLEMENT_TIMEOUT_MS;
        this._roomWalletRetryDelayMs = Number.isFinite(Number(roomWalletRetryDelayMs)) && Number(roomWalletRetryDelayMs) >= 0
            ? Number(roomWalletRetryDelayMs) : 2_000;

        this._byGameId = new Map();
        this._expiryTimers = new Map();
        this._roomWalletRetryTimers = new Map();
        this._confirmedTxHashes = new Set();
        this._inFlight = new Set();
        this._lastSettlementAt = null;
        this._handlers = [];
        this._initialized = false;
    }

    setSettlementTimeoutMs(timeoutMs) {
        const next = Number(timeoutMs);
        if (!Number.isFinite(next) || next <= 0) {
            throw new Error("RoomWalletSettlementManager.setSettlementTimeoutMs requires a positive duration");
        }
        this._settlementTimeoutMs = next;
        return this._settlementTimeoutMs;
    }

    getSettlementTimeoutMs() { return this._settlementTimeoutMs; }

    initialize() {
        this._subscribe(EVENT_TYPES.WINNER_DETERMINED, envelope => this._onWinnerDetermined(envelope.payload));
        this._subscribe(EVENT_TYPES.SETTLEMENT_TRANSACTION_CONFIRMED, envelope =>
            this._handleSettlementTransactionConfirmed(envelope.payload));
        this._subscribe(EVENT_TYPES.TRANSACTION_FAILED, envelope =>
            this._handleTransactionFailed(envelope.payload));
        this._subscribe(EVENT_TYPES.ROOM_DESTROYED, envelope =>
            this._forgetByRoom(envelope.payload?.roomId));
        this._subscribe(EVENT_TYPES.SESSION_FINISHED, envelope =>
            this._forgetByRoom(envelope.payload?.roomId));
        this._subscribe(EVENT_TYPES.SERVER_SHUTDOWN, () => this._reset());
        this._initialized = true;
    }

    shutdown() {
        for (const subscription of this._handlers) {
            this._eventBus.unsubscribe(subscription.event, subscription.handler);
        }
        this._handlers = [];
        this._reset();
        this._initialized = false;
    }

    getSettlement(gameId) {
        const session = this._byGameId.get(gameId) ?? null;
        return session ? session.toLegacyRecord() : null;
    }

    getSettlementSession(gameId) {
        return this._byGameId.get(gameId) ?? null;
    }

    listSettlementSnapshots() {
        return [...this._byGameId.keys()]
            .map(gameId => this.getReconnectSnapshot(gameId))
            .filter(Boolean);
    }

    getActiveSettlementCount() {
        return [...this._byGameId.values()].filter(session => session.isInProgress()).length;
    }

    getReconnectSnapshot(gameId) {
        const session = this._byGameId.get(gameId);
        if (!session) return null;
        return Object.freeze({
            gameId: session.gameId,
            roomId: session.roomId,
            contractId: null,
            network: session.network ?? session.request?.paymentNetwork ?? null,
            paymentNetwork: session.network ?? session.request?.paymentNetwork ?? null,
            status: session.status,
            winnerId: session.winnerId,
            winnerAmount: session.prizeAmount,
            organizerAmount: session.organizerAmount,
            settlementTxHash: session.settlementTransactionHash,
            startedAt: session.startedAt,
            completedAt: session.completedAt,
            failedAt: session.failedAt,
            reason: session.reason
        });
    }

    health() {
        let activeSettlements = 0, pendingSettlements = 0, completedSettlements = 0;
        let failedSettlements = 0, recoveredSettlements = 0;
        for (const session of this._byGameId.values()) {
            if (session.isInProgress()) activeSettlements += 1;
            if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING) pendingSettlements += 1;
            if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED) completedSettlements += 1;
            if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED ||
                session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_TIMEOUT) failedSettlements += 1;
            if (session.status === SETTLEMENT_SESSION_STATUS.RECOVERED) recoveredSettlements += 1;
        }
        return Object.freeze({
            activeSettlements, pendingSettlements, completedSettlements,
            failedSettlements, recoveredSettlements,
            lastSettlement: this._lastSettlementAt,
            network: this._tonNetwork
        });
    }

    getDashboardSnapshot(gameId = null) {
        const sessions = gameId
            ? [this._byGameId.get(gameId)].filter(Boolean)
            : [...this._byGameId.values()];
        return Object.freeze({
            gameId,
            health: this.health(),
            sessions: Object.freeze(sessions.map(session => session.toDashboardSnapshot()))
        });
    }

    restoreSettlementSessions() {
        if (!this._financialPersistence) return Object.freeze({ restored: 0, recovered: 0, rewatched: 0 });

        const records = this._financialPersistence.listActive(TON_FINANCIAL_RECORD_TYPES.SETTLEMENT);
        let restored = 0, recovered = 0, rewatched = 0;

        for (const record of records) {
            try {
                const session = SettlementSession.fromRecord(record);
                if (this._byGameId.has(session.gameId)) continue;

                if (session.isTerminal()) {
                    if (!this._reenterHistoricalRoomWalletFailure(session)) continue;
                }

                if (!session.isInProgress() && session.status !== SETTLEMENT_SESSION_STATUS.RECOVERED) {
                    session.status = SETTLEMENT_SESSION_STATUS.RECOVERED;
                }
                if (session.status === SETTLEMENT_SESSION_STATUS.RECOVERED) recovered += 1;
                this._byGameId.set(session.gameId, session);

                if (session.settlementDeadline && session.settlementDeadline > Date.now()) {
                    this._scheduleExpiry(session);
                }
                if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING ||
                    session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION) {
                    rewatched += 1;
                    this._scheduleRoomWalletRetry(session, true);
                }

                this._emitDomain(EVENT_TYPES.SETTLEMENT_RECOVERED, session);
                restored += 1;
            } catch (error) {
                this._logger?.error?.(
                    `Settlement restore skipped | id=${record?.recordId} | ${error?.message ?? error}`
                );
            }
        }
        return Object.freeze({ restored, recovered, rewatched });
    }

    _reenterHistoricalRoomWalletFailure(session) {
        const request = reconstructHistoricalRoomWalletRequest(session);
        if (!request) return false;

        session.request = request;
        session.winnerWallet = session.winnerWallet ?? request.winnerWallet;
        session.ownerWallet = session.ownerWallet ?? request.ownerWallet;
        session.prizeAmount = session.prizeAmount ?? request.winnerAmount;
        session.organizerAmount = session.organizerAmount ?? request.organizerAmount;
        session.totalPot = session.totalPot ?? request.totalPot;
        session.winnerId = session.winnerId ?? request.winnerId;
        session.recoveryMetadata = Object.freeze({
            ...(session.recoveryMetadata ?? {}),
            historicalReentry: true,
            originalStatus: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
            originalReason: session.reason
        });
        session.status = SETTLEMENT_SESSION_STATUS.READY;
        session.failedAt = null;
        session.settlementDeadline = Date.now() + this._settlementTimeoutMs;
        session.updatedAt = Date.now();
        session.version += 1;
        this._persistSession(session, "update");
        this._log(`ROOM_WALLET_HISTORICAL_REENTRY | gameId=${session.gameId} | status=${session.status}`);
        return true;
    }

    async resumeRestoredSettlements() {
        let attempted = 0, resumed = 0, skipped = 0;
        for (const session of [...this._byGameId.values()]) {
            if (!this._canResumeRestoredSettlement(session)) {
                skipped += 1;
                continue;
            }
            attempted += 1;
            if (await this._resumeRestoredSettlement(session)) resumed += 1;
            else skipped += 1;
        }
        return Object.freeze({ attempted, resumed, skipped });
    }

    _canResumeRestoredSettlement(session) {
        if (!session?.gameId || !this._byGameId.has(session.gameId) ||
            session.isTerminal?.() === true || this._inFlight.has(session.gameId)) return false;
        if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_CONFIRMED) return false;
        return session.status === SETTLEMENT_SESSION_STATUS.CREATED ||
            session.status === SETTLEMENT_SESSION_STATUS.PREPARING ||
            session.status === SETTLEMENT_SESSION_STATUS.READY ||
            session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING ||
            session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION ||
            session.status === SETTLEMENT_SESSION_STATUS.RECOVERED;
    }

    async _resumeRestoredSettlement(session) {
        if (!this._canResumeRestoredSettlement(session)) return false;
        const ctx = this._buildResumeContext(session);
        if (!ctx) {
            this._scheduleRoomWalletRetry(session);
            return false;
        }

        this._inFlight.add(session.gameId);
        try {
            const probe = await this._probeRoomWalletSettlement(session, ctx);
            if (probe.status === ON_CHAIN_SETTLEMENT_PROBE_STATUS.UNKNOWN) {
                this._scheduleRoomWalletRetry(session);
                return false;
            }
            if (probe.status === ON_CHAIN_SETTLEMENT_PROBE_STATUS.SETTLED) {
                await this._confirmSettlement(session, probe.settlementTxHash);
                return true;
            }
            await this._submitSettlementAdapter(session, ctx);
            return true;
        } catch (error) {
            this._deferRoomWalletRetry(session, error?.message ?? "settlement_resume_failed");
            return false;
        } finally {
            this._inFlight.delete(session.gameId);
        }
    }

    _buildResumeContext(session) {
        const request = session.request ?? {};
        const roomId = session.roomId ?? request.roomId ?? null;
        const paymentSession = this._paymentSessionManager?.getSession?.(roomId) ?? null;
        if (!paymentSession) {
            return request.winnerWallet && request.ownerWallet
                ? {
                    gameId: session.gameId, roomId, paymentSession: null,
                    winnerId: session.winnerId, winnerWallet: session.winnerWallet,
                    ownerWallet: session.ownerWallet, winnerAmount: session.prizeAmount,
                    organizerAmount: session.organizerAmount, totalPot: session.totalPot,
                    traceSeed: session.traceSeed
                } : null;
        }
        return this._buildSettlementContext(session.gameId, paymentSession, session.winnerId, session);
    }

    _onWinnerDetermined(payload) {
        const gameId = payload?.gameId;
        if (!gameId || !this._initialized) return;

        const existing = this._byGameId.get(gameId);
        if (existing?.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED ||
            existing?.isInProgress() || this._inFlight.has(gameId)) return;

        const winnerId = payload?.winningPlayerId ?? payload?.winnerPlayerId ??
            this._winnerEngine?.getResult?.(gameId)?.winningPlayer?.playerId ?? null;

        const ctx = this._buildWinnerContext(gameId, winnerId);
        if (!ctx.ok) {
            this._failWithoutSettlement(gameId, ctx);
            return;
        }

        let session;
        try {
            session = this._createDurableSettlementHandoff(ctx);
        } catch (error) {
            this._logger?.error?.(
                `Settlement durable handoff failed | gameId=${gameId} | ${error?.message ?? error}`
            );
            this._failWithoutSettlement(gameId, { ...ctx, reason: `handoff_persist_failed:${error?.message ?? "unknown"}` });
            return;
        }

        this._inFlight.add(gameId);
        void this._advanceSettlementAfterHandoff(session, ctx)
            .catch(error => {
                this._logger?.error?.(
                    `Room Wallet settlement pipeline failed | gameId=${gameId} | ${error?.message ?? error}`
                );
                if (session?.isInProgress?.()) this._failSettlement(session, `pipeline_failed:${error?.message ?? "unknown"}`);
            })
            .finally(() => this._inFlight.delete(gameId));
    }

    _buildWinnerContext(gameId, winnerId) {
        const roomId = this._gameplayContextResolver?.resolveRoomByGameId?.(gameId)
            ?? this._gameManager?.getGame?.(gameId)?.roomId
            ?? null;
        if (!roomId) return { ok: false, gameId, roomId: null, reason: "room_missing" };

        const paymentSession = this._paymentSessionManager?.getSession?.(roomId);
        if (!paymentSession) return { ok: false, gameId, roomId, reason: "payment_session_missing" };

        if (paymentSession.status !== "FULLY_PAID" && paymentSession.status !== "COMPLETED") {
            return { ok: false, gameId, roomId, reason: `payments_not_complete:${paymentSession.status}` };
        }

        const participant = paymentSession.findParticipant(winnerId);
        if (!participant?.wallet) return { ok: false, gameId, roomId, reason: "winner_wallet_missing" };

        let ownerWallet = null;
        try { ownerWallet = this._ownerConfiguration.getOwnerWallet(); } catch { ownerWallet = null; }
        if (!ownerWallet) return { ok: false, gameId, roomId, reason: "owner_wallet_missing" };

        const totalPot = roundMoney(paymentSession.participants.reduce(
            (sum, p) => sum + (Number(p.paidAmount) > 0 ? Number(p.paidAmount) : Number(p.requiredGram)),
            0
        ));
        if (!(totalPot > 0)) return { ok: false, gameId, roomId, reason: "payout_total_invalid" };

        const feeRate = resolveFeeRate(this._configurationEngine, this._gameCatalog, gameId);
        const organizerAmount = roundMoney(totalPot * feeRate);
        const winnerAmount = roundMoney(totalPot - organizerAmount);
        if (!Number.isFinite(winnerAmount) || !Number.isFinite(organizerAmount) ||
            winnerAmount <= 0 || organizerAmount < 0) {
            return { ok: false, gameId, roomId, reason: "payout_amounts_invalid" };
        }

        const traceSeed = this._configurationEngine?.getConfiguration?.(gameId)?.traceSeed
            ?? this._winnerEngine?.getResult?.(gameId)?.traceSeed ?? null;

        return {
            ok: true, gameId, roomId, paymentSession, winnerId,
            winnerWallet: participant.wallet, ownerWallet,
            winnerAmount, organizerAmount, totalPot, traceSeed
        };
    }

    _buildSettlementContext(gameId, paymentSession, winnerId, session = null) {
        const participant = paymentSession?.findParticipant?.(winnerId);
        const request = session?.request ?? {};
        const winnerWallet = participant?.wallet ?? session?.winnerWallet ?? request.winnerWallet ?? null;
        const ownerWallet = session?.ownerWallet ?? request.ownerWallet ?? (() => {
            try { return this._ownerConfiguration.getOwnerWallet(); } catch { return null; }
        })();
        if (!winnerWallet || !ownerWallet) return null;

        const totalPot = session?.totalPot ?? roundMoney(paymentSession.participants.reduce(
            (sum, p) => sum + (Number(p.paidAmount) > 0 ? Number(p.paidAmount) : Number(p.requiredGram)), 0
        ));
        const feeRate = resolveFeeRate(this._configurationEngine, this._gameCatalog, gameId);
        const organizerAmount = session?.organizerAmount ?? roundMoney(totalPot * feeRate);
        const winnerAmount = session?.prizeAmount ?? roundMoney(totalPot - organizerAmount);
        return {
            gameId, roomId: paymentSession.roomId, paymentSession, winnerId,
            winnerWallet, ownerWallet, winnerAmount, organizerAmount, totalPot,
            traceSeed: session?.traceSeed ?? this._configurationEngine?.getConfiguration?.(gameId)?.traceSeed ?? null
        };
    }

    _resolveRoomNumberForSettlement(ctx = {}) {
        const direct = tryNormalizeRoomNumber(ctx.roomNumber);
        if (direct != null) return direct;
        const session = ctx.roomId ? this._paymentSessionManager?.getSession?.(ctx.roomId) : null;
        const fromSession = tryNormalizeRoomNumber(session?.roomNumber);
        if (fromSession != null) return fromSession;
        const room = ctx.roomId ? this._roomManager?.getRoom?.(ctx.roomId) : null;
        const fromRoom = tryNormalizeRoomNumber(room?.roomNumber);
        if (fromRoom != null) return fromRoom;
        return null;
    }

    _createDurableSettlementHandoff(ctx) {
        if (this._byGameId.has(ctx.gameId)) {
            throw new Error(`SettlementAlreadyExists: ${ctx.gameId}`);
        }
        const startedAt = Date.now();
        const request = Object.freeze({
            gameId: ctx.gameId,
            roomId: ctx.roomId,
            roomNumber: this._resolveRoomNumberForSettlement(ctx),
            winnerId: ctx.winnerId,
            winnerWallet: ctx.winnerWallet,
            ownerWallet: ctx.ownerWallet,
            winnerAmount: ctx.winnerAmount,
            organizerAmount: ctx.organizerAmount,
            totalPot: ctx.totalPot,
            traceSeed: ctx.traceSeed,
            timestamp: startedAt,
            paymentNetwork: ctx.paymentSession?.network ?? this._tonNetwork ?? null,
            roomWalletAddress: ctx.paymentSession?.roomWalletAddress ?? null,
            snapshot: Object.freeze({
                roomId: ctx.roomId,
                roomNumber: this._resolveRoomNumberForSettlement(ctx),
                players: ctx.paymentSession?.participants?.map(p => ({
                    playerId: p.playerId, wallet: p.wallet, requiredGram: p.requiredGram
                })) ?? [],
                totalPot: ctx.totalPot,
                payoutAmount: ctx.winnerAmount,
                organizerFee: ctx.organizerAmount,
                ownerWallet: ctx.ownerWallet,
                network: ctx.paymentSession?.network ?? this._tonNetwork ?? null
            })
        });

        const session = new SettlementSession({
            settlementSessionId: `settle_${randomUUID()}`,
            contractId: null,
            gameId: ctx.gameId,
            roomId: ctx.roomId,
            winnerId: ctx.winnerId,
            winnerWallet: ctx.winnerWallet,
            prizeAmount: ctx.winnerAmount,
            organizerAmount: ctx.organizerAmount,
            totalPot: ctx.totalPot,
            network: ctx.paymentSession?.network ?? this._tonNetwork ?? null,
            status: SETTLEMENT_SESSION_STATUS.CREATED,
            ownerWallet: ctx.ownerWallet,
            traceSeed: ctx.traceSeed,
            startedAt,
            settlementDeadline: startedAt + this._settlementTimeoutMs,
            correlationId: ctx.paymentSession?.correlationId ?? randomUUID(),
            request
        });

        this._byGameId.set(ctx.gameId, session);
        this._persistSession(session, "create");
        this._emitDomain(EVENT_TYPES.SETTLEMENT_SESSION_CREATED, session);
        this._scheduleExpiry(session);
        return session;
    }

    async _advanceSettlementAfterHandoff(session, ctx) {
        session.transitionTo(SETTLEMENT_SESSION_STATUS.PREPARING);
        this._persistSession(session, "update");
        this._audit(ctx.roomId, {
            type: "ROOM_WALLET_SETTLEMENT_STARTED",
            gameId: ctx.gameId, winnerId: ctx.winnerId,
            winnerWallet: ctx.winnerWallet, ownerWalletMasked: maskWalletAddress(ctx.ownerWallet),
            totalPot: ctx.totalPot, winnerAmount: ctx.winnerAmount,
            organizerAmount: ctx.organizerAmount, at: Date.now()
        });
        this._emitDomain(EVENT_TYPES.SETTLEMENT_STARTED, session, {
            winnerAmount: ctx.winnerAmount, organizerAmount: ctx.organizerAmount
        });
        session.transitionTo(SETTLEMENT_SESSION_STATUS.READY);
        this._persistSession(session, "update");
        await this._submitSettlementAdapter(session, ctx);
    }

    async _submitSettlementAdapter(session, ctx) {
        if (session.status !== SETTLEMENT_SESSION_STATUS.READY &&
            session.status !== SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING) {
            return;
        }

        const request = Object.freeze({
            ...(session.request ?? {}),
            gameId: ctx.gameId,
            roomId: ctx.roomId,
            roomNumber: this._resolveRoomNumberForSettlement(ctx),
            winnerId: ctx.winnerId,
            winnerWallet: ctx.winnerWallet,
            ownerWallet: ctx.ownerWallet,
            winnerAmount: ctx.winnerAmount,
            organizerAmount: ctx.organizerAmount,
            totalPot: ctx.totalPot,
            paymentNetwork: session.network ?? ctx.paymentSession?.network ?? this._tonNetwork ?? null
        });
        session.request = request;

        let result;
        try {
            result = await this._settlementAdapter.settle(request);
        } catch (error) {
            this._deferRoomWalletRetry(session, `adapter_threw:${error?.message ?? "unknown"}`);
            return;
        }

        if (!result?.ok) {
            if (this._isRoomWalletSafetyFailure(result?.code, result)) {
                this._failSettlement(session, result?.reason ?? result?.code ?? "settlement_safety_failure");
                return;
            }
            this._deferRoomWalletRetry(session, result?.reason ?? result?.code ?? "settlement_adapter_failed", result);
            return;
        }

        await this._applySettlementAdapterResult(session, result);
    }

    async _applySettlementAdapterResult(session, adapterResult) {
        const txHash = adapterResult.settlementTxId
            ?? adapterResult.txHash
            ?? adapterResult.winner?.txHash
            ?? adapterResult.owner?.txHash
            ?? null;

        if (session.status === SETTLEMENT_SESSION_STATUS.READY) {
            session.transitionTo(SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING, {
                settlementTransactionHash: txHash
            });
        } else if (txHash && !session.settlementTransactionHash) {
            session.settlementTransactionHash = txHash;
            session.updatedAt = Date.now();
        }

        this._persistSession(session, "update");
        this._emitDomain(EVENT_TYPES.SETTLEMENT_PENDING, session, { transactionHash: txHash });

        const bothConfirmed = adapterResult.winnerConfirmed === true && adapterResult.ownerConfirmed === true;
        if (bothConfirmed || (adapterResult.ok === true && adapterResult.chainInspected !== true)) {
            await this._confirmSettlement(session, txHash);
            return;
        }

        this._deferRoomWalletRetry(session, adapterResult.code ?? "awaiting_chain_confirmation", adapterResult);
    }

    async _confirmSettlement(session, settlementTxHash) {
        if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED) return session;

        if (settlementTxHash) {
            const txKey = `${session.settlementSessionId}:${settlementTxHash}`;
            if (this._confirmedTxHashes.has(txKey)) return session;
            this._confirmedTxHashes.add(txKey);
        }

        if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING ||
            session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING_CONFIRMATION) {
            session.transitionTo(SETTLEMENT_SESSION_STATUS.SETTLEMENT_CONFIRMED, {
                settlementTransactionHash: settlementTxHash ?? session.settlementTransactionHash
            });
            this._persistSession(session, "update");
            this._emitDomain(EVENT_TYPES.SETTLEMENT_CONFIRMED, session, {
                transactionHash: session.settlementTransactionHash,
                roomNumber: session.request?.roomNumber ?? null
            });
        }

        if (session.status === SETTLEMENT_SESSION_STATUS.SETTLEMENT_CONFIRMED) {
            session.transitionTo(SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED, { completedAt: Date.now() });
        } else if (session.status !== SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED) {
            return session;
        }

        this._clearExpiry(session.gameId);
        this._clearRoomWalletRetry(session.gameId);
        this._lastSettlementAt = Date.now();
        this._persistSession(session, "update");

        this._audit(session.roomId, {
            type: "ROOM_WALLET_SETTLEMENT_COMPLETED",
            gameId: session.gameId, winnerId: session.winnerId,
            winnerWallet: session.winnerWallet,
            ownerWalletMasked: session.ownerWallet ? maskWalletAddress(session.ownerWallet) : null,
            totalPot: session.totalPot, winnerAmount: session.prizeAmount,
            organizerAmount: session.organizerAmount,
            settlementTxHash: session.settlementTransactionHash,
            network: session.network ?? session.request?.paymentNetwork ?? null,
            at: session.completedAt
        });

        this._emitDomain(EVENT_TYPES.SETTLEMENT_COMPLETED, session, {
            winnerAmount: session.prizeAmount,
            organizerAmount: session.organizerAmount,
            transactionHash: session.settlementTransactionHash,
            network: session.network ?? session.request?.paymentNetwork ?? null,
            paymentNetwork: session.network ?? session.request?.paymentNetwork ?? null
        });

        this._emit(EVENT_TYPES.SETTLEMENT_COMPLETED, {
            gameId: session.gameId, roomId: session.roomId,
            contractId: null, status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED,
            winnerId: session.winnerId, winnerAmount: session.prizeAmount,
            organizerAmount: session.organizerAmount,
            settlementTxHash: session.settlementTransactionHash,
            network: session.network ?? session.request?.paymentNetwork ?? null,
            paymentNetwork: session.network ?? session.request?.paymentNetwork ?? null,
            timestamp: session.completedAt
        });

        this._cleanupAfterSuccess(session.roomId, session);
        return session;
    }

    _handleSettlementTransactionConfirmed(payload) {
        const gameId = payload?.gameId;
        const session = gameId ? this._byGameId.get(gameId) : null;
        if (!session || !session.isInProgress()) return;
        const txHash = payload?.transactionId ?? payload?.txHash ?? null;
        void this._confirmSettlement(session, txHash).catch(error =>
            this._failSettlement(session, error?.message ?? "confirmation_failed"));
    }

    _handleTransactionFailed(payload) {
        if (payload?.kind && payload.kind !== "SETTLEMENT") return;
        const gameId = payload?.gameId;
        const session = gameId ? this._byGameId.get(gameId) : null;
        if (!session || !session.isInProgress()) return;
        this._deferRoomWalletRetry(session, payload?.reason ?? "transaction_failed");
    }

    _probeRoomWalletSettlement(session, ctx) {
        const request = {
            ...(session.request ?? {}),
            gameId: session.gameId,
            roomNumber: this._resolveRoomNumberForSettlement(ctx),
            winnerWallet: ctx.winnerWallet,
            ownerWallet: ctx.ownerWallet,
            winnerAmount: ctx.winnerAmount,
            organizerAmount: ctx.organizerAmount,
            timestamp: session.startedAt
        };
        if (request.roomNumber == null || typeof this._settlementAdapter.inspectSettlement !== "function") {
            return Promise.resolve(Object.freeze({
                status: ON_CHAIN_SETTLEMENT_PROBE_STATUS.NOT_SETTLED,
                settlementTxHash: null
            }));
        }
        return this._settlementAdapter.inspectSettlement(request)
            .then(inspected => {
                if (!inspected || inspected.unavailable === true) {
                    return Object.freeze({ status: ON_CHAIN_SETTLEMENT_PROBE_STATUS.NOT_SETTLED, settlementTxHash: null });
                }
                if (inspected.unknown === true) {
                    return Object.freeze({ status: ON_CHAIN_SETTLEMENT_PROBE_STATUS.UNKNOWN, settlementTxHash: null });
                }
                if (inspected.winnerPayout && inspected.ownerPayout) {
                    return Object.freeze({
                        status: ON_CHAIN_SETTLEMENT_PROBE_STATUS.SETTLED,
                        settlementTxHash: inspected.winnerPayout.hash ?? inspected.winnerPayout.txHash ?? session.settlementTransactionHash
                    });
                }
                return Object.freeze({
                    status: ON_CHAIN_SETTLEMENT_PROBE_STATUS.NOT_SETTLED,
                    settlementTxHash: inspected.winnerPayout?.hash ?? inspected.ownerPayout?.hash ?? session.settlementTransactionHash ?? null
                });
            })
            .catch(error => {
                this._logger?.warn?.(
                    `Room Wallet settlement probe failed | gameId=${session?.gameId} | ${error?.message ?? error}`
                );
                return Object.freeze({ status: ON_CHAIN_SETTLEMENT_PROBE_STATUS.UNKNOWN, settlementTxHash: null });
            });
    }

    _isRoomWalletSafetyFailure(codeOrMessage, result = null) {
        const text = String(codeOrMessage ?? result?.code ?? "");
        if (text.includes("disagree") || text.includes("AMOUNT_MISMATCH")) return true;
        return Object.values(ROOM_WALLET_SETTLEMENT_SAFETY_CODES).includes(text)
            || Object.values(ROOM_WALLET_SETTLEMENT_SAFETY_CODES).includes(result?.code);
    }

    _deferRoomWalletRetry(session, reason, adapterResult = null) {
        if (!session || session.isTerminal?.()) return;
        const winnerHash = adapterResult?.winner?.txHash ?? session.settlementTransactionHash ?? null;
        session.reason = reason ?? session.reason;
        session.updatedAt = Date.now();
        if (winnerHash && session.status === SETTLEMENT_SESSION_STATUS.READY) {
            session.transitionTo(SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING, {
                settlementTransactionHash: winnerHash, reason
            });
        } else if (winnerHash && !session.settlementTransactionHash) {
            session.settlementTransactionHash = winnerHash;
        }
        this._persistSession(session, "update");
        this._log(`ROOM_WALLET_SETTLEMENT_RETRY | gameId=${session.gameId} | status=${session.status} | reason=${reason}`);
        this._scheduleRoomWalletRetry(session);
    }

    _scheduleRoomWalletRetry(session, immediate = false) {
        const gameId = session?.gameId;
        if (!gameId) return;
        this._clearRoomWalletRetry(gameId);
        const delay = immediate ? 0 : this._roomWalletRetryDelayMs;
        const timerId = setTimeout(() => {
            this._roomWalletRetryTimers.delete(gameId);
            const current = this._byGameId.get(gameId);
            if (!current || current.isTerminal?.()) return;
            void this._resumeRestoredSettlement(current);
        }, delay);
        if (typeof timerId.unref === "function") timerId.unref();
        this._roomWalletRetryTimers.set(gameId, timerId);
    }

    _clearRoomWalletRetry(gameId) {
        const timerId = this._roomWalletRetryTimers.get(gameId);
        if (timerId) clearTimeout(timerId);
        this._roomWalletRetryTimers.delete(gameId);
    }

    _failWithoutSettlement(gameId, validation) {
        const failedAt = Date.now();
        const session = new SettlementSession({
            settlementSessionId: `settle_${randomUUID()}`,
            contractId: null, gameId, roomId: validation.roomId ?? null,
            winnerId: validation.winnerId ?? null, winnerWallet: validation.winnerWallet ?? null,
            prizeAmount: validation.winnerAmount ?? null,
            organizerAmount: validation.organizerAmount ?? null,
            totalPot: validation.totalPot ?? null,
            status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
            startedAt: failedAt, failedAt, reason: validation.reason
        });
        this._byGameId.set(gameId, session);
        this._persistSession(session, "create");
        this._audit(validation.roomId, {
            type: "ROOM_WALLET_SETTLEMENT_FAILED", gameId,
            reason: validation.reason, at: failedAt
        });
        this._emitDomain(EVENT_TYPES.SETTLEMENT_FAILED, session, { reason: validation.reason });
        this._emit(EVENT_TYPES.SETTLEMENT_FAILED, {
            gameId, roomId: validation.roomId ?? null,
            contractId: null, status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
            reason: validation.reason, timestamp: failedAt
        });
    }

    _failSettlement(session, reason) {
        if (!session || session.isTerminal()) return;
        const failedAt = Date.now();
        this._clearExpiry(session.gameId);
        this._clearRoomWalletRetry(session.gameId);
        session.transitionTo(SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED, { failedAt, reason });
        this._persistSession(session, "update");
        this._audit(session.roomId, {
            type: "ROOM_WALLET_SETTLEMENT_FAILED", gameId: session.gameId,
            winnerId: session.winnerId, winnerWallet: session.winnerWallet,
            ownerWalletMasked: session.ownerWallet ? maskWalletAddress(session.ownerWallet) : null,
            totalPot: session.totalPot, winnerAmount: session.prizeAmount,
            organizerAmount: session.organizerAmount, reason, at: failedAt
        });
        this._emitDomain(EVENT_TYPES.SETTLEMENT_FAILED, session, { reason });
        this._emit(EVENT_TYPES.SETTLEMENT_FAILED, {
            gameId: session.gameId, roomId: session.roomId,
            contractId: null, status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
            reason, timestamp: failedAt
        });
    }

    _persistSession(session, operation) {
        if (!this._financialPersistence) return;
        const payload = session.toPayload();
        const metadata = {
            gameId: session.gameId, roomId: session.roomId, contractId: null,
            tonNetwork: session.network, correlationId: session.correlationId, status: session.status
        };
        try {
            if (operation === "create") this._financialPersistence.createSettlementRecord(payload, metadata);
            else this._financialPersistence.updateSettlementRecord(session.gameId, payload, metadata);
        } catch (error) {
            if (error?.name === "RecordNotFoundError" && operation === "update") {
                this._financialPersistence.createSettlementRecord(payload, metadata);
            } else {
                throw error;
            }
        }
    }

    _scheduleExpiry(session) {
        if (!session.settlementDeadline) return;
        this._clearExpiry(session.gameId);
        const delay = Math.max(0, session.settlementDeadline - Date.now());
        const timerId = setTimeout(() => this._onExpiry(session.gameId), delay);
        if (typeof timerId.unref === "function") timerId.unref();
        this._expiryTimers.set(session.gameId, timerId);
    }

    _onExpiry(gameId) {
        this._expiryTimers.delete(gameId);
        const session = this._byGameId.get(gameId);
        if (!session || !session.isInProgress()) return;
        void this._resumeRestoredSettlement(session);
    }

    _clearExpiry(gameId) {
        const timerId = this._expiryTimers.get(gameId);
        if (timerId) clearTimeout(timerId);
        this._expiryTimers.delete(gameId);
    }

    _cleanupAfterSuccess(roomId) {
        if (roomId) this._paymentSessionManager?.destroySession?.(roomId);
    }

    _forgetByRoom(roomId) {
        if (!roomId) return;
        if (shouldPreserveFinancialEvidence({
            roomId,
            gameManager: this._gameManager,
            settlementManager: this,
            paymentSessionManager: this._paymentSessionManager
        })) return;

        for (const [gameId, session] of this._byGameId.entries()) {
            if (session.roomId !== roomId) continue;
            if (session.isInProgress?.() === true || !isSettlementSessionTerminal(session.status)) continue;
            this._clearExpiry(gameId);
            this._clearRoomWalletRetry(gameId);
            this._byGameId.delete(gameId);
        }
    }

    _emitDomain(type, session, extra = {}) {
        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_WALLET_SETTLEMENT_MANAGER ?? "RoomWalletSettlementManager",
            type,
            payload: {
                ...(session?.toSnapshot?.() ?? {}),
                ...(extra ?? {})
            }
        });
    }

    _audit(roomId, entry) {
        if (!roomId) return;
        this._auditLedger?.append?.(roomId, Object.freeze({
            category: "ROOM_WALLET_SETTLEMENT",
            ...entry
        }));
    }

    _emit(type, payload) {
        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_WALLET_SETTLEMENT_MANAGER ?? "RoomWalletSettlementManager",
            type, payload
        });
    }

    _subscribe(event, handler) {
        this._eventBus.subscribe(event, handler);
        this._handlers.push({ event, handler });
    }

    _reset() {
        for (const gameId of [...this._expiryTimers.keys()]) this._clearExpiry(gameId);
        for (const gameId of [...this._roomWalletRetryTimers.keys()]) this._clearRoomWalletRetry(gameId);
        this._byGameId.clear();
        this._confirmedTxHashes.clear();
        this._inFlight.clear();
    }

    _log(message) { this._logger?.info?.(message); }
}
