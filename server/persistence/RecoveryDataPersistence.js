/**
 * R17.9T.6-C — Recovery Data Contract persistence layer.
 *
 * Thin wrapper around TonFinancialPersistence that provides recovery-specific
 * validation, version compatibility checks, and fail-closed behavior for
 * Recovery Data Contract records.
 *
 * This layer stores gameplay recovery data and REFERENCES financial records.
 * It does NOT duplicate financial authority. Financial fields such as
 * paymentStatus, paidAmount, confirmationStatus, refundTxHash, and
 * settlementTransactionHash remain owned by TonFinancialPersistence financial
 * records and are NOT stored here.
 *
 * Scope limit (R17.9T.6-C):
 *   - ONLY durable persistence for Recovery Data Contract records.
 *   - NO gameplay reconstruction.
 *   - NO runtime manager recovery.
 *   - NO financial reconciliation logic.
 */

import {
    CorruptedRecordError,
    ImmutableRecordError,
    RecordNotFoundError,
    TonFinancialPersistenceError
} from "./TonFinancialPersistenceErrors.js";
import {
    RECOVERY_DATA_TERMINAL_STATUSES,
    TON_FINANCIAL_RECORD_TYPES,
    TON_FINANCIAL_SCHEMA_VERSION
} from "./TonFinancialRecordTypes.js";
import {
    computePayloadChecksum
} from "./tonFinancialRecordUtils.js";

/**
 * Recovery Data Contract version.
 *
 * Major version changes (breaking changes to the contract schema) cause
 * FAIL CLOSED for records with incompatible versions.
 *
 * Version 1 — initial Recovery Data Contract (R17.9T.6-C).
 */
export const RECOVERY_CONTRACT_VERSION = 1;

/**
 * Maximum supported recovery contract version.
 *
 * Records with recoveryContractVersion > MAX_SUPPORTED_RECOVERY_CONTRACT_VERSION
 * are rejected (fail-closed) because this version of the code cannot safely
 * interpret them.
 */
export const MAX_SUPPORTED_RECOVERY_CONTRACT_VERSION = 1;

/**
 * Required identity fields in every recovery record payload.
 */
const REQUIRED_IDENTITY_FIELDS = Object.freeze([
    "recoveryRecordId",
    "roomId",
    "gameId",
    "contractId",
    "paymentSessionId",
    "tonNetwork"
]);

/**
 * Required configuration fields in every recovery record payload.
 */
const REQUIRED_CONFIGURATION_FIELDS = Object.freeze([
    "configuration",
    "configurationHash",
    "configurationVersion",
    "traceSeed",
    "snapshotHash"
]);

/**
 * Required gameplay state fields in every recovery record payload.
 */
const REQUIRED_GAMEPLAY_STATE_FIELDS = Object.freeze([
    "gameState",
    "gameStatus",
    "serverTimestampAtCheckpoint"
]);

/**
 * Required player fields for each entry in the players array.
 */
const REQUIRED_PLAYER_FIELDS = Object.freeze([
    "playerId",
    "playerIndex",
    "wallet",
    "nickname",
    "baseStake",
    "sectorCount",
    "color",
    "colorSector2",
    "icon",
    "sectorArrangement",
    "age"
]);

/**
 * Required clock state fields for active (non-terminal) recovery records.
 */
const REQUIRED_CLOCK_STATE_FIELDS = Object.freeze([
    "phaseStartedAt",
    "clockStartedAt",
    "clockPaused",
    "clockTotalPausedMs",
    "awaitingResultActivation",
    "resultPhaseStarted"
]);

/**
 * Required terminal physics fields for terminal recovery records.
 */
const REQUIRED_TERMINAL_PHYSICS_FIELDS = Object.freeze([
    "physicsFinalAngle",
    "physicsFinalTriangleAngle",
    "physicsSimulationState"
]);

/**
 * Financial fields that must NOT be duplicated in recovery records.
 * These are owned by TonFinancialPersistence financial records.
 */
const FORBIDDEN_FINANCIAL_AUTHORITY_FIELDS = Object.freeze([
    "paymentStatus",
    "paidAmount",
    "confirmationStatus",
    "refundTxHash",
    "settlementTransactionHash",
    "prizeAmount",
    "organizerAmount",
    "totalPot",
    "requiredGram"
]);

/**
 * @typedef {object} RecoveryDataPersistenceOptions
 * @property {object} financialPersistence - Initialized TonFinancialPersistence instance.
 * @property {object} [logger]
 */

export class RecoveryDataPersistence {

    /**
     * @param {RecoveryDataPersistenceOptions} options
     */
    constructor({ financialPersistence, logger = null } = {}) {

        if (!financialPersistence) {

            throw new TonFinancialPersistenceError(
                "RecoveryDataPersistence requires a TonFinancialPersistence instance"
            );

        }

        this._financialPersistence = financialPersistence;

        this._logger = logger;

    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Create a new recovery data record.
     *
     * @param {object} recoveryData - The recovery data contract payload.
     * @param {object} [metadata] - Optional envelope metadata overrides.
     * @returns {object} The created public record.
     * @throws {TonFinancialPersistenceError} If validation fails or persistence error occurs.
     */
    createRecoveryRecord(recoveryData, metadata = {}) {

        this._validateRecoveryPayload(recoveryData);

        const enrichedMetadata = this._buildEnvelopeMetadata(recoveryData, metadata);

        return this._financialPersistence.createRecoveryDataRecord(
            recoveryData,
            enrichedMetadata
        );

    }

    /**
     * Load a recovery data record by its record ID.
     *
     * @param {string} recordId - The recovery record ID (typically the gameId).
     * @returns {object|null} The loaded public record, or null if not found.
     * @throws {TonFinancialPersistenceError} If the record is corrupted or invalid.
     */
    loadRecoveryRecord(recordId) {

        try {

            const record = this._financialPersistence.loadRecoveryDataRecord(recordId);

            const validationResult = this.validateRecoveryRecord(record);

            if (!validationResult.valid) {

                throw new CorruptedRecordError(
                    TON_FINANCIAL_RECORD_TYPES.RECOVERY_DATA,
                    recordId,
                    validationResult.errors.join(",")
                );

            }

            return record;

        } catch (error) {

            if (error instanceof RecordNotFoundError) {

                return null;

            }

            throw error;

        }

    }

    /**
     * List all active recovery data records.
     *
     * @returns {object[]} Array of valid public records. Invalid records are skipped.
     */
    listRecoveryRecords() {

        const records = this._financialPersistence.listActiveRecoveryDataRecords();

        return records.filter((record) => {

            const result = this.validateRecoveryRecord(record);

            if (!result.valid) {

                this._logError(
                    `RecoveryDataPersistence: skipping invalid recovery record | `
                        + `id=${record.recordId} | errors=${result.errors.join(",")}`
                );

                return false;

            }

            return true;

        });

    }

    /**
     * Update a recovery data record (only if mutable).
     *
     * @param {string} recordId - The recovery record ID.
     * @param {object} recoveryData - The updated recovery data contract payload.
     * @param {object} [metadata] - Optional envelope metadata overrides.
     * @returns {object} The updated public record.
     * @throws {ImmutableRecordError} If the record is terminal (immutable).
     * @throws {TonFinancialPersistenceError} If validation fails or persistence error occurs.
     */
    updateRecoveryRecord(recordId, recoveryData, metadata = {}) {

        this._validateRecoveryPayload(recoveryData);

        const existing = this._financialPersistence.loadRecoveryDataRecord(recordId);

        if (existing.immutable) {

            throw new ImmutableRecordError(
                TON_FINANCIAL_RECORD_TYPES.RECOVERY_DATA,
                recordId
            );

        }

        const enrichedMetadata = this._buildEnvelopeMetadata(recoveryData, metadata);

        return this._financialPersistence.updateRecoveryDataRecord(
            recordId,
            recoveryData,
            enrichedMetadata
        );

    }

    /**
     * Validate a recovery record's integrity, version compatibility, and structure.
     *
     * @param {object} record - The public record returned by TonFinancialPersistence.
     * @returns {{valid: boolean, errors: string[]}} Validation result.
     */
    validateRecoveryRecord(record) {

        const errors = [];

        // --- Basic structure ---

        if (!record || typeof record !== "object") {

            return { valid: false, errors: ["record_missing"] };

        }

        // --- Checksum verification (re-verify from public record) ---

        const expectedChecksum = computePayloadChecksum(record.payload);

        if (record.checksum !== expectedChecksum) {

            errors.push("checksum_mismatch");

        }

        // --- Schema version ---

        if (record.version !== TON_FINANCIAL_SCHEMA_VERSION) {

            errors.push(
                `schema_version_incompatible:${record.version}:${TON_FINANCIAL_SCHEMA_VERSION}`
            );

        }

        const payload = record.payload ?? {};

        // --- Recovery contract version ---

        const recoveryContractVersion = payload.recoveryContractVersion;

        if (typeof recoveryContractVersion !== "number") {

            errors.push("recoveryContractVersion_missing");

        } else if (recoveryContractVersion > MAX_SUPPORTED_RECOVERY_CONTRACT_VERSION) {

            errors.push(
                `recoveryContractVersion_incompatible:${recoveryContractVersion}`
            );

        } else if (recoveryContractVersion < 1) {

            errors.push(
                `recoveryContractVersion_invalid:${recoveryContractVersion}`
            );

        }

        // --- Identity fields ---

        for (const field of REQUIRED_IDENTITY_FIELDS) {

            if (payload[field] == null || payload[field] === "") {

                errors.push(`identity_missing:${field}`);

            }

        }

        // --- Configuration fields ---

        for (const field of REQUIRED_CONFIGURATION_FIELDS) {

            if (payload[field] == null || payload[field] === "") {

                errors.push(`configuration_missing:${field}`);

            }

        }

        // --- Configuration hash verification ---

        if (payload.configuration != null && payload.configurationHash != null) {

            const computedHash = computePayloadChecksum(payload.configuration);

            if (computedHash !== payload.configurationHash) {

                errors.push("configurationHash_mismatch");

            }

        }

        // --- Gameplay state fields ---

        for (const field of REQUIRED_GAMEPLAY_STATE_FIELDS) {

            if (payload[field] == null) {

                errors.push(`gameplay_state_missing:${field}`);

            }

        }

        // --- Players array ---

        if (!Array.isArray(payload.players)) {

            errors.push("players_missing");

        } else if (payload.players.length === 0) {

            errors.push("players_empty");

        } else {

            for (let i = 0; i < payload.players.length; i += 1) {

                const player = payload.players[i];

                for (const field of REQUIRED_PLAYER_FIELDS) {

                    if (!(field in player)) {

                        errors.push(`player_${i}_missing:${field}`);

                    }

                }

            }

        }

        // --- Clock state (required for non-terminal records) ---

        const isTerminal = RECOVERY_DATA_TERMINAL_STATUSES.includes(record.status);

        if (!isTerminal) {

            for (const field of REQUIRED_CLOCK_STATE_FIELDS) {

                if (!(field in payload)) {

                    errors.push(`clock_state_missing:${field}`);

                }

            }

        }

        // --- Terminal physics state (required for terminal records) ---

        if (isTerminal) {

            for (const field of REQUIRED_TERMINAL_PHYSICS_FIELDS) {

                if (payload[field] == null) {

                    errors.push(`terminal_physics_missing:${field}`);

                }

            }

        }

        // --- Financial authority duplication check ---

        for (const field of FORBIDDEN_FINANCIAL_AUTHORITY_FIELDS) {

            if (field in payload) {

                errors.push(`financial_authority_duplication:${field}`);

            }

        }

        return {
            valid: errors.length === 0,
            errors: Object.freeze(errors)
        };

    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * Validate a recovery data payload before persistence.
     * Throws on invalid data.
     *
     * @param {object} payload - The recovery data payload.
     * @throws {TonFinancialPersistenceError} If validation fails.
     */
    _validateRecoveryPayload(payload) {

        if (!payload || typeof payload !== "object") {

            throw new TonFinancialPersistenceError(
                "Recovery data payload must be a non-null object"
            );

        }

        // --- Recovery contract version ---

        if (typeof payload.recoveryContractVersion !== "number") {

            throw new TonFinancialPersistenceError(
                "Recovery data payload missing recoveryContractVersion"
            );

        }

        if (payload.recoveryContractVersion > MAX_SUPPORTED_RECOVERY_CONTRACT_VERSION) {

            throw new TonFinancialPersistenceError(
                `Recovery contract version ${payload.recoveryContractVersion} `
                    + `is incompatible (max supported: ${MAX_SUPPORTED_RECOVERY_CONTRACT_VERSION})`
            );

        }

        if (payload.recoveryContractVersion < 1) {

            throw new TonFinancialPersistenceError(
                `Recovery contract version ${payload.recoveryContractVersion} is invalid`
            );

        }

        // --- Schema version ---

        if (payload.schemaVersion !== TON_FINANCIAL_SCHEMA_VERSION) {

            throw new TonFinancialPersistenceError(
                `Schema version ${payload.schemaVersion} is incompatible `
                    + `(expected: ${TON_FINANCIAL_SCHEMA_VERSION})`
            );

        }

        // --- Identity fields ---

        for (const field of REQUIRED_IDENTITY_FIELDS) {

            if (payload[field] == null || payload[field] === "") {

                throw new TonFinancialPersistenceError(
                    `Recovery data payload missing required identity field: ${field}`
                );

            }

        }

        // --- Configuration fields ---

        for (const field of REQUIRED_CONFIGURATION_FIELDS) {

            if (payload[field] == null || payload[field] === "") {

                throw new TonFinancialPersistenceError(
                    `Recovery data payload missing required configuration field: ${field}`
                );

            }

        }

        // --- Configuration hash verification ---

        if (payload.configuration != null && payload.configurationHash != null) {

            const computedHash = computePayloadChecksum(payload.configuration);

            if (computedHash !== payload.configurationHash) {

                throw new TonFinancialPersistenceError(
                    "Recovery data payload configurationHash does not match configuration"
                );

            }

        }

        // --- Gameplay state fields ---

        for (const field of REQUIRED_GAMEPLAY_STATE_FIELDS) {

            if (payload[field] == null) {

                throw new TonFinancialPersistenceError(
                    `Recovery data payload missing required gameplay state field: ${field}`
                );

            }

        }

        // --- Players array ---

        if (!Array.isArray(payload.players)) {

            throw new TonFinancialPersistenceError(
                "Recovery data payload missing players array"
            );

        }

        if (payload.players.length === 0) {

            throw new TonFinancialPersistenceError(
                "Recovery data payload players array is empty"
            );

        }

        for (let i = 0; i < payload.players.length; i += 1) {

            const player = payload.players[i];

            for (const field of REQUIRED_PLAYER_FIELDS) {

                if (!(field in player)) {

                    throw new TonFinancialPersistenceError(
                        `Recovery data payload player ${i} missing field: ${field}`
                    );

                }

            }

        }

        // --- Financial authority duplication check ---

        for (const field of FORBIDDEN_FINANCIAL_AUTHORITY_FIELDS) {

            if (field in payload) {

                throw new TonFinancialPersistenceError(
                    `Recovery data payload must not duplicate financial authority field: ${field}`
                );

            }

        }

    }

    /**
     * Build envelope metadata from the recovery data payload.
     *
     * @param {object} payload - The recovery data payload.
     * @param {object} overrides - Metadata overrides from the caller.
     * @returns {object} Envelope metadata.
     */
    _buildEnvelopeMetadata(payload, overrides = {}) {

        return {
            recoveryRecordId: payload.recoveryRecordId,
            roomId: payload.roomId,
            gameId: payload.gameId,
            contractId: payload.contractId,
            tonNetwork: payload.tonNetwork,
            correlationId: payload.correlationId ?? overrides.correlationId ?? null,
            status: overrides.status ?? "ACTIVE",
            ...overrides
        };

    }

    _logInfo(message) {

        this._logger?.info?.(message);

    }

    _logError(message) {

        this._logger?.error?.(message);

    }

}

