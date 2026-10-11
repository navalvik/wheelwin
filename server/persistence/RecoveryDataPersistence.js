/**
 * R17.9T.6-C — Recovery Data Contract persistence layer.
 *
 * Self-contained persistence for Recovery Data Contract records (post
 * financial-subsystem purge). Provides recovery-specific validation, version
 * compatibility checks, and fail-closed behavior for Recovery Data Contract
 * records.
 *
 * Scope limit:
 *   - ONLY durable persistence for Recovery Data Contract records.
 *   - NO gameplay reconstruction.
 *   - NO runtime manager recovery.
 *   - NO financial reconciliation logic.
 *   - NO financial fields (payment/settlement/wallet identities) are stored.
 */

import { createHash } from "node:crypto";

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
 * Terminal statuses that make a record immutable.
 */
export const RECOVERY_DATA_TERMINAL_STATUSES = Object.freeze([
    "TERMINAL"
]);

/**
 * Required identity fields in every recovery record payload.
 */
const REQUIRED_IDENTITY_FIELDS = Object.freeze([
    "recoveryRecordId",
    "roomId",
    "gameId"
]);

/**
 * Required configuration fields in every recovery record payload.
 */
const REQUIRED_CONFIGURATION_FIELDS = Object.freeze([
    "configuration",
    "configurationHash",
    "configurationVersion",
    "traceSeed"
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
    "nickname",
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
 * Local error types (fully self-contained persistence error family).
 */
export class RecoveryDataError extends Error {
    constructor(message) {
        super(message);
        this.name = "RecoveryDataError";
    }
}

export class RecordNotFoundError extends RecoveryDataError {
    constructor(recordId) {
        super(`Recovery data record not found: ${recordId}`);
        this.name = "RecordNotFoundError";
    }
}

export class ImmutableRecordError extends RecoveryDataError {
    constructor(recordId) {
        super(`Recovery data record is immutable (terminal): ${recordId}`);
        this.name = "ImmutableRecordError";
    }
}

export class CorruptedRecordError extends RecoveryDataError {
    constructor(recordId, reason) {
        super(`Recovery data record is corrupted: ${recordId} | ${reason}`);
        this.name = "CorruptedRecordError";
    }
}

/**
 * Compute a deterministic checksum for a payload (sha256 of stable JSON).
 *
 * @param {object} payload
 * @returns {string} Hex digest.
 */
export function computePayloadChecksum(payload) {
    return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

/**
 * @typedef {object} RecoveryDataPersistenceOptions
 * @property {object} [logger]
 */
export class RecoveryDataPersistence {

    /**
     * @param {RecoveryDataPersistenceOptions} options
     */
    constructor({ logger = null } = {}) {

        this._logger = logger;

        /** @type {Map<string, object>} */
        this._records = new Map();

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
     * @throws {RecoveryDataError} If validation fails.
     */
    createRecoveryRecord(recoveryData, metadata = {}) {

        this._validateRecoveryPayload(recoveryData);

        const recordId = recoveryData.recoveryRecordId;

        if (this._records.has(recordId)) {

            throw new RecoveryDataError(
                `Recovery data record already exists: ${recordId}`
            );

        }

        const status = metadata.status ?? "ACTIVE";

        const record = Object.freeze({
            recordId,
            status,
            immutable: RECOVERY_DATA_TERMINAL_STATUSES.includes(status),
            version: RECOVERY_CONTRACT_VERSION,
            checksum: computePayloadChecksum(recoveryData),
            payload: Object.freeze({ ...recoveryData }),
            metadata: Object.freeze({ ...metadata })
        });

        this._records.set(recordId, record);

        this._logInfo(`RecoveryDataPersistence: record created | id=${recordId}`);

        return record;

    }

    /**
     * Load a recovery data record by its record ID.
     *
     * @param {string} recordId - The recovery record ID (typically the gameId).
     * @returns {object|null} The loaded public record, or null if not found.
     * @throws {CorruptedRecordError} If the record is corrupted or invalid.
     */
    loadRecoveryRecord(recordId) {

        const record = this._records.get(recordId) ?? null;

        if (!record) {

            return null;

        }

        const validationResult = this.validateRecoveryRecord(record);

        if (!validationResult.valid) {

            throw new CorruptedRecordError(
                recordId,
                validationResult.errors.join(",")
            );

        }

        return record;

    }

    /**
     * List all active recovery data records.
     *
     * @returns {object[]} Array of valid public records. Invalid records are skipped.
     */
    listRecoveryRecords() {

        return [...this._records.values()].filter((record) => {

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
     * @throws {RecoveryDataError} If validation fails or the record is missing.
     */
    updateRecoveryRecord(recordId, recoveryData, metadata = {}) {

        this._validateRecoveryPayload(recoveryData);

        const existing = this._records.get(recordId);

        if (!existing) {

            throw new RecordNotFoundError(recordId);

        }

        if (existing.immutable) {

            throw new ImmutableRecordError(recordId);

        }

        const status = metadata.status ?? existing.status;

        const record = Object.freeze({
            recordId,
            status,
            immutable: RECOVERY_DATA_TERMINAL_STATUSES.includes(status),
            version: RECOVERY_CONTRACT_VERSION,
            checksum: computePayloadChecksum(recoveryData),
            payload: Object.freeze({ ...recoveryData }),
            metadata: Object.freeze({ ...existing.metadata, ...metadata })
        });

        this._records.set(recordId, record);

        return record;

    }

    /**
     * Validate a recovery record's integrity, version compatibility, and structure.
     *
     * @param {object} record - The public record.
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

        if (record.version !== RECOVERY_CONTRACT_VERSION) {

            errors.push(
                `schema_version_incompatible:${record.version}:${RECOVERY_CONTRACT_VERSION}`
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

            if (
                payload[field] == null
                || payload[field] === ""
            ) {

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

        return {
            valid: errors.length === 0,
            errors: Object.freeze(errors)
        };

    }

    /**
     * Validate a recovery data payload before persistence.
     * Throws on invalid data.
     *
     * @param {object} payload - The recovery data payload.
     * @throws {RecoveryDataError} If validation fails.
     */
    _validateRecoveryPayload(payload) {

        if (!payload || typeof payload !== "object") {

            throw new RecoveryDataError(
                "Recovery data payload must be a non-null object"
            );

        }

        // --- Recovery contract version ---

        if (typeof payload.recoveryContractVersion !== "number") {

            throw new RecoveryDataError(
                "Recovery data payload missing recoveryContractVersion"
            );

        }

        if (payload.recoveryContractVersion > MAX_SUPPORTED_RECOVERY_CONTRACT_VERSION) {

            throw new RecoveryDataError(
                `Recovery contract version ${payload.recoveryContractVersion} `
                    + `is incompatible (max supported: ${MAX_SUPPORTED_RECOVERY_CONTRACT_VERSION})`
            );

        }

        if (payload.recoveryContractVersion < 1) {

            throw new RecoveryDataError(
                `Recovery contract version ${payload.recoveryContractVersion} is invalid`
            );

        }

        // --- Identity fields ---

        for (const field of REQUIRED_IDENTITY_FIELDS) {

            if (payload[field] == null || payload[field] === "") {

                throw new RecoveryDataError(
                    `Recovery data payload missing required identity field: ${field}`
                );

            }

        }

        // --- Configuration fields ---

        for (const field of REQUIRED_CONFIGURATION_FIELDS) {

            if (payload[field] == null || payload[field] === "") {

                throw new RecoveryDataError(
                    `Recovery data payload missing required configuration field: ${field}`
                );

            }

        }

        // --- Configuration hash verification ---

        if (payload.configuration != null && payload.configurationHash != null) {

            const computedHash = computePayloadChecksum(payload.configuration);

            if (computedHash !== payload.configurationHash) {

                throw new RecoveryDataError(
                    "Recovery data payload configurationHash does not match configuration"
                );

            }

        }

        // --- Gameplay state fields ---

        for (const field of REQUIRED_GAMEPLAY_STATE_FIELDS) {

            if (payload[field] == null) {

                throw new RecoveryDataError(
                    `Recovery data payload missing required gameplay state field: ${field}`
                );

            }

        }

        // --- Players array ---

        if (!Array.isArray(payload.players)) {

            throw new RecoveryDataError(
                "Recovery data payload missing players array"
            );

        }

        if (payload.players.length === 0) {

            throw new RecoveryDataError(
                "Recovery data payload players array is empty"
            );

        }

        for (let i = 0; i < payload.players.length; i += 1) {

            const player = payload.players[i];

            for (const field of REQUIRED_PLAYER_FIELDS) {

                if (!(field in player)) {

                    throw new RecoveryDataError(
                        `Recovery data payload player ${i} missing field: ${field}`
                    );

                }

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