/**
 * R9.0C — Immutable audit evidence with content hash.
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
 *   source: string,
 *   status?: string,
 *   timestamp?: number,
 *   details?: object,
 *   recommendations?: string[]
 * }} input
 */
export function createAuditEvidence(input) {

    const source = String(input.source);

    const status = String(input.status || "OK").slice(0, 32);

    const details = Object.freeze({ ...(input.details ?? {}) });

    const recommendations = Object.freeze([...(input.recommendations ?? [])]);

    const evidenceHash = hashEvidencePayload({
        source,
        status,
        details,
        recommendations
    });

    const id = input.id
        ? String(input.id)
        : `gev-${source}-${evidenceHash.slice(0, 12)}`;

    return Object.freeze({
        id,
        source,
        status,
        timestamp: Number.isFinite(input.timestamp)
            ? input.timestamp
            : Date.now(),
        details,
        recommendations,
        evidenceHash
    });

}
