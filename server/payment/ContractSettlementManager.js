import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import { OwnerConfiguration } from "../config/OwnerConfiguration.js";
import { maskWalletAddress } from "../payment/maskWalletAddress.js";

/**
 * P6.8B — Authoritative post-winner Game Contract settlement.
 *
 * WINNER_DETERMINED → validate snapshot → settleContract(adapter) →
 * SETTLEMENT_COMPLETED → (GameplayPhaseLifecycle may OPEN_PAGE6).
 *
 * Server never transfers funds; the blockchain adapter submits settlement.
 * No WinnerEngine / physics / gameplay logic.
 */
export class ContractSettlementManager {

    constructor({
        logger,
        eventBus,
        gameContractManager,
        winnerEngine,
        configurationEngine = null,
        settlementAdapter,
        auditLedger = null,
        paymentSessionManager = null,
        gameplayContextResolver = null,
        ownerConfiguration = OwnerConfiguration,
        devMode = false
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameContractManager = gameContractManager;

        this._winnerEngine = winnerEngine;

        this._configurationEngine = configurationEngine;

        this._settlementAdapter = settlementAdapter;

        this._auditLedger = auditLedger;

        this._paymentSessionManager = paymentSessionManager;

        this._gameplayContextResolver = gameplayContextResolver;

        this._ownerConfiguration = ownerConfiguration;

        this._devMode = devMode;

        // gameId → settlement record
        this._byGameId = new Map();

        this._handlers = [];

        this._initialized = false;

    }

    initialize() {

        this._subscribe(
            EVENT_TYPES.WINNER_DETERMINED,
            (envelope) => {

                void this._handleWinnerDetermined(envelope.payload);

            }
        );

        this._subscribe(
            EVENT_TYPES.ROOM_DESTROYED,
            (envelope) => {

                this._forgetByRoom(envelope.payload?.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.SESSION_FINISHED,
            (envelope) => {

                this._forgetByRoom(envelope.payload?.roomId);

            }
        );

        this._subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            () => {

                this._reset();

            }
        );

        this._initialized = true;

    }

    shutdown() {

        for (const subscription of this._handlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._handlers = [];

        this._reset();

        this._initialized = false;

    }

    getSettlement(gameId) {

        return this._byGameId.get(gameId) ?? null;

    }

    /**
     * R6.0C — Read-only settlement summaries for Developer Console.
     * Uses getReconnectSnapshot (ownerWallet never included).
     */
    listSettlementSnapshots() {

        return [...this._byGameId.keys()]
            .map((gameId) => this.getReconnectSnapshot(gameId))
            .filter(Boolean);

    }

    getReconnectSnapshot(gameId) {

        const record = this._byGameId.get(gameId);

        if (!record) {

            return null;

        }

        return Object.freeze({
            gameId: record.gameId,
            roomId: record.roomId,
            contractId: record.contractId,
            status: record.status,
            winnerId: record.winnerId,
            winnerAmount: record.winnerAmount,
            organizerAmount: record.organizerAmount,
            settlementTxHash: record.settlementTxHash,
            startedAt: record.startedAt,
            completedAt: record.completedAt,
            failedAt: record.failedAt,
            reason: record.reason
            // ownerWallet intentionally omitted — never to clients
        });

    }

    async _handleWinnerDetermined(payload) {

        const gameId = payload?.gameId;

        if (!gameId || !this._initialized) {

            return;

        }

        const existing = this._byGameId.get(gameId);

        if (existing?.status === GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED) {

            this._audit(existing.roomId, {
                type: "SETTLEMENT_DUPLICATE_IGNORED",
                gameId,
                contractId: existing.contractId,
                at: Date.now()
            });

            return;

        }

        if (
            existing
            && existing.status !== GAME_CONTRACT_STATUS.SETTLEMENT_FAILED
        ) {

            // In-flight or already started — idempotent no-op.
            return;

        }

        const validation = this._validateSettlement(gameId, payload);

        if (!validation.ok) {

            this._failWithoutContract(gameId, validation);

            return;

        }

        await this._executeSettlement(validation);

    }

    _validateSettlement(gameId, winnerPayload) {

        const roomId = this._gameplayContextResolver
            ?.resolveRoomByGameId?.(gameId)
            ?? this._gameContractManager.getContractByGameId?.(gameId)?.roomId
            ?? null;

        const contract = this._gameContractManager.getContractByGameId?.(gameId)
            ?? (roomId
                ? this._gameContractManager.getContract?.(roomId)
                : null);

        if (!contract) {

            return { ok: false, gameId, roomId, reason: "contract_missing" };

        }

        if (!contract.snapshot) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: "snapshot_missing"
            };

        }

        if (contract.status !== GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: `contract_state_${contract.status}`
            };

        }

        const winnerId = winnerPayload?.winningPlayerId
            ?? winnerPayload?.winnerPlayerId
            ?? this._winnerEngine?.getResult?.(gameId)?.winningPlayer?.playerId
            ?? null;

        if (!winnerId) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: "winner_missing"
            };

        }

        const winnerSeat = contract.snapshot.players?.find(
            (player) => String(player.playerId) === String(winnerId)
        );

        const winnerWallet = winnerSeat?.wallet ?? null;

        if (!winnerWallet) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: "winner_wallet_missing"
            };

        }

        let ownerWallet = contract.snapshot.ownerWallet ?? null;

        try {

            ownerWallet = ownerWallet
                ?? this._ownerConfiguration.getOwnerWallet();

        } catch {

            ownerWallet = null;

        }

        if (!ownerWallet) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: "owner_wallet_missing"
            };

        }

        const winnerAmount = Number(contract.snapshot.payoutAmount);

        const organizerAmount = Number(contract.snapshot.organizerFee);

        if (!Number.isFinite(winnerAmount) || !Number.isFinite(organizerAmount)) {

            return {
                ok: false,
                gameId,
                roomId: contract.roomId,
                contractId: contract.contractId,
                reason: "payout_amounts_invalid"
            };

        }

        const traceSeed = this._configurationEngine
            ?.getConfiguration?.(gameId)?.traceSeed
            ?? this._winnerEngine?.getResult?.(gameId)?.traceSeed
            ?? null;

        return {
            ok: true,
            gameId,
            roomId: contract.roomId,
            contract,
            winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot: Number(contract.snapshot.totalPot),
            traceSeed
        };

    }

    async _executeSettlement(ctx) {

        const {
            gameId,
            roomId,
            contract,
            winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot,
            traceSeed
        } = ctx;

        const startedAt = Date.now();

        const record = {
            gameId,
            roomId,
            contractId: contract.contractId,
            status: GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING,
            winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot,
            traceSeed,
            settlementTxHash: null,
            startedAt,
            completedAt: null,
            failedAt: null,
            reason: null,
            request: null
        };

        this._byGameId.set(gameId, record);

        contract.transitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING);

        this._gameContractManager.notifyClientUpdate?.(contract)
            ?? this._emitContractUpdated(contract);

        this._audit(roomId, {
            type: "SETTLEMENT_STARTED",
            gameId,
            contractId: contract.contractId,
            winnerId,
            winnerWallet,
            ownerWalletMasked: maskWalletAddress(ownerWallet),
            totalPot,
            winnerAmount,
            organizerAmount,
            at: startedAt
        });

        this._emit(EVENT_TYPES.SETTLEMENT_STARTED, {
            gameId,
            roomId,
            contractId: contract.contractId,
            status: GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING,
            winnerId,
            winnerAmount,
            organizerAmount,
            timestamp: startedAt
        });

        const request = Object.freeze({
            gameId,
            contractId: contract.contractId,
            contractAddress: contract.contractAddress,
            winnerId,
            winnerWallet,
            ownerWallet,
            winnerAmount,
            organizerAmount,
            totalPot,
            traceSeed,
            timestamp: startedAt,
            snapshot: contract.snapshot
        });

        record.request = request;

        if (!contract.transitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_SUBMITTED)) {

            this._failSettlement(record, contract, "transition_submitted_failed");

            return;

        }

        record.status = GAME_CONTRACT_STATUS.SETTLEMENT_SUBMITTED;

        this._emitContractUpdated(contract);

        this._emit(EVENT_TYPES.SETTLEMENT_SUBMITTED, {
            gameId,
            roomId,
            contractId: contract.contractId,
            status: GAME_CONTRACT_STATUS.SETTLEMENT_SUBMITTED,
            timestamp: Date.now()
        });

        if (!contract.transitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_PENDING)) {

            this._failSettlement(record, contract, "transition_pending_failed");

            return;

        }

        record.status = GAME_CONTRACT_STATUS.SETTLEMENT_PENDING;

        this._emitContractUpdated(contract);

        this._log(
            `SETTLEMENT_PENDING | gameId=${gameId} | `
                + `contractId=${contract.contractId} | `
                + `winner=${maskWalletAddress(winnerWallet)} | `
                + `owner=${maskWalletAddress(ownerWallet)}`
        );

        let adapterResult;

        try {

            adapterResult = await this._settlementAdapter.settleContract(request);

        } catch (error) {

            this._failSettlement(
                record,
                contract,
                `adapter_threw:${error?.message ?? "unknown"}`
            );

            return;

        }

        if (!adapterResult?.ok) {

            this._failSettlement(
                record,
                contract,
                adapterResult?.reason ?? "settlement_adapter_failed"
            );

            return;

        }

        const settlementTxHash = adapterResult.settlementTxId
            ?? adapterResult.txHash
            ?? null;

        const confirmedAt = adapterResult.settledAt ?? Date.now();

        if (!contract.transitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_CONFIRMED)) {

            this._failSettlement(record, contract, "transition_confirmed_failed");

            return;

        }

        record.status = GAME_CONTRACT_STATUS.SETTLEMENT_CONFIRMED;

        record.settlementTxHash = settlementTxHash;

        this._emitContractUpdated(contract);

        this._emit(EVENT_TYPES.SETTLEMENT_CONFIRMED, {
            gameId,
            roomId,
            contractId: contract.contractId,
            status: GAME_CONTRACT_STATUS.SETTLEMENT_CONFIRMED,
            settlementTxHash,
            timestamp: confirmedAt
        });

        if (!contract.transitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED)) {

            this._failSettlement(record, contract, "transition_completed_failed");

            return;

        }

        const completedAt = Date.now();

        record.status = GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED;

        record.completedAt = completedAt;

        this._emitContractUpdated(contract);

        this._audit(roomId, {
            type: "SETTLEMENT_COMPLETED",
            gameId,
            contractId: contract.contractId,
            winnerId,
            winnerWallet,
            ownerWalletMasked: maskWalletAddress(ownerWallet),
            totalPot,
            winnerAmount,
            organizerAmount,
            settlementTxHash,
            at: completedAt,
            finalStatus: GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED
        });

        this._emit(EVENT_TYPES.SETTLEMENT_COMPLETED, {
            gameId,
            roomId,
            contractId: contract.contractId,
            status: GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED,
            winnerId,
            winnerAmount,
            organizerAmount,
            settlementTxHash,
            timestamp: completedAt
        });

        this._log(
            `SETTLEMENT_COMPLETED | gameId=${gameId} | `
                + `tx=${settlementTxHash ?? "none"}`
        );

        this._cleanupAfterSuccess(roomId, record);

    }

    _failWithoutContract(gameId, validation) {

        const roomId = validation.roomId ?? null;

        const failedAt = Date.now();

        const record = {
            gameId,
            roomId,
            contractId: validation.contractId ?? null,
            status: GAME_CONTRACT_STATUS.SETTLEMENT_FAILED,
            winnerId: null,
            winnerWallet: null,
            ownerWallet: null,
            winnerAmount: null,
            organizerAmount: null,
            totalPot: null,
            settlementTxHash: null,
            startedAt: failedAt,
            completedAt: null,
            failedAt,
            reason: validation.reason,
            request: null
        };

        this._byGameId.set(gameId, record);

        if (validation.contractId && roomId) {

            const contract = this._gameContractManager.getContract?.(roomId);

            if (
                contract
                && contract.status === GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE
            ) {

                contract.transitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING);

                contract.transitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_FAILED);

                this._emitContractUpdated(contract);

            }

        }

        this._audit(roomId, {
            type: "SETTLEMENT_FAILED",
            gameId,
            contractId: validation.contractId ?? null,
            reason: validation.reason,
            at: failedAt,
            finalStatus: GAME_CONTRACT_STATUS.SETTLEMENT_FAILED
        });

        this._emit(EVENT_TYPES.SETTLEMENT_FAILED, {
            gameId,
            roomId,
            contractId: validation.contractId ?? null,
            status: GAME_CONTRACT_STATUS.SETTLEMENT_FAILED,
            reason: validation.reason,
            timestamp: failedAt
        });

        this._log(
            `SETTLEMENT_FAILED | gameId=${gameId} | reason=${validation.reason}`
        );

    }

    _failSettlement(record, contract, reason) {

        const failedAt = Date.now();

        record.status = GAME_CONTRACT_STATUS.SETTLEMENT_FAILED;

        record.failedAt = failedAt;

        record.reason = reason;

        if (
            contract
            && contract.status !== GAME_CONTRACT_STATUS.SETTLEMENT_FAILED
            && contract.status !== GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED
        ) {

            // Best-effort transition into FAILED from current settlement step.
            if (contract.canTransitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_FAILED)) {

                contract.transitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_FAILED);

            } else if (
                contract.status === GAME_CONTRACT_STATUS.SETTLEMENT_CONFIRMED
            ) {

                // Confirmed only goes to COMPLETED; leave status, mark record failed.
            } else {

                contract.transitionTo(GAME_CONTRACT_STATUS.SETTLEMENT_FAILED);

            }

            this._emitContractUpdated(contract);

        }

        this._audit(record.roomId, {
            type: "SETTLEMENT_FAILED",
            gameId: record.gameId,
            contractId: record.contractId,
            winnerId: record.winnerId,
            winnerWallet: record.winnerWallet,
            ownerWalletMasked: record.ownerWallet
                ? maskWalletAddress(record.ownerWallet)
                : null,
            totalPot: record.totalPot,
            winnerAmount: record.winnerAmount,
            organizerAmount: record.organizerAmount,
            reason,
            at: failedAt,
            finalStatus: GAME_CONTRACT_STATUS.SETTLEMENT_FAILED
        });

        this._emit(EVENT_TYPES.SETTLEMENT_FAILED, {
            gameId: record.gameId,
            roomId: record.roomId,
            contractId: record.contractId,
            status: GAME_CONTRACT_STATUS.SETTLEMENT_FAILED,
            reason,
            timestamp: failedAt
        });

        this._log(
            `SETTLEMENT_FAILED | gameId=${record.gameId} | reason=${reason}`
        );

        // Temporary request object only — audit preserved.
        record.request = null;

    }

    _cleanupAfterSuccess(roomId, record) {

        // Preserve audit + settlement record for reconnect; drop request body.
        record.request = null;

        if (roomId) {

            this._paymentSessionManager?.destroySession?.(roomId);

        }

    }

    _forgetByRoom(roomId) {

        if (!roomId) {

            return;

        }

        for (const [gameId, record] of this._byGameId.entries()) {

            if (record.roomId === roomId) {

                this._byGameId.delete(gameId);

            }

        }

    }

    _emitContractUpdated(contract) {

        if (!contract) {

            return;

        }

        // Prefer manager client emit when available.
        if (typeof this._gameContractManager.notifyClientUpdate === "function") {

            this._gameContractManager.notifyClientUpdate(contract);

            return;

        }

        if (typeof this._gameContractManager._emitClientUpdate === "function") {

            this._gameContractManager._emitClientUpdate(contract);

            return;

        }

        this._eventBus.emit({
            source: EVENT_SOURCES.CONTRACT_SETTLEMENT_MANAGER,
            type: EVENT_TYPES.GAME_CONTRACT_UPDATED,
            payload: contract.toClientSnapshot()
        });

    }

    _audit(roomId, entry) {

        if (!roomId) {

            return;

        }

        this._auditLedger?.append?.(roomId, Object.freeze({
            category: "CONTRACT_SETTLEMENT",
            ...entry
        }));

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.CONTRACT_SETTLEMENT_MANAGER,
            type,
            payload
        });

    }

    _subscribe(event, handler) {

        this._eventBus.subscribe(event, handler);

        this._handlers.push({ event, handler });

    }

    _reset() {

        this._byGameId.clear();

    }

    _log(message) {

        this._logger.info(`[ContractSettlementManager] ${message}`);

    }

}
