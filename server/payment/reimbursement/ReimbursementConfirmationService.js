/**
 * R17.8V.2P.P — Reimbursement transaction confirmation & recovery.
 *
 * Confirms PROCESSING+txHash records from TonCenter only.
 * Never signs, never sends, never touches Owner/Deployer secrets.
 */

import { EVENT_SOURCES } from "../../events/EventSources.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import { isDeploymentReimbursementEnabled } from "./deploymentReimbursementConfig.js";
import { DEPLOYMENT_REIMBURSEMENT_STATUS } from "./deploymentReimbursementStates.js";
import {
    REIMBURSEMENT_CONFIRMATION_MAX_ATTEMPTS,
    isReimbursementConfirmationDue,
    reimbursementNextConfirmationAt
} from "./reimbursementConfirmationBackoff.js";
import {
    extractReimbursementTransferFromTransaction,
    transactionHashOf
} from "./extractReimbursementTransferFromTransaction.js";
import { ReimbursementTransactionScanner } from "./ReimbursementTransactionScanner.js";

export const REIMBURSEMENT_CONFIRMATION_RESULT = Object.freeze({
    CONFIRMED: "CONFIRMED",
    PENDING: "PENDING",
    FAILED: "FAILED",
    TERMINAL: "TERMINAL",
    SKIPPED: "SKIPPED",
    FEATURE_DISABLED: "FEATURE_DISABLED",
    NOT_INITIALIZED: "NOT_INITIALIZED",
    ALREADY_CONFIRMED: "ALREADY_CONFIRMED",
    NO_TX_HASH: "NO_TX_HASH",
    TRANSPORT_MISSING: "TRANSPORT_MISSING",
    TX_RECOVERED: "TX_RECOVERED"
});

export class ReimbursementConfirmationService {

    /**
     * @param {{
     *   repository: import("./DeploymentReimbursementRepository.js").DeploymentReimbursementRepository,
     *   transport?: { getTransactions: Function }|null,
     *   scanner?: import("./ReimbursementTransactionScanner.js").ReimbursementTransactionScanner|null,
     *   eventBus?: { emit?: Function }|null,
     *   logger?: object|null,
     *   env?: NodeJS.ProcessEnv,
     *   transactionLookupLimit?: number
     * }} options
     */
    constructor({
        repository,
        transport = null,
        scanner = null,
        eventBus = null,
        logger = null,
        env = process.env,
        transactionLookupLimit = 40
    } = {}) {

        if (!repository) {

            throw new Error(
                "ReimbursementConfirmationService requires DeploymentReimbursementRepository"
            );

        }

        this._repository = repository;
        this._transport = transport;
        this._scanner = scanner ?? (
            transport
                ? new ReimbursementTransactionScanner({
                    transport,
                    logger,
                    pageSize: transactionLookupLimit
                })
                : null
        );
        this._eventBus = eventBus;
        this._logger = logger;
        this._env = env;
        this._transactionLookupLimit = Number.isFinite(Number(transactionLookupLimit))
            ? Math.max(1, Number(transactionLookupLimit))
            : 40;

        this._initialized = false;
        this._running = false;

    }

    initialize() {

        if (this._initialized) {

            return;

        }

        this._initialized = true;

        this._logger?.debug?.(
            "ReimbursementConfirmationService initialized (Stage Q)"
        );

        // Recovery is awaited by the worker / app startup — do not fire-and-forget
        // here (avoids busy-lock races with explicit recoverPendingConfirmations).

    }

    shutdown() {

        this._initialized = false;

    }

    /**
     * Confirm a single PROCESSING record with txHash against chain.
     *
     * @param {object|string} recordOrId
     * @returns {Promise<object>}
     */
    async confirmTransaction(recordOrId) {

        if (!this._initialized) {

            return {
                ok: false,
                code: REIMBURSEMENT_CONFIRMATION_RESULT.NOT_INITIALIZED,
                record: null
            };

        }

        if (!isDeploymentReimbursementEnabled(this._env)) {

            return {
                ok: true,
                code: REIMBURSEMENT_CONFIRMATION_RESULT.FEATURE_DISABLED,
                record: null
            };

        }

        const record = typeof recordOrId === "string"
            ? this._repository.findById(recordOrId)
            : recordOrId;

        if (!record?.payload) {

            return {
                ok: false,
                code: REIMBURSEMENT_CONFIRMATION_RESULT.SKIPPED,
                record: null,
                message: "record_missing"
            };

        }

        if (
            record.payload.status === DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED
        ) {

            return {
                ok: true,
                code: REIMBURSEMENT_CONFIRMATION_RESULT.ALREADY_CONFIRMED,
                record
            };

        }

        const txHash = String(record.payload.txHash ?? "").trim();
        const gameId = record.payload.gameId ?? null;

        if (!txHash) {

            return {
                ok: false,
                code: REIMBURSEMENT_CONFIRMATION_RESULT.NO_TX_HASH,
                record
            };

        }

        if (
            record.payload.status !== DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING
        ) {

            return {
                ok: false,
                code: REIMBURSEMENT_CONFIRMATION_RESULT.SKIPPED,
                record,
                message: "status_not_processing"
            };

        }

        const attempt = Number(record.payload.confirmationAttempts ?? 0) + 1;

        this._emitAudit(EVENT_TYPES.REIMBURSEMENT_CONFIRMATION_STARTED, {
            gameId,
            txHash,
            attempt,
            status: record.payload.status
        });

        if (!this._transport?.getTransactions) {

            return this._scheduleRetry(record, attempt, "transport_missing", {
                code: REIMBURSEMENT_CONFIRMATION_RESULT.TRANSPORT_MISSING
            });

        }

        const wallet = String(record.payload.reimbursementWallet ?? "").trim();

        if (!wallet) {

            return this._failTerminal(record, attempt, "reimbursement_wallet_missing");

        }

        let matched = null;

        try {

            const shallow = await this._transport.getTransactions(wallet, {
                limit: this._transactionLookupLimit,
                archival: true
            });

            const list = Array.isArray(shallow) ? shallow : [];

            matched = list.find((tx) => transactionHashOf(tx) === txHash) ?? null;

            if (!matched && this._scanner?.findByTxHash) {

                matched = await this._scanner.findByTxHash(wallet, txHash);

            }

        } catch (error) {

            return this._scheduleRetry(
                record,
                attempt,
                error?.message ?? "rpc_failure",
                { code: REIMBURSEMENT_CONFIRMATION_RESULT.PENDING }
            );

        }

        if (!matched) {

            return this._scheduleRetry(record, attempt, "transaction_not_found", {
                code: REIMBURSEMENT_CONFIRMATION_RESULT.PENDING
            });

        }

        const extracted = extractReimbursementTransferFromTransaction(matched, {
            txHash,
            deployWallet: record.payload.deployWallet,
            amountTon: record.payload.amountTon,
            reimbursementWallet: wallet
        });

        if (!extracted.ok) {

            // Definitive mismatch — do not resend; terminal.
            if (
                extracted.reason === "destination_mismatch"
                || extracted.reason === "amount_mismatch"
                || extracted.reason === "transaction_aborted"
            ) {

                return this._failTerminal(record, attempt, extracted.reason);

            }

            return this._scheduleRetry(record, attempt, extracted.reason, {
                code: REIMBURSEMENT_CONFIRMATION_RESULT.PENDING
            });

        }

        let confirmed;

        try {

            confirmed = this._repository.markConfirmed(record.recordId, {
                confirmedAt: Date.now()
            });

        } catch (error) {

            const latest = this._repository.findById(record.recordId);

            if (
                latest?.payload?.status
                    === DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED
            ) {

                return {
                    ok: true,
                    code: REIMBURSEMENT_CONFIRMATION_RESULT.ALREADY_CONFIRMED,
                    record: latest
                };

            }

            throw error;

        }

        this._emitAudit(EVENT_TYPES.REIMBURSEMENT_CONFIRMED, {
            gameId,
            txHash,
            attempt,
            status: DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED
        });

        this._logger?.info?.(
            `REIMBURSEMENT_CONFIRMED | gameId=${gameId} | txHash=${txHash}`
        );

        return {
            ok: true,
            code: REIMBURSEMENT_CONFIRMATION_RESULT.CONFIRMED,
            record: confirmed
        };

    }

    /**
     * Restart / stuck recovery: confirm all PROCESSING+txHash due records.
     * Also recovers AWAITING_TRANSACTION_HASH via deep scan. Never resends.
     *
     * @returns {Promise<{ scanned: number, results: object[] }>}
     */
    async recoverPendingConfirmations() {

        if (!this._initialized) {

            return { scanned: 0, results: [], skipped: "not_initialized" };

        }

        if (!isDeploymentReimbursementEnabled(this._env)) {

            return { scanned: 0, results: [], skipped: "feature_disabled" };

        }

        if (this._running) {

            return { scanned: 0, results: [], skipped: "busy" };

        }

        this._running = true;

        try {

            const hashRecovery = await this.recoverMissingTransactionHashes();

            const processingRecovery = await this.recoverProcessingWithoutHash();

            const awaiting = this._repository.listAwaitingConfirmation();
            const due = awaiting.filter(
                (record) => isReimbursementConfirmationDue(record.payload)
            );
            const results = [
                ...(hashRecovery.results ?? []),
                ...(processingRecovery.results ?? [])
            ];

            for (const record of due) {

                const result = await this.confirmTransaction(record);

                results.push({
                    recordId: record.recordId,
                    ...result
                });

            }

            return {
                scanned: awaiting.length
                    + (hashRecovery.scanned ?? 0)
                    + (processingRecovery.scanned ?? 0),
                due: due.length,
                hashRecovery,
                processingRecovery,
                results
            };

        } finally {

            this._running = false;

        }

    }

    /**
     * Case 1: PROCESSING/AWAITING without txHash after broadcast — deep scan only.
     *
     * @returns {Promise<{ scanned: number, results: object[] }>}
     */
    async recoverMissingTransactionHashes() {

        if (!this._initialized || !this._scanner?.findOutgoingTransfer) {

            return { scanned: 0, results: [] };

        }

        const awaiting = this._repository.listAwaitingTransactionHash?.() ?? [];
        const results = [];

        for (const record of awaiting) {

            const wallet = String(record.payload?.reimbursementWallet ?? "").trim();
            const deployWallet = String(record.payload?.deployWallet ?? "").trim();
            const amountTon = String(record.payload?.amountTon ?? "").trim();

            if (!wallet || !deployWallet || !amountTon) {

                results.push({
                    recordId: record.recordId,
                    ok: false,
                    code: REIMBURSEMENT_CONFIRMATION_RESULT.SKIPPED,
                    message: "incomplete_recovery_fields"
                });

                continue;

            }

            let found;

            try {

                found = await this._scanner.findOutgoingTransfer({
                    walletAddress: wallet,
                    deployWallet,
                    amountTon,
                    processedAt: record.payload?.processedAt ?? record.payload?.createdAt
                });

            } catch (error) {

                results.push({
                    recordId: record.recordId,
                    ok: false,
                    code: REIMBURSEMENT_CONFIRMATION_RESULT.PENDING,
                    message: error?.message ?? "scan_failed"
                });

                continue;

            }

            if (!found.ok) {

                results.push({
                    recordId: record.recordId,
                    ok: false,
                    code: REIMBURSEMENT_CONFIRMATION_RESULT.PENDING,
                    message: found.reason
                });

                continue;

            }

            const sent = this._repository.markSent(record.recordId, {
                txHash: found.txHash,
                processedAt: record.payload?.processedAt ?? Date.now()
            });

            this._emitAudit(EVENT_TYPES.REIMBURSEMENT_TX_RECOVERED, {
                gameId: record.payload?.gameId ?? null,
                txHash: found.txHash,
                attempt: Number(record.payload?.confirmationAttempts ?? 0),
                status: DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING,
                amount: amountTon
            });

            let confirmation;

            try {

                confirmation = await this.confirmTransaction(sent.recordId);

            } catch (error) {

                results.push({
                    recordId: record.recordId,
                    ok: true,
                    code: REIMBURSEMENT_CONFIRMATION_RESULT.TX_RECOVERED,
                    recoveredTxHash: found.txHash,
                    confirmation: {
                        ok: false,
                        message: error?.message ?? "confirm_after_recover_failed"
                    }
                });

                continue;

            }

            results.push({
                recordId: record.recordId,
                ok: true,
                code: REIMBURSEMENT_CONFIRMATION_RESULT.TX_RECOVERED,
                recoveredTxHash: found.txHash,
                confirmation
            });

        }

        return {
            scanned: awaiting.length,
            results
        };

    }

    /**
     * R17.8V.2P.S — PROCESSING without txHash (orphan after claim/crash).
     * Deep-scan Reimbursement Wallet only. Never blind resend.
     * Found → attach hash + confirm. Miss → AWAITING_TRANSACTION_HASH.
     *
     * @returns {Promise<{ scanned: number, results: object[] }>}
     */
    async recoverProcessingWithoutHash() {

        if (!this._initialized) {

            return { scanned: 0, results: [] };

        }

        const orphans = this._repository.listProcessingWithoutHash?.() ?? [];
        const results = [];

        for (const record of orphans) {

            const wallet = String(record.payload?.reimbursementWallet ?? "").trim();
            const deployWallet = String(record.payload?.deployWallet ?? "").trim();
            const amountTon = String(record.payload?.amountTon ?? "").trim();

            if (!wallet || !deployWallet || !amountTon) {

                this._repository.markAwaitingTransactionHash(record.recordId, {
                    processedAt: record.payload?.processedAt ?? Date.now()
                });

                results.push({
                    recordId: record.recordId,
                    ok: false,
                    code: REIMBURSEMENT_CONFIRMATION_RESULT.SKIPPED,
                    message: "incomplete_fields_moved_awaiting_hash",
                    status: DEPLOYMENT_REIMBURSEMENT_STATUS.AWAITING_TRANSACTION_HASH
                });

                continue;

            }

            if (!this._scanner?.findOutgoingTransfer) {

                this._repository.markAwaitingTransactionHash(record.recordId, {
                    processedAt: record.payload?.processedAt ?? Date.now()
                });

                results.push({
                    recordId: record.recordId,
                    ok: false,
                    code: REIMBURSEMENT_CONFIRMATION_RESULT.PENDING,
                    message: "scanner_unavailable_moved_awaiting_hash",
                    status: DEPLOYMENT_REIMBURSEMENT_STATUS.AWAITING_TRANSACTION_HASH
                });

                continue;

            }

            let found;

            try {

                found = await this._scanner.findOutgoingTransfer({
                    walletAddress: wallet,
                    deployWallet,
                    amountTon,
                    processedAt: record.payload?.processedAt ?? record.payload?.createdAt
                });

            } catch (error) {

                this._repository.markAwaitingTransactionHash(record.recordId, {
                    processedAt: record.payload?.processedAt ?? Date.now()
                });

                results.push({
                    recordId: record.recordId,
                    ok: false,
                    code: REIMBURSEMENT_CONFIRMATION_RESULT.PENDING,
                    message: error?.message ?? "scan_failed_moved_awaiting_hash",
                    status: DEPLOYMENT_REIMBURSEMENT_STATUS.AWAITING_TRANSACTION_HASH
                });

                continue;

            }

            if (!found?.ok) {

                this._repository.markAwaitingTransactionHash(record.recordId, {
                    processedAt: record.payload?.processedAt ?? Date.now()
                });

                results.push({
                    recordId: record.recordId,
                    ok: false,
                    code: REIMBURSEMENT_CONFIRMATION_RESULT.PENDING,
                    message: found?.reason ?? "tx_not_found_moved_awaiting_hash",
                    status: DEPLOYMENT_REIMBURSEMENT_STATUS.AWAITING_TRANSACTION_HASH,
                    resent: false
                });

                continue;

            }

            const sent = this._repository.markSent(record.recordId, {
                txHash: found.txHash,
                processedAt: record.payload?.processedAt ?? Date.now()
            });

            this._emitAudit(EVENT_TYPES.REIMBURSEMENT_TX_RECOVERED, {
                gameId: record.payload?.gameId ?? null,
                txHash: found.txHash,
                attempt: Number(record.payload?.confirmationAttempts ?? 0),
                status: DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING,
                amount: amountTon
            });

            let confirmation;

            try {

                confirmation = await this.confirmTransaction(sent.recordId);

            } catch (error) {

                results.push({
                    recordId: record.recordId,
                    ok: true,
                    code: REIMBURSEMENT_CONFIRMATION_RESULT.TX_RECOVERED,
                    recoveredTxHash: found.txHash,
                    confirmation: {
                        ok: false,
                        message: error?.message ?? "confirm_after_recover_failed"
                    }
                });

                continue;

            }

            results.push({
                recordId: record.recordId,
                ok: true,
                code: REIMBURSEMENT_CONFIRMATION_RESULT.TX_RECOVERED,
                recoveredTxHash: found.txHash,
                confirmation
            });

        }

        return {
            scanned: orphans.length,
            results
        };

    }

    /**
     * @param {object} record
     * @param {number} attempt
     * @param {string} reason
     * @param {{ code?: string }} [extra]
     * @returns {object}
     */
    _scheduleRetry(record, attempt, reason, extra = {}) {

        if (attempt >= REIMBURSEMENT_CONFIRMATION_MAX_ATTEMPTS) {

            return this._failTerminal(record, attempt, reason);

        }

        const updated = this._repository.updateStatus(record.recordId, {
            status: DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING,
            confirmationAttempts: attempt,
            nextConfirmationAt: reimbursementNextConfirmationAt(attempt),
            confirmationError: reason
        });

        this._emitAudit(EVENT_TYPES.REIMBURSEMENT_CONFIRMATION_RETRY, {
            gameId: record.payload?.gameId ?? null,
            txHash: record.payload?.txHash ?? null,
            attempt,
            status: DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING,
            reason
        });

        return {
            ok: false,
            code: extra.code ?? REIMBURSEMENT_CONFIRMATION_RESULT.PENDING,
            record: updated,
            message: reason
        };

    }

    /**
     * @param {object} record
     * @param {number} attempt
     * @param {string} reason
     * @returns {object}
     */
    _failTerminal(record, attempt, reason) {

        const updated = this._repository.markFailed(record.recordId, {
            terminal: true,
            errorReason: reason,
            confirmationError: reason,
            confirmationAttempts: attempt,
            nextConfirmationAt: null
        });

        this._emitAudit(EVENT_TYPES.REIMBURSEMENT_CONFIRMATION_FAILED, {
            gameId: record.payload?.gameId ?? null,
            txHash: record.payload?.txHash ?? null,
            attempt,
            status: DEPLOYMENT_REIMBURSEMENT_STATUS.FAILED_TERMINAL,
            reason
        });

        return {
            ok: false,
            code: REIMBURSEMENT_CONFIRMATION_RESULT.TERMINAL,
            record: updated,
            message: reason
        };

    }

    /**
     * @param {string} type
     * @param {object} payload
     */
    _emitAudit(type, payload) {

        const safe = Object.freeze({
            gameId: payload?.gameId ?? null,
            txHash: payload?.txHash ?? null,
            attempt: payload?.attempt ?? null,
            status: payload?.status ?? null,
            reason: payload?.reason ?? null,
            amount: payload?.amount ?? null,
            timestamp: payload?.timestamp ?? Date.now()
        });

        this._logger?.info?.(
            `${type} | gameId=${safe.gameId ?? "none"} | `
                + `txHash=${safe.txHash ?? "none"} | `
                + `attempt=${safe.attempt ?? "none"} | `
                + `status=${safe.status ?? "none"}`
        );

        try {

            this._eventBus?.emit?.({
                source: EVENT_SOURCES.DEPLOYMENT_REIMBURSEMENT_SERVICE,
                type,
                payload: safe
            });

        } catch (error) {

            this._logger?.warn?.(
                `ReimbursementConfirmationService audit emit failed | `
                    + `${error?.message ?? error}`
            );

        }

    }

}
