/**
 * R8.0D — Structured player feedback (observational).
 */

import {
    FEEDBACK_CATEGORIES,
    FEEDBACK_SEVERITY,
    FEEDBACK_STATUS
} from "../BetaConfiguration.js";

let _seq = 0;

function nextId() {

    _seq += 1;

    return `beta-f-${Date.now().toString(36)}-${_seq}`;

}

/**
 * @param {{
 *   id?: string,
 *   participantId?: string|null,
 *   category?: string,
 *   severity?: string,
 *   summary?: string,
 *   description?: string,
 *   reproductionSteps?: string|null,
 *   status?: string,
 *   timestamp?: number,
 *   rcVersion?: string|null
 * }} input
 */
export function createBetaFeedback(input = {}) {

    const category = FEEDBACK_CATEGORIES.includes(input.category)
        ? input.category
        : "Other";

    const severityKey = String(input.severity || "MEDIUM").toUpperCase();

    const severity = FEEDBACK_SEVERITY[severityKey]
        ?? FEEDBACK_SEVERITY.MEDIUM;

    const statusKey = String(input.status || "OPEN").toUpperCase();

    const status = FEEDBACK_STATUS[statusKey] ?? FEEDBACK_STATUS.OPEN;

    return Object.freeze({
        id: input.id ? String(input.id) : nextId(),
        participantId: input.participantId
            ? String(input.participantId).slice(0, 64)
            : null,
        timestamp: Number.isFinite(input.timestamp)
            ? input.timestamp
            : Date.now(),
        category,
        severity,
        summary: String(input.summary || "").slice(0, 200) || "Untitled",
        description: String(input.description || "").slice(0, 4000),
        reproductionSteps: input.reproductionSteps
            ? String(input.reproductionSteps).slice(0, 2000)
            : null,
        status,
        rcVersion: input.rcVersion
            ? String(input.rcVersion).slice(0, 64)
            : null
    });

}

/**
 * @param {ReturnType<typeof createBetaFeedback>} feedback
 * @param {object} patch
 */
export function withFeedbackPatch(feedback, patch) {

    return createBetaFeedback({
        ...feedback,
        ...patch
    });

}

export function resetFeedbackIdSequenceForTests() {

    _seq = 0;

}
