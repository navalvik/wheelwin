/**
 * R17.8V.2P.H — Persistence boundary for deployment_cost_snapshot.
 *
 * Stage A: create / find / pending bookkeeping updates only.
 * No blockchain, EventBus, wallets, or cost calculation.
 */

import {
    DuplicateRecordError,
    ImmutableRecordError,
    RecordNotFoundError,
    TonFinancialPersistence,
    TON_FINANCIAL_RECORD_TYPES
} from "../../persistence/TonFinancialPersistence.js";
import { DEPLOYMENT_COST_SNAPSHOT_STATUS } from "./deploymentCostSnapshotStates.js";
import {
    applyDeploymentCostSnapshotFreeze,
    applyDeploymentCostSnapshotPendingPatch,
    deploymentCostSnapshotRecordId,
    generateDeploymentCostSnapshotCorrelationId,
    validateDeploymentCostSnapshotCreateInput
} from "./deploymentCostSnapshotSchema.js";

export class DeploymentCostSnapshotRepository {

    /**
     * @param {{ persistence: TonFinancialPersistence, tonNetwork?: string|null }} options
     */
    constructor({ persistence, tonNetwork = "testnet" } = {}) {

        if (!persistence) {

            throw new Error(
                "DeploymentCostSnapshotRepository requires TonFinancialPersistence"
            );

        }

        this._persistence = persistence;

        this._tonNetwork = tonNetwork ?? "testnet";

    }

    /**
     * @param {object} input
     * @returns {object} public financial record envelope view
     */
    create(input) {

        const validated = validateDeploymentCostSnapshotCreateInput(input);

        if (!validated.ok) {

            throw new Error(
                `Invalid deployment_cost_snapshot create | ${validated.errors.join(",")}`
            );

        }

        const payload = validated.payload;

        const byHash = this.findByDeploymentTxHash(payload.deploymentTxHash);

        if (byHash) {

            throw new DuplicateRecordError(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT,
                payload.deploymentTxHash
            );

        }

        const byGame = this.findByGameId(payload.gameId);

        if (byGame) {

            throw new DuplicateRecordError(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT,
                payload.gameId
            );

        }

        return this._persistence.createDeploymentCostSnapshotRecord(
            payload,
            {
                recordId: payload.id,
                status: payload.status,
                roomId: payload.roomId,
                gameId: payload.gameId,
                contractId: payload.contractId,
                tonNetwork: this._tonNetwork,
                correlationId: generateDeploymentCostSnapshotCorrelationId(),
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

            return this._persistence.loadDeploymentCostSnapshotRecord(recordId);

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

        // Stage A: recordId = sha256(deploymentTxHash) for filesystem safety.
        const recordId = deploymentCostSnapshotRecordId(deploymentTxHash);
        const record = this.findById(recordId);

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
                    === TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT
            )
        );

        return matches[0] ?? null;

    }

    /**
     * @returns {object[]}
     */
    listAll() {

        return this._persistence.listActive(
            TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT
        );

    }

    /**
     * @param {string} status
     * @returns {object[]}
     */
    listByStatus(status) {

        const target = String(status ?? "").trim();

        return this.listAll().filter(
            (record) => record.payload?.status === target
        );

    }

    /**
     * Active game_contract rows that have a durable DEPLOY hash.
     *
     * @returns {object[]}
     */
    listDeployedGameContracts() {

        return this._persistence.listActive(
            TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT
        ).filter((record) => {
            const hash = String(record.payload?.deploymentTxId ?? "").trim();
            const address = String(record.payload?.contractAddress ?? "").trim();
            return Boolean(hash && address);
        });

    }

    /**
     * Update PENDING_LOOKUP / FAILED_LOOKUP bookkeeping fields only.
     *
     * @param {string} id
     * @param {object} patch
     * @returns {object}
     */
    updatePendingLookup(id, patch) {

        const existing = this.findById(id);

        if (!existing) {

            throw new RecordNotFoundError(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT,
                id
            );

        }

        if (
            existing.immutable
            || existing.payload?.status
                === DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
        ) {

            throw new ImmutableRecordError(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT,
                existing.recordId
            );

        }

        const applied = applyDeploymentCostSnapshotPendingPatch(
            existing.payload,
            patch
        );

        if (!applied.ok) {

            throw new Error(
                `Invalid deployment_cost_snapshot pending patch | ${applied.errors.join(",")}`
            );

        }

        return this._persistence.updateDeploymentCostSnapshotRecord(
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

    /**
     * Stage D — freeze with chain economics (immutable thereafter).
     *
     * @param {string} id
     * @param {{
     *   attachedTon: string,
     *   networkFeeTon: string,
     *   deploymentCostTon: string,
     *   source?: string,
     *   frozenAt?: number
     * }} economics
     * @returns {object}
     */
    freezeFromChain(id, economics) {

        const existing = this.findById(id);

        if (!existing) {

            throw new RecordNotFoundError(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT,
                id
            );

        }

        if (
            existing.immutable
            || existing.payload?.status
                === DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN
        ) {

            throw new ImmutableRecordError(
                TON_FINANCIAL_RECORD_TYPES.DEPLOYMENT_COST_SNAPSHOT,
                existing.recordId
            );

        }

        const applied = applyDeploymentCostSnapshotFreeze(
            existing.payload,
            economics
        );

        if (!applied.ok) {

            throw new Error(
                `Invalid deployment_cost_snapshot freeze | ${applied.errors.join(",")}`
            );

        }

        return this._persistence.updateDeploymentCostSnapshotRecord(
            existing.recordId,
            applied.payload,
            {
                status: DEPLOYMENT_COST_SNAPSHOT_STATUS.FROZEN,
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
