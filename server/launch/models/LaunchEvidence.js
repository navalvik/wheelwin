/**
 * R8.0E — Immutable launch evidence with content hash.
 */

import { createHash } from "node:crypto";

import { GATE_STATUS } from "../LaunchConfiguration.js";

/**
 * Stable JSON for hashing (sorted keys, recursive).
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

    const json = JSON.stringify(canonicalize(payload));

    return createHash("sha256").update(json).digest("hex");

}

/**
 * @param {{
 *   id?: string,
 *   gate: string,
 *   status?: string,
 *   timestamp?: number,
 *   durationMs?: number,
 *   details?: object,
 *   recommendations?: string[]
 * }} input
 */
export function createLaunchEvidence(input) {

    const statusKey = String(input.status || GATE_STATUS.FAIL).toUpperCase();

    const status = GATE_STATUS[statusKey] ?? GATE_STATUS.FAIL;

    const timestamp = Number.isFinite(input.timestamp)
        ? input.timestamp
        : Date.now();

    const durationMs = Number.isFinite(input.durationMs)
        ? input.durationMs
        : 0;

    const details = Object.freeze({ ...(input.details ?? {}) });

    const recommendations = Object.freeze([...(input.recommendations ?? [])]);

    const gate = String(input.gate);

    // Hash excludes wall-clock fields so identical gate outcomes are reproducible.
    const evidenceHash = hashEvidencePayload({
        gate,
        status,
        details,
        recommendations
    });

    const id = input.id
        ? String(input.id)
        : `ev-${gate}-${evidenceHash.slice(0, 12)}`;

    return Object.freeze({
        id,
        gate,
        status,
        timestamp,
        durationMs,
        details,
        recommendations,
        evidenceHash
    });

}
