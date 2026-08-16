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
            (record) => (
                record.payload?.status === DEPLOYMENT_REIMBURSEMENT_STATUS.PENDING
                || record.payload?.status
                    === DEPLOYMENT_REIMBURSEMENT_STATUS.FAILED_RETRY
            )
        );

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
