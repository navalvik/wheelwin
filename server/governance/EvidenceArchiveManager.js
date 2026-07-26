/**
 * R9.0C — Immutable evidence archive with retention metadata.
 */

import { createHash } from "node:crypto";

import {
    createAuditEvidence,
    hashEvidencePayload
} from "./models/AuditEvidence.js";

export class EvidenceArchiveManager {

    /**
     * @param {{
     *   retentionDays?: number,
     *   maxEntries?: number
     * }} [options]
     */
    constructor(options = {}) {

        this._retentionDays = options.retentionDays ?? 365;

        this._max = options.maxEntries ?? 500;

        /** @type {object[]} */
        this._entries = [];

    }

    clear() {

        this._entries = [];

    }

    count() {

        return this._entries.length;

    }

    list() {

        return [...this._entries].sort((a, b) => b.timestamp - a.timestamp);

    }

    /**
     * @param {{
     *   auditRefs?: string[],
     *   complianceRefs?: string[],
     *   operationalRefs?: object,
     *   reviewRefs?: string[],
     *   evidenceItems?: object[],
     *   label?: string
     * }} input
     */
    archive(input = {}) {

        const timestamp = Date.now();

        const evidenceItems = (input.evidenceItems ?? []).map((e) =>
            (e.evidenceHash
                ? e
                : createAuditEvidence({
                    source: e.source || "archive",
                    status: e.status || "OK",
                    details: e.details || {},
                    recommendations: e.recommendations || []
                }))
        );

        const body = {
            label: input.label || "governance-archive",
            auditRefs: [...(input.auditRefs ?? [])],
            complianceRefs: [...(input.complianceRefs ?? [])],
            operationalRefs: { ...(input.operationalRefs ?? {}) },
            reviewRefs: [...(input.reviewRefs ?? [])],
            evidenceHashes: evidenceItems.map((e) => e.evidenceHash)
        };

        const evidenceHash = hashEvidencePayload(body);

        const entry = Object.freeze({
            id: `arch-${evidenceHash.slice(0, 12)}`,
            timestamp,
            evidenceHash,
            auditRefs: Object.freeze([...(input.auditRefs ?? [])]),
            complianceRefs: Object.freeze([...(input.complianceRefs ?? [])]),
            operationalRefs: Object.freeze({
                ...(input.operationalRefs ?? {})
            }),
            reviewRefs: Object.freeze([...(input.reviewRefs ?? [])]),
            retentionDays: this._retentionDays,
            expiresAt: timestamp + (this._retentionDays * 24 * 60 * 60 * 1000),
            label: String(input.label || "governance-archive").slice(0, 128)
        });

        this._entries.push(entry);

        if (this._entries.length > this._max) {

            this._entries.splice(0, this._entries.length - this._max);

        }

        return entry;

    }

    /**
     * Observational prune of expired entries (does not affect runtime).
     */
    pruneExpired(now = Date.now()) {

        const before = this._entries.length;

        this._entries = this._entries.filter((e) => e.expiresAt > now);

        return before - this._entries.length;

    }

    getAggregateHash() {

        return createHash("sha256")
            .update(this._entries.map((e) => e.evidenceHash).join("|"))
            .digest("hex");

    }

    summary() {

        return Object.freeze({
            total: this._entries.length,
            retentionDays: this._retentionDays,
            aggregateHash: this.getAggregateHash(),
            latestHash: this._entries.length
                ? this._entries[this._entries.length - 1].evidenceHash
                : null
        });

    }

}
