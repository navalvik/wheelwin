/**
 * Room-level residual sweep worker.
 *
 * Trigger: confirmed Room Wallet settlement for a roomNumber.
 * Never triggered from incoming player payments.
 * Default: feature flag OFF — no send, no Residues broadcast.
 */

import { SendMode } from "@ton/core";

import { EVENT_SOURCES } from "../../events/EventSources.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import { DuplicateRecordError } from "../../persistence/TonFinancialPersistence.js";
import {
    ROOM_WALLET_POLICY,
    buildResidualSweep
} from "./RoomWalletFinancialPolicy.js";
import { createRoomWalletService } from "./RoomWalletService.js";
import { tryNormalizeRoomNumber } from "./RoomWalletRegistry.js";
import { buildResidualSweepPlan } from "./RoomWalletSettlementPlan.js";
import {
    isRoomWalletResidualSweepEnabled,
    resolveResiduesWalletDestination
} from "./roomWalletConfig.js";
import {
    assertSweepSourceDiffersFromDestination,
    verifyResiduesWalletIdentity
} from "./ResiduesWalletConfig.js";
import { RESIDUAL_SWEEP_STATUS } from "./residualSweepStates.js";

export const RESIDUAL_SWEEP_WATCH_KIND = "RESIDUAL_SWEEP";

export class RoomWalletResidualSweepWorker {

    constructor({
        repository,
        roomWalletAdapter = null,
        registry = null,
        roomManager = null,
        blockchainMonitor = null,
        eventBus = null,
        logger = null,
        env = process.env,
        tonService = null,
        pollIntervalMs = 5_000
    } = {}) {
        if (!repository) {
            throw new Error("RoomWalletResidualSweepWorker requires repository");
        }

        this._repository = repository;
        this._roomWalletAdapter = roomWalletAdapter;
        this._registry = registry;
        this._roomManager = roomManager;
        this._blockchainMonitor = blockchainMonitor;
        this._eventBus = eventBus;
        this._logger = logger;
        this._env = env;
        this._tonService = tonService;
        this._pollIntervalMs = Number.isFinite(Number(pollIntervalMs))
            ? Math.max(1_000, Number(pollIntervalMs))
            : 5_000;
        this._initialized = false;
        this._timer = null;
        this._roomLocks = new Map();
        this._boundSettlementHandler = (envelope) => {
            void this._onSettlementConfirmed(envelope);
        };
        this._boundSweepConfirmedHandler = (envelope) => {
            void this._onSweepTransactionConfirmed(envelope);
        };
        this._boundSweepFailedHandler = (envelope) => {
            void this._onSweepTransactionFailed(envelope);
        };
    }

    initialize() {
        if (this._initialized) {
            return;
        }

        this._initialized = true;

        if (!isRoomWalletResidualSweepEnabled(this._env)) {
            this._logger?.info?.(
                "RoomWalletResidualSweepWorker initialized | enabled=false | no sends"
            );
            return;
        }

        this._ensureAdapter();

        const destination = resolveResiduesWalletDestination(this._env);

        this._logger?.info?.(
            "RoomWalletResidualSweepWorker initialized | enabled=true | "
                + `residues=${destination.ok ? "configured" : destination.code}`
        );

        this._eventBus?.subscribe?.(
            EVENT_TYPES.SETTLEMENT_CONFIRMED,
            this._boundSettlementHandler
        );
        this._eventBus?.subscribe?.(
            EVENT_TYPES.RESIDUAL_SWEEP_TRANSACTION_CONFIRMED,
            this._boundSweepConfirmedHandler
        );
        this._eventBus?.subscribe?.(
            EVENT_TYPES.TRANSACTION_FAILED,
            this._boundSweepFailedHandler
        );

        void this.recoverPending().catch((error) => {
            this._logger?.error?.(
                `RoomWalletResidualSweepWorker recoverPending failed | ${error?.message ?? error}`
            );
        });

        this._timer = setInterval(() => {
            void this.processQueue().catch((error) => {
                this._logger?.error?.(
                    `RoomWalletResidualSweepWorker processQueue error | ${error?.message ?? error}`
                );
            });
        }, this._pollIntervalMs);

        if (typeof this._timer.unref === "function") {
            this._timer.unref();
        }
    }

    shutdown() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }

        this._eventBus?.unsubscribe?.(
            EVENT_TYPES.SETTLEMENT_CONFIRMED,
            this._boundSettlementHandler
        );
        this._eventBus?.unsubscribe?.(
            EVENT_TYPES.RESIDUAL_SWEEP_TRANSACTION_CONFIRMED,
            this._boundSweepConfirmedHandler
        );
        this._eventBus?.unsubscribe?.(
            EVENT_TYPES.TRANSACTION_FAILED,
            this._boundSweepFailedHandler
        );

        this._initialized = false;
    }

    /**
     * Settlement-confirmed trigger. Re-checks live balance before any send.
     */
    async enqueueFromSettlement(payload = {}) {
        if (!isRoomWalletResidualSweepEnabled(this._env)) {
            return Object.freeze({
                ok: false,
                code: "SWEEP_DISABLED"
            });
        }

        const roomNumber = this._resolveRoomNumber(payload);

        if (roomNumber == null) {
            this._logSweep({
                event: "sweep_skip",
                code: "ROOM_NUMBER_UNRESOLVED",
                roomId: payload.roomId ?? null
            });
            return Object.freeze({
                ok: false,
                code: "ROOM_NUMBER_UNRESOLVED"
            });
        }

        return this.processRoom(roomNumber, {
            trigger: "SETTLEMENT_CONFIRMED",
            gameId: payload.gameId ?? null
        });
    }

    async recoverPending() {
        if (!isRoomWalletResidualSweepEnabled(this._env)) {
            return Object.freeze({ recovered: 0, skipped: "feature_disabled" });
        }

        const awaiting = this._repository.listAwaitingConfirmation();
        const orphanedProcessing = this._repository.listProcessingWithoutHash();
        let recovered = 0;

        for (const record of awaiting) {
            this._watchExisting(record);
            recovered += 1;
        }

        for (const record of orphanedProcessing) {
            this._repository.markAwaitingTransactionHash(record.recordId, {
                seqno: record.payload?.seqno ?? null
            });
            this._logSweep({
                event: "sweep_restart_no_rebroadcast",
                recordId: record.recordId,
                roomNumber: record.payload?.roomNumber,
                sourceAddress: record.payload?.sourceAddress,
                reason: "processing_without_txhash"
            });
            recovered += 1;
        }

        for (const record of this._repository.listAwaitingTransactionHashWithoutBroadcastEvidence()) {
            this._logSweep({
                event: "sweep_awaiting_hash_no_rebroadcast",
                recordId: record.recordId,
                roomNumber: record.payload?.roomNumber,
                sourceAddress: record.payload?.sourceAddress
            });
        }

        return Object.freeze({ recovered });
    }

    async processQueue() {
        if (!this._initialized || !isRoomWalletResidualSweepEnabled(this._env)) {
            return Object.freeze({
                scanned: 0,
                claimed: 0,
                results: [],
                skipped: this._initialized ? "feature_disabled" : "not_initialized"
            });
        }

        const results = [];
        const pending = this._repository.listPending();

        for (const record of pending) {
            const roomNumber = tryNormalizeRoomNumber(record.payload?.roomNumber);

            if (roomNumber == null) {
                results.push({
                    ok: false,
                    recordId: record.recordId,
                    code: "ROOM_NUMBER_UNRESOLVED"
                });
                continue;
            }

            results.push(await this._withRoomLock(roomNumber, () => (
                this._submitExisting(record.recordId)
            )));
        }

        return Object.freeze({
            scanned: pending.length,
            claimed: results.filter((result) => result?.ok).length,
            results
        });
    }

    async processRoom(roomNumber, { trigger = "manual" } = {}) {
        if (!isRoomWalletResidualSweepEnabled(this._env)) {
            return Object.freeze({
                ok: false,
                code: "SWEEP_DISABLED"
            });
        }

        const normalizedRoomNumber = tryNormalizeRoomNumber(roomNumber);

        if (normalizedRoomNumber == null) {
            return Object.freeze({
                ok: false,
                code: "ROOM_NUMBER_UNRESOLVED"
            });
        }

        return this._withRoomLock(normalizedRoomNumber, () => (
            this._processRoomLocked(normalizedRoomNumber, { trigger })
        ));
    }

    async confirmByTransactionHash(transactionId) {
        const hash = String(transactionId ?? "").trim();

        if (!hash) {
            return Object.freeze({ ok: false, code: "TX_HASH_MISSING" });
        }

        const record = this._repository.listAwaitingConfirmation()
            .find((entry) => String(entry.payload?.txHash ?? "").trim() === hash)
            ?? this._repository.listActive().find((entry) => (
                String(entry.payload?.txHash ?? "").trim() === hash
            ));

        if (!record) {
            return Object.freeze({ ok: false, code: "SWEEP_RECORD_NOT_FOUND" });
        }

        if (record.payload?.status === RESIDUAL_SWEEP_STATUS.CONFIRMED) {
            return Object.freeze({
                ok: true,
                code: "ALREADY_CONFIRMED",
                record
            });
        }

        const confirmed = this._repository.markConfirmed(record.recordId, {
            txHash: hash
        });

        this._emitCompleted(confirmed);
        this._logSweep({
            event: "sweep_confirmed",
            recordId: confirmed.recordId,
            roomNumber: confirmed.payload?.roomNumber,
            sourceAddress: confirmed.payload?.sourceAddress,
            destinationAddress: confirmed.payload?.destinationAddress,
            amountNano: confirmed.payload?.amountNano,
            txHash: hash,
            status: confirmed.payload?.status
        });

        return Object.freeze({
            ok: true,
            code: "CONFIRMED",
            record: confirmed
        });
    }

    _ensureAdapter() {
        if (this._roomWalletAdapter) {
            return this._roomWalletAdapter;
        }

        if (!this._tonService) {
            return null;
        }

        const service = createRoomWalletService({
            tonService: this._tonService,
            logger: this._logger,
            env: this._env
        });

        this._roomWalletAdapter = service.roomWalletAdapter;
        this._registry = this._registry ?? service.registry;
        return this._roomWalletAdapter;
    }

    async _processRoomLocked(roomNumber, { trigger }) {
        const inFlight = this._repository.findInFlightByRoomNumber(roomNumber);

        if (inFlight) {
            if (String(inFlight.payload?.txHash ?? "").trim()) {
                this._watchExisting(inFlight);
                this._logSweep({
                    event: "sweep_skip",
                    code: "IN_FLIGHT_HAS_TXHASH",
                    roomNumber,
                    recordId: inFlight.recordId,
                    txHash: inFlight.payload.txHash,
                    trigger
                });
                return Object.freeze({
                    ok: false,
                    code: "IN_FLIGHT_HAS_TXHASH",
                    record: inFlight
                });
            }

            if (
                inFlight.payload?.status === RESIDUAL_SWEEP_STATUS.PENDING
                || inFlight.payload?.status === RESIDUAL_SWEEP_STATUS.FAILED_RETRY
            ) {
                return this._submitExisting(inFlight.recordId);
            }

            this._logSweep({
                event: "sweep_skip",
                code: "IN_FLIGHT",
                roomNumber,
                recordId: inFlight.recordId,
                status: inFlight.payload?.status,
                trigger
            });
            return Object.freeze({
                ok: false,
                code: "IN_FLIGHT",
                record: inFlight
            });
        }

        const destination = resolveResiduesWalletDestination(this._env);

        if (!destination.ok) {
            this._logSweep({
                event: "sweep_skip",
                code: destination.code,
                roomNumber,
                trigger
            });
            return Object.freeze({
                ok: false,
                code: destination.code
            });
        }

        const plan = buildResidualSweepPlan({
            roomNumber,
            residuesWallet: destination.address
        });

        if (!plan.ok) {
            this._logSweep({
                event: "sweep_skip",
                code: plan.code,
                roomNumber,
                trigger
            });
            return Object.freeze({
                ok: false,
                code: plan.code
            });
        }

        const adapter = this._ensureAdapter();

        if (!adapter) {
            this._logSweep({
                event: "sweep_skip",
                code: "ADAPTER_UNAVAILABLE",
                roomNumber,
                trigger
            });
            return Object.freeze({
                ok: false,
                code: "ADAPTER_UNAVAILABLE"
            });
        }

        let sourceAddress;

        try {
            sourceAddress = this._registry?.require?.(roomNumber)?.address
                ?? null;
        } catch (error) {
            this._logSweep({
                event: "sweep_skip",
                code: "ROOM_WALLET_UNREGISTERED",
                roomNumber,
                trigger,
                reason: error?.message ?? String(error)
            });
            return Object.freeze({
                ok: false,
                code: "ROOM_WALLET_UNREGISTERED"
            });
        }

        if (!sourceAddress) {
            return Object.freeze({
                ok: false,
                code: "ROOM_WALLET_UNREGISTERED"
            });
        }

        const selfTransfer = assertSweepSourceDiffersFromDestination(
            sourceAddress,
            destination.address
        );

        if (!selfTransfer.ok) {
            this._logSweep({
                event: "sweep_skip",
                code: selfTransfer.code,
                roomNumber,
                sourceAddress,
                destinationAddress: destination.address,
                trigger
            });
            return Object.freeze({
                ok: false,
                code: selfTransfer.code
            });
        }

        const identity = await verifyResiduesWalletIdentity(this._env);

        if (!identity.ok) {
            this._logSweep({
                event: "sweep_skip",
                code: identity.code,
                roomNumber,
                sourceAddress,
                destinationAddress: destination.address,
                trigger
            });
            return Object.freeze({
                ok: false,
                code: identity.code
            });
        }

        if (
            identity.derivedAddress
            && !assertSweepSourceDiffersFromDestination(
                sourceAddress,
                identity.derivedAddress
            ).ok
        ) {
            this._logSweep({
                event: "sweep_skip",
                code: "SOURCE_EQUALS_DESTINATION",
                roomNumber,
                sourceAddress,
                destinationAddress: identity.derivedAddress,
                trigger
            });
            return Object.freeze({
                ok: false,
                code: "SOURCE_EQUALS_DESTINATION"
            });
        }

        let balanceNano;

        try {
            balanceNano = await adapter.getBalance(roomNumber);
        } catch (error) {
            this._logSweep({
                event: "sweep_skip",
                code: "BALANCE_LOOKUP_FAILED",
                roomNumber,
                sourceAddress,
                trigger,
                reason: error?.message ?? String(error)
            });
            return Object.freeze({
                ok: false,
                code: "BALANCE_LOOKUP_FAILED"
            });
        }

        const eligibility = buildResidualSweep({ balanceNano });

        this._logSweep({
            event: "sweep_eligibility",
            roomNumber,
            sourceAddress,
            destinationAddress: destination.address,
            observedBalanceNano: balanceNano.toString(10),
            eligible: eligibility.eligible,
            reason: eligibility.reason,
            transferNano: eligibility.transferNano.toString(10),
            retainedFloorNano: eligibility.retainedFloorNano.toString(10),
            sweepGasNano: eligibility.sweepGasNano.toString(10),
            safetyMarginNano: eligibility.safetyMarginNano.toString(10),
            remainingAfterTransferNano:
                eligibility.remainingAfterTransferNano.toString(10),
            trigger
        });

        if (!eligibility.eligible) {
            return Object.freeze({
                ok: false,
                code: eligibility.reason,
                eligibility
            });
        }

        let record;

        try {
            record = this._repository.create({
                roomNumber,
                sourceAddress,
                destinationAddress: destination.address,
                observedBalanceNano: balanceNano,
                amountNano: eligibility.transferNano,
                idempotencyKey: `${trigger}:${roomNumber}:${Date.now()}`
            });
        } catch (error) {
            if (error instanceof DuplicateRecordError) {
                return Object.freeze({
                    ok: false,
                    code: "IN_FLIGHT",
                    record: this._repository.findInFlightByRoomNumber(roomNumber)
                });
            }

            throw error;
        }

        return this._submitExisting(record.recordId);
    }

    async _submitExisting(recordId) {
        const record = this._repository.findById(recordId);

        if (!record) {
            return Object.freeze({
                ok: false,
                code: "SWEEP_RECORD_NOT_FOUND"
            });
        }

        if (String(record.payload?.txHash ?? "").trim()) {
            this._watchExisting(record);
            return Object.freeze({
                ok: false,
                code: "IN_FLIGHT_HAS_TXHASH",
                record
            });
        }

        if (
            record.payload?.status === RESIDUAL_SWEEP_STATUS.AWAITING_TRANSACTION_HASH
            || record.payload?.status === RESIDUAL_SWEEP_STATUS.PROCESSING
        ) {
            return Object.freeze({
                ok: false,
                code: "IN_FLIGHT",
                record
            });
        }

        const destination = resolveResiduesWalletDestination(this._env);

        if (!destination.ok) {
            this._repository.markFailed(record.recordId, {
                terminal: true,
                failureReason: destination.code
            });
            return Object.freeze({
                ok: false,
                code: destination.code
            });
        }

        const sourceAddress = record.payload?.sourceAddress ?? null;
        const selfTransfer = assertSweepSourceDiffersFromDestination(
            sourceAddress,
            destination.address
        );

        if (!selfTransfer.ok) {
            this._repository.markFailed(record.recordId, {
                terminal: true,
                failureReason: selfTransfer.code
            });
            this._logSweep({
                event: "sweep_skip",
                code: selfTransfer.code,
                recordId,
                sourceAddress,
                destinationAddress: destination.address
            });
            return Object.freeze({
                ok: false,
                code: selfTransfer.code
            });
        }

        const identity = await verifyResiduesWalletIdentity(this._env);

        if (!identity.ok) {
            this._repository.markFailed(record.recordId, {
                terminal: true,
                failureReason: identity.code
            });
            return Object.freeze({
                ok: false,
                code: identity.code
            });
        }

        const adapter = this._ensureAdapter();

        if (!adapter) {
            this._repository.markFailed(record.recordId, {
                terminal: false,
                failureReason: "ADAPTER_UNAVAILABLE"
            });
            return Object.freeze({
                ok: false,
                code: "ADAPTER_UNAVAILABLE"
            });
        }

        const roomNumber = tryNormalizeRoomNumber(record.payload.roomNumber);
        let balanceNano;

        try {
            balanceNano = await adapter.getBalance(roomNumber);
        } catch (error) {
            this._repository.markFailed(record.recordId, {
                terminal: false,
                failureReason: "BALANCE_LOOKUP_FAILED"
            });
            this._logSweep({
                event: "sweep_retryable_failure",
                recordId,
                roomNumber,
                reason: error?.message ?? String(error)
            });
            return Object.freeze({
                ok: false,
                code: "BALANCE_LOOKUP_FAILED"
            });
        }

        const eligibility = buildResidualSweep({ balanceNano });

        if (!eligibility.eligible) {
            this._repository.markFailed(record.recordId, {
                terminal: true,
                failureReason: eligibility.reason
            });
            return Object.freeze({
                ok: false,
                code: eligibility.reason,
                eligibility
            });
        }

        this._repository.markProcessing(record.recordId, {
            observedBalanceNano: balanceNano.toString(10)
        });

        let sendResult;

        try {
            sendResult = await adapter.sendTransfer({
                roomNumber,
                destination: destination.address,
                amountNano: ROOM_WALLET_POLICY.residualSweepNano,
                sourceReserveNano: ROOM_WALLET_POLICY.residualRetainedFloorNano,
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });
        } catch (error) {
            this._repository.markFailed(record.recordId, {
                terminal: false,
                failureReason: `SUBMIT_FAILED:${error?.message ?? error}`
            });
            this._logSweep({
                event: "sweep_retryable_failure",
                recordId,
                roomNumber,
                sourceAddress: record.payload.sourceAddress,
                destinationAddress: destination.address,
                reason: error?.message ?? String(error)
            });
            return Object.freeze({
                ok: false,
                code: "SUBMIT_FAILED"
            });
        }

        if (!sendResult?.ok) {
            const terminal = sendResult?.code === "INSUFFICIENT_BALANCE";
            this._repository.markFailed(record.recordId, {
                terminal,
                failureReason: sendResult?.code ?? "SUBMIT_FAILED"
            });
            this._logSweep({
                event: terminal ? "sweep_terminal_failure" : "sweep_retryable_failure",
                recordId,
                roomNumber,
                sourceAddress: record.payload.sourceAddress,
                destinationAddress: destination.address,
                observedBalanceNano: sendResult?.balanceNano?.toString?.(10),
                reason: sendResult?.code ?? "SUBMIT_FAILED"
            });
            return Object.freeze({
                ok: false,
                code: sendResult?.code ?? "SUBMIT_FAILED"
            });
        }

        const txHash = String(sendResult.txHash ?? "").trim();

        if (!txHash) {
            const awaiting = this._repository.markAwaitingTransactionHash(
                record.recordId,
                { seqno: sendResult.seqno ?? null }
            );
            this._logSweep({
                event: "sweep_awaiting_hash",
                recordId,
                roomNumber,
                sourceAddress: record.payload.sourceAddress,
                destinationAddress: destination.address,
                amountNano: ROOM_WALLET_POLICY.residualSweepNano.toString(10),
                seqno: sendResult.seqno ?? null,
                status: awaiting.payload.status
            });
            return Object.freeze({
                ok: true,
                code: "AWAITING_TRANSACTION_HASH",
                record: awaiting
            });
        }

        const sent = this._repository.markSent(record.recordId, {
            txHash,
            seqno: sendResult.seqno ?? null
        });

        this._watchExisting(sent);
        this._logSweep({
            event: "sweep_submitted",
            recordId,
            roomNumber,
            sourceAddress: record.payload.sourceAddress,
            destinationAddress: destination.address,
            amountNano: ROOM_WALLET_POLICY.residualSweepNano.toString(10),
            sweepGasNano: ROOM_WALLET_POLICY.residualSweepGasNano.toString(10),
            safetyMarginNano: ROOM_WALLET_POLICY.residualSafetyMarginNano.toString(10),
            txHash,
            seqno: sendResult.seqno ?? null,
            status: sent.payload.status
        });

        return Object.freeze({
            ok: true,
            code: "SUBMITTED",
            record: sent
        });
    }

    _watchExisting(record) {
        const txHash = String(record?.payload?.txHash ?? "").trim();
        const address = String(record?.payload?.sourceAddress ?? "").trim();

        if (!txHash || !address || !this._blockchainMonitor?.watchTransaction) {
            return;
        }

        try {
            this._blockchainMonitor.watchTransaction({
                transactionId: txHash,
                address,
                kind: RESIDUAL_SWEEP_WATCH_KIND,
                correlationId: record.recordId
            });
        } catch (error) {
            this._logger?.warn?.(
                `RoomWalletResidualSweepWorker watch failed | record=${record.recordId} | `
                    + `${error?.message ?? error}`
            );
        }
    }

    async _onSettlementConfirmed(envelope) {
        try {
            await this.enqueueFromSettlement(envelope?.payload ?? envelope ?? {});
        } catch (error) {
            this._logger?.error?.(
                `RoomWalletResidualSweepWorker settlement trigger failed | `
                    + `${error?.message ?? error}`
            );
        }
    }

    async _onSweepTransactionConfirmed(envelope) {
        const payload = envelope?.payload ?? envelope ?? {};

        if (payload.kind && payload.kind !== RESIDUAL_SWEEP_WATCH_KIND) {
            return;
        }

        try {
            await this.confirmByTransactionHash(
                payload.transactionId ?? payload.txHash
            );
        } catch (error) {
            this._logger?.error?.(
                `RoomWalletResidualSweepWorker confirm failed | ${error?.message ?? error}`
            );
        }
    }

    async _onSweepTransactionFailed(envelope) {
        const payload = envelope?.payload ?? envelope ?? {};

        if (payload.kind !== RESIDUAL_SWEEP_WATCH_KIND) {
            return;
        }

        const hash = String(payload.transactionId ?? payload.txHash ?? "").trim();
        const record = this._repository.listActive().find((entry) => (
            String(entry.payload?.txHash ?? "").trim() === hash
        ));

        if (!record || record.payload?.status === RESIDUAL_SWEEP_STATUS.CONFIRMED) {
            return;
        }

        const bounced = payload.reason === "transaction_failed";

        try {
            this._repository.markFailed(record.recordId, {
                terminal: bounced,
                failureReason: payload.reason ?? "TRANSACTION_FAILED"
            });
            this._logSweep({
                event: bounced ? "sweep_terminal_failure" : "sweep_retryable_failure",
                recordId: record.recordId,
                roomNumber: record.payload?.roomNumber,
                sourceAddress: record.payload?.sourceAddress,
                txHash: hash,
                reason: payload.reason ?? "TRANSACTION_FAILED"
            });
        } catch (error) {
            this._logger?.error?.(
                `RoomWalletResidualSweepWorker fail-mark failed | ${error?.message ?? error}`
            );
        }
    }

    _resolveRoomNumber(payload) {
        const direct = tryNormalizeRoomNumber(payload?.roomNumber)
            ?? tryNormalizeRoomNumber(payload?.request?.roomNumber);

        if (direct != null) {
            return direct;
        }

        const roomId = payload?.roomId;

        if (roomId && this._roomManager?.resolveRoomNumber) {
            return tryNormalizeRoomNumber(
                this._roomManager.resolveRoomNumber(roomId)
            );
        }

        return null;
    }

    async _withRoomLock(roomNumber, fn) {
        const previous = this._roomLocks.get(roomNumber) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const held = previous.then(() => gate);
        this._roomLocks.set(roomNumber, held);

        await previous;

        try {
            return await fn();
        } finally {
            release();
            if (this._roomLocks.get(roomNumber) === held) {
                this._roomLocks.delete(roomNumber);
            }
        }
    }

    _emitCompleted(record) {
        if (!this._eventBus?.emit) {
            return;
        }

        this._eventBus.emit({
            source: EVENT_SOURCES.ROOM_WALLET_RESIDUAL_SWEEP_WORKER,
            type: EVENT_TYPES.RESIDUAL_SWEEP_CONFIRMED,
            payload: {
                recordId: record.recordId,
                roomNumber: record.payload?.roomNumber ?? null,
                sourceAddress: record.payload?.sourceAddress ?? null,
                destinationAddress: record.payload?.destinationAddress ?? null,
                amountNano: record.payload?.amountNano ?? null,
                txHash: record.payload?.txHash ?? null,
                status: record.payload?.status ?? null,
                kind: "RESIDUAL_SWEEP"
            }
        });
    }

    _logSweep(fields) {
        const parts = Object.entries(fields)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}=${value}`);

        this._logger?.info?.(`RoomWalletResidualSweep | ${parts.join(" | ")}`);
    }
}
