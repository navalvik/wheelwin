/**
 * R9.0B — Immutable operational evidence.
 */

import { createHash } from "node:crypto";

/**
 * @param {unknown} value
 */
export function canonicalize(value) {

    if (value === null || typeof value !== "object") {

        return value;

    }

    if (Array.isArray(value)) {

        return value.map((v) => canonicalize(v));

    }

    const out = {};

    for (const key of Object.keys(value).sort()) {

        out[key] = canonicalize(value[key]);

    }

    return out;

}

/**
 * @param {object} payload
 */
export function hashEvidencePayload(payload) {

    return createHash("sha256")
        .update(JSON.stringify(canonicalize(payload)))
        .digest("hex");

}

/**
 * @param {{
 *   id?: string,
 *   operation: string,
 *   status?: string,
 *   timestamp?: number,
 *   metricsSnapshot?: object,
 *   recommendations?: string[]
 * }} input
 */
export function createOperationalEvidence(input) {

    const timestamp = Number.isFinite(input.timestamp)
        ? input.timestamp
        : Date.now();

    const operation = String(input.operation);

    const status = String(input.status || "OK").slice(0, 32);

    const metricsSnapshot = Object.freeze({
        ...(input.metricsSnapshot ?? {})
    });

    const recommendations = Object.freeze([
        ...(input.recommendations ?? [])
    ]);

    const evidenceHash = hashEvidencePayload({
        operation,
        status,
        metricsSnapshot,
        recommendations
    });

    const id = input.id
        ? String(input.id)
        : `oe-${operation}-${evidenceHash.slice(0, 12)}`;

    return Object.freeze({
        id,
        operation,
        status,
        timestamp,
        metricsSnapshot,
        recommendations,
        evidenceHash
    });

}
