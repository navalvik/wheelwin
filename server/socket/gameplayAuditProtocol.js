import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_MESSAGE_CHANNEL } from "./events.js";

// Authoritative audit lifecycle statuses forwarded to clients for display only.
// Clients never generate audit records — they render exactly what arrives here.
export const AUDIT_CLIENT_STATUS = Object.freeze({
    STARTED: "STARTED",
    READY: "READY",
    FAILED: "FAILED"
});

export const AUDIT_STATUS_MESSAGE_TYPES = Object.freeze({
    [EVENT_TYPES.AUDIT_STARTED]: "AUDIT_STARTED",
    [EVENT_TYPES.AUDIT_READY]: "AUDIT_READY",
    [EVENT_TYPES.AUDIT_FAILED]: "AUDIT_FAILED"
});

const EVENT_TO_STATUS = Object.freeze({
    [EVENT_TYPES.AUDIT_STARTED]: AUDIT_CLIENT_STATUS.STARTED,
    [EVENT_TYPES.AUDIT_READY]: AUDIT_CLIENT_STATUS.READY,
    [EVENT_TYPES.AUDIT_FAILED]: AUDIT_CLIENT_STATUS.FAILED
});

export function isForwardableAuditEvent(eventType) {

    return Boolean(AUDIT_STATUS_MESSAGE_TYPES[eventType]);

}

export function mapAuditStatus(eventType) {

    return EVENT_TO_STATUS[eventType] ?? null;

}

/**
 * Builds the client audit-status payload. It carries only authoritative facts
 * copied verbatim from the audit event; the client performs no calculation.
 */
export function buildAuditStatusPayload(eventType, auditPayload) {

    const payload = {
        gameId: auditPayload?.gameId ?? null,
        status: EVENT_TO_STATUS[eventType] ?? null,
        auditId: auditPayload?.auditId ?? null,
        serverTimestamp: auditPayload?.timestamp ?? Date.now()
    };

    // R6.4 — forward the authoritative Game Report on AUDIT_READY only.
    if (
        eventType === EVENT_TYPES.AUDIT_READY
        && auditPayload?.gameReport
    ) {

        payload.gameReport = auditPayload.gameReport;

    }

    return payload;

}

export function buildAuditStatusMessage(eventType, auditPayload) {

    return {
        channel: GAME_MESSAGE_CHANNEL,
        message: {
            type: AUDIT_STATUS_MESSAGE_TYPES[eventType],
            payload: buildAuditStatusPayload(eventType, auditPayload)
        }
    };

}
