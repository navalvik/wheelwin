/**
 * T2.1 — TonFinancialPersistence error types.
 */

export class TonFinancialPersistenceError extends Error {

    constructor(message, code = "PERSISTENCE_ERROR", details = null) {

        super(message);

        this.name = "TonFinancialPersistenceError";

        this.code = code;

        this.details = details ?? null;

    }

}

export class RecordNotFoundError extends TonFinancialPersistenceError {

    constructor(recordType, recordId) {

        super(
            `Financial record not found | type=${recordType} | id=${recordId}`,
            "RECORD_NOT_FOUND",
            { recordType, recordId }
        );

        this.name = "RecordNotFoundError";

    }

}

export class VersionMismatchError extends TonFinancialPersistenceError {

    constructor(recordType, recordId, expected, actual) {

        super(
            `Financial record version mismatch | type=${recordType} | id=${recordId}`,
            "VERSION_MISMATCH",
            { recordType, recordId, expected, actual }
        );

        this.name = "VersionMismatchError";

    }

}

export class IntegrityFailureError extends TonFinancialPersistenceError {

    constructor(message, details = null) {

        super(message, "INTEGRITY_FAILURE", details);

        this.name = "IntegrityFailureError";

    }

}

export class DuplicateRecordError extends TonFinancialPersistenceError {

    constructor(recordType, recordId) {

        super(
            `Financial record already exists | type=${recordType} | id=${recordId}`,
            "DUPLICATE_RECORD",
            { recordType, recordId }
        );

        this.name = "DuplicateRecordError";

    }

}

export class CorruptedRecordError extends TonFinancialPersistenceError {

    constructor(recordType, recordId, reason) {

        super(
            `Financial record corrupted | type=${recordType} | id=${recordId} | reason=${reason}`,
            "CORRUPTED_RECORD",
            { recordType, recordId, reason }
        );

        this.name = "CorruptedRecordError";

    }

}

export class ImmutableRecordError extends TonFinancialPersistenceError {

    constructor(recordType, recordId) {

        super(
            `Financial record is immutable | type=${recordType} | id=${recordId}`,
            "IMMUTABLE_RECORD",
            { recordType, recordId }
        );

        this.name = "ImmutableRecordError";

    }

}

export class RecoveryFailureError extends TonFinancialPersistenceError {

    constructor(message, details = null) {

        super(message, "RECOVERY_FAILURE", details);

        this.name = "RecoveryFailureError";

    }

}

export class StorageUnavailableError extends TonFinancialPersistenceError {

    constructor(message, cause = null) {

        super(message, "STORAGE_UNAVAILABLE", {
            cause: cause?.message ?? null
        });

        this.name = "StorageUnavailableError";

    }

}
