/**
 * R8.0D — Closed Beta participant record (no PII beyond opaque tester id).
 */

import {
    PARTICIPANT_APPROVAL,
    PARTICIPANT_TAGS
} from "../BetaConfiguration.js";

let _seq = 0;

function nextId() {

    _seq += 1;

    return `beta-p-${Date.now().toString(36)}-${_seq}`;

}

/**
 * @param {{
 *   id?: string,
 *   invitationCode?: string,
 *   displayLabel?: string,
 *   tags?: string[],
 *   approvalStatus?: string,
 *   invitedAt?: number,
 *   registeredAt?: number|null,
 *   approvedAt?: number|null,
 *   activatedAt?: number|null,
 *   lastActivityAt?: number|null,
 *   notes?: string|null
 * }} input
 */
export function createBetaParticipant(input = {}) {

    const tags = Array.isArray(input.tags)
        ? input.tags
            .map((t) => String(t).trim().toLowerCase())
            .filter((t) => PARTICIPANT_TAGS.includes(t))
        : [];

    const approvalStatus = PARTICIPANT_APPROVAL[input.approvalStatus]
        ? input.approvalStatus
        : (PARTICIPANT_APPROVAL[String(input.approvalStatus || "").toUpperCase()]
            ?? PARTICIPANT_APPROVAL.INVITED);

    const participant = Object.freeze({
        id: input.id ? String(input.id) : nextId(),
        invitationCode: input.invitationCode
            ? String(input.invitationCode).slice(0, 64)
            : null,
        displayLabel: input.displayLabel
            ? String(input.displayLabel).slice(0, 64)
            : "tester",
        tags: Object.freeze([...new Set(tags)]),
        approvalStatus,
        invitedAt: Number.isFinite(input.invitedAt)
            ? input.invitedAt
            : Date.now(),
        registeredAt: Number.isFinite(input.registeredAt)
            ? input.registeredAt
            : null,
        approvedAt: Number.isFinite(input.approvedAt)
            ? input.approvedAt
            : null,
        activatedAt: Number.isFinite(input.activatedAt)
            ? input.activatedAt
            : null,
        lastActivityAt: Number.isFinite(input.lastActivityAt)
            ? input.lastActivityAt
            : null,
        notes: input.notes ? String(input.notes).slice(0, 256) : null
    });

    return participant;

}

/**
 * @param {ReturnType<typeof createBetaParticipant>} participant
 * @param {object} patch
 */
export function withParticipantPatch(participant, patch) {

    return createBetaParticipant({
        ...participant,
        tags: patch.tags ?? [...participant.tags],
        ...patch
    });

}

export function resetParticipantIdSequenceForTests() {

    _seq = 0;

}
