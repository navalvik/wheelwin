/**
 * T2.1 — TonFinancialPersistence record envelope utilities.
 */

import { createHash, randomUUID } from "node:crypto";

import {
    IMMUTABLE_ON_CREATE_TYPES,
    SETTLEMENT_TERMINAL_STATUSES,
    TON_FINANCIAL_RECORD_TYPES,
    TON_FINANCIAL_SCHEMA_VERSION
} from "./TonFinancialRecordTypes.js";

const REQUIRED_METADATA_FIELDS = Object.freeze([
    "createdAt",
    "updatedAt",
    "version",
    "status",
    "correlationId",
    "roomId",
    "gameId",
    "contractId",
    "tonNetwork"
]);

export function stableStringify(value) {

    if (value === null || typeof value !== "object") {

        return JSON.stringify(value);

    }

    if (Array.isArray(value)) {

        return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;

    }

    const keys = Object.keys(value).sort();

    return `{${keys.map((key) => (
        `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;

}

export function computePayloadChecksum(payload) {

    return createHash("sha256")
        .update(stableStringify(payload ?? {}))
        .digest("hex");

}

export function resolveRecordId(recordType, payload, metadata = {}) {

    switch (recordType) {

        case TON_FINANCIAL_RECORD_TYPES.GAME_CONTRACT:
        case TON_FINANCIAL_RECORD_TYPES.ARCHIVED_CONTRACT:
            return metadata.contractId
                ?? payload?.contractId
                ?? null;

        case TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION:
            return metadata.paymentSessionId
                ?? payload?.paymentSessionId
                ?? null;

        case TON_FINANCIAL_RECORD_TYPES.WALLET_SESSION:
            return metadata.roomId
                ?? payload?.roomId
                ?? null;

        case TON_FINANCIAL_RECORD_TYPES.SETTLEMENT:
            return metadata.settlementId
                ?? metadata.gameId
                ?? payload?.gameId
                ?? null;

        case TON_FINANCIAL_RECORD_TYPES.SNAPSHOT:
            return metadata.snapshotId
                ?? payload?.snapshotHash
                ?? payload?.gameId
                ?? null;

        case TON_FINANCIAL_RECORD_TYPES.RECOVERY_CHECKPOINT:
            return metadata.checkpointId
                ?? payload?.checkpointId
                ?? randomUUID();

        case TON_FINANCIAL_RECORD_TYPES.AUDIT:
            return metadata.auditId
                ?? payload?.auditId
                ?? randomUUID();

        default:
            return metadata.recordId ?? null;

    }

}

export function buildRecordEnvelope({
    recordType,
    recordId,
    payload,
    metadata = {},
    immutable = null
}) {

    const now = Date.now();

    const envelope = {
        recordType,
        recordId,
        createdAt: metadata.createdAt ?? now,
        updatedAt: metadata.updatedAt ?? now,
        version: metadata.version ?? TON_FINANCIAL_SCHEMA_VERSION,
        status: metadata.status ?? payload?.status ?? "ACTIVE",
        correlationId: metadata.correlationId ?? null,
        roomId: metadata.roomId ?? payload?.roomId ?? null,
        gameId: metadata.gameId ?? payload?.gameId ?? null,
        contractId: metadata.contractId ?? payload?.contractId ?? null,
        tonNetwork: metadata.tonNetwork ?? payload?.tonNetwork ?? null,
        immutable: immutable ?? isImmutableRecord(recordType, metadata.status ?? payload?.status),
        payload: payload ?? {}
    };

    envelope.checksum = computePayloadChecksum(envelope.payload);

    return Object.freeze(envelope);

}

export function isImmutableRecord(recordType, status = null) {

    if (IMMUTABLE_ON_CREATE_TYPES.includes(recordType)) {

        return true;

    }

    if (recordType === TON_FINANCIAL_RECORD_TYPES.SETTLEMENT) {

        return SETTLEMENT_TERMINAL_STATUSES.includes(status);

    }

    return false;

}

export function validateRecordEnvelope(envelope) {

    const errors = [];

    if (!envelope || typeof envelope !== "object") {

        return ["envelope_missing"];

    }

    if (!envelope.recordType) {

        errors.push("recordType_missing");

    }

    if (!envelope.recordId) {

        errors.push("recordId_missing");

    }

    for (const field of REQUIRED_METADATA_FIELDS) {

        if (!(field in envelope)) {

            errors.push(`metadata_missing:${field}`);

        }

    }

    if (envelope.version !== TON_FINANCIAL_SCHEMA_VERSION) {

        errors.push(`schema_version_mismatch:${envelope.version}`);

    }

    const expectedChecksum = computePayloadChecksum(envelope.payload);

    if (envelope.checksum !== expectedChecksum) {

        errors.push("checksum_mismatch");

    }

    return errors;

}

export function cloneEnvelopeForUpdate(existing, {
    payload,
    metadata = {}
}) {

    const nextStatus = metadata.status ?? existing.status;

    const next = {
        ...existing,
        ...metadata,
        status: nextStatus,
        payload: payload ?? existing.payload,
        updatedAt: Date.now(),
        immutable: isImmutableRecord(existing.recordType, nextStatus)
    };

    next.checksum = computePayloadChecksum(next.payload);

    return Object.freeze(next);

}
