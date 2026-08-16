/**
 * R17.8V.2P.M — Persistence boundary for deployment_reimbursement.
 */

import {
    DuplicateRecordError,
    ImmutableRecordError,
    RecordNotFoundError,
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../../persistence/TonFinancialPersistence.js";
import {
    DEPLOYMENT_REIMBURSEMENT_STATUS,
    isDeploymentReimbursementTerminal
} from "./deploymentReimbursementStates.js";
import {
    applyDeploymentReimbursementStatusPatch,
    deploymentReimbursementRecordId,
    generateDeploymentReimbursementCorrelationId,
    validateDeploymentReimbursementCreateInput
} from "./deploymentReimbursementSchema.js";

export class DeploymentReimbursementRepository {

    /**
     * @param {{ persistence: TonFinancialPersistence, tonNetwork?: string|null }} options
     */
    constructor({ persistence, tonNetwork = "testnet" } = {}) {

        if (!persistence) {

            throw new Error(
                "DeploymentReimbursementRepository requires TonFinancialPersistence"
            );

        }

        this._persistence = persistence;

        this._tonNetwork = tonNetwork ?? "testnet";

    }

    /**
     * @param {object} input
     * @returns {object}
     */
    create(input) {

        const validated = validateDeploymentReimbursementCreateInput(input);

        if (!validated.ok) {

            throw new Error(
                `Invalid deployment_reimbursement create | ${validated.errors.join(",")}`
            );

        }

        const payload = validated.payload;

        if (this.findByDeploymentTxHash(payload.deploymentTxHash)) {

            throw new DuplicateRecordError(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT,
                payload.deploymentTxHash
            );

        }

        if (this.findByGameId(payload.gameId)) {

            throw new DuplicateRecordError(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT,
                payload.gameId
            );

        }

        return this._persistence.createDeploymentReimbursementRecord(
            payload,
            {
                recordId: payload.id,
                status: payload.status,
                roomId: payload.roomId,
                gameId: payload.gameId,
                contractId: payload.contractId,
                tonNetwork: this._tonNetwork,
                correlationId: generateDeploymentReimbursementCorrelationId(),
                createdAt: payload.createdAt,
                updatedAt: payload.createdAt
            }
        );

    }

    /**
     * @param {string} id
     * @returns {object|null}
     */
    findById(id) {

        const recordId = String(id ?? "").trim();

        if (!recordId) {

            return null;

        }

        try {

            return this._persistence.loadDeploymentReimbursementRecord(recordId);

        } catch (error) {

            if (error instanceof RecordNotFoundError) {

                return null;

            }

            throw error;

        }

    }

    /**
     * @param {string} hash
     * @returns {object|null}
     */
    findByDeploymentTxHash(hash) {

        const deploymentTxHash = String(hash ?? "").trim();

        if (!deploymentTxHash) {

            return null;

        }

        const record = this.findById(
            deploymentReimbursementRecordId(deploymentTxHash)
        );

        if (
            record
            && record.payload?.deploymentTxHash === deploymentTxHash
        ) {

            return record;

        }

        return null;

    }

    /**
     * @param {string} gameId
     * @returns {object|null}
     */
    findByGameId(gameId) {

        const id = String(gameId ?? "").trim();

        if (!id) {

            return null;

        }

        const matches = this._persistence.findByGame(id).filter(
            (record) => (
                record.recordType
                    === TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT
            )
        );

        return matches[0] ?? null;

    }

    /**
     * @returns {object[]}
     */
    listPending() {

        return this._persistence.listActive(
            TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT
        ).filter(
            (record) => {

                const status = record.payload?.status;
                const txHash = String(record.payload?.txHash ?? "").trim();

                // Never re-send once a broadcast txHash exists (confirmation owns it).
                if (txHash) {

                    return false;

                }

                return status === DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
                    || status === DEPLOYMENT_REIMBURSEMENT_STATUS.FAILED_RETRY;

            }
        );

    }

    /**
     * PROCESSING records awaiting chain confirmation (have txHash).
     *
     * @returns {object[]}
     */
    listAwaitingConfirmation() {

        return this._persistence.listActive(
            TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT
        ).filter(
            (record) => (
                record.payload?.status
                    === DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING
                && String(record.payload?.txHash ?? "").trim().length > 0
            )
        );

    }

    /**
     * Persist broadcast txHash; remain PROCESSING. Does not confirm.
     *
     * @param {string} id
     * @param {{ txHash: string, processedAt?: number }} input
     * @returns {object}
     */
    markSent(id, input) {

        const txHash = String(input?.txHash ?? "").trim();

        if (!txHash) {

            throw new Error("markSent requires txHash");

        }

        return this.updateStatus(id, {
            status: DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING,
            txHash,
            processedAt: Number.isFinite(Number(input?.processedAt))
                ? Number(input.processedAt)
                : Date.now(),
            errorReason: null,
            confirmationAttempts: 0,
            nextConfirmationAt: null,
            confirmationError: null
        });

    }

    /**
     * PROCESSING → CONFIRMED (immutable). Requires existing txHash.
     *
     * @param {string} id
     * @param {{ confirmedAt?: number }} [input]
     * @returns {object}
     */
    markConfirmed(id, input = {}) {

        const existing = this.findById(id);

        if (!existing) {

            throw new RecordNotFoundError(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT,
                id
            );

        }

        return this.updateStatus(id, {
            status: DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED,
            txHash: existing.payload?.txHash,
            confirmedAt: Number.isFinite(Number(input?.confirmedAt))
                ? Number(input.confirmedAt)
                : Date.now(),
            errorReason: null,
            confirmationError: null,
            nextConfirmationAt: null
        });

    }

    /**
     * PROCESSING → FAILED_RETRY or FAILED_TERMINAL.
     *
     * @param {string} id
     * @param {{
     *   terminal?: boolean,
     *   errorReason?: string|null,
     *   confirmationError?: string|null,
     *   confirmationAttempts?: number,
     *   nextConfirmationAt?: number|null,
     *   nextRetryAt?: number|null,
     *   retryCount?: number
     * }} input
     * @returns {object}
     */
    markFailed(id, input = {}) {

        const terminal = Boolean(input.terminal);
        const existing = this.findById(id);
        const retryCount = input.retryCount !== undefined
            ? Number(input.retryCount)
            : Number(existing?.payload?.retryCount ?? 0) + (terminal ? 0 : 1);

        return this.updateStatus(id, {
            status: terminal
                ? DEPLOYMENT_REIMBURSEMENT_STATUS.FAILED_TERMINAL
                : DEPLOYMENT_REIMBURSEMENT_STATUS.FAILED_RETRY,
            errorReason: input.errorReason ?? null,
            confirmationError: input.confirmationError ?? input.errorReason ?? null,
            confirmationAttempts: input.confirmationAttempts !== undefined
                ? Number(input.confirmationAttempts)
                : existing?.payload?.confirmationAttempts,
            nextConfirmationAt: input.nextConfirmationAt !== undefined
                ? input.nextConfirmationAt
                : null,
            nextRetryAt: terminal
                ? null
                : (
                    input.nextRetryAt !== undefined
                        ? input.nextRetryAt
                        : Date.now() + 60_000
                ),
            retryCount
        });

    }

    /**
     * @param {string} id
     * @param {object} patch
     * @returns {object}
     */
    updateStatus(id, patch) {

        const existing = this.findById(id);

        if (!existing) {

            throw new RecordNotFoundError(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT,
                id
            );

        }

        if (
            existing.immutable
            || isDeploymentReimbursementTerminal(existing.payload?.status)
        ) {

            throw new ImmutableRecordError(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_REIMBURSEMENT,
                existing.recordId
            );

        }

        const applied = applyDeploymentReimbursementStatusPatch(
            existing.payload,
            patch
        );

        if (!applied.ok) {

            throw new Error(
                `Invalid deployment_reimbursement status patch | ${applied.errors.join(",")}`
            );

        }

        return this._persistence.updateDeploymentReimbursementRecord(
            existing.recordId,
            applied.payload,
            {
                status: applied.payload.status,
                expectedVersion: existing.version,
                roomId: applied.payload.roomId,
                gameId: applied.payload.gameId,
                contractId: applied.payload.contractId,
                tonNetwork: existing.tonNetwork ?? this._tonNetwork,
                correlationId: existing.correlationId
            }
        );

    }

}
