/**
 * R9.0A — Immutable release announcement metadata (no external notify).
 */

import { createHash } from "node:crypto";

import { canonicalize } from "./models/ProductionEvidence.js";

export class ReleaseAnnouncementManager {

    constructor() {

        this._latest = null;

    }

    /**
     * @param {{
     *   version?: string|null,
     *   channel?: string|null,
     *   commit?: string|null,
     *   fingerprint?: string|null,
     *   certificationRef?: string|null,
     *   verificationRef?: string|null,
     *   lifecycle?: string|null,
     *   releasedAt?: number
     * }} input
     */
    announce(input = {}) {

        const releasedAt = Number.isFinite(input.releasedAt)
            ? input.releasedAt
            : Date.now();

        const body = {
            version: input.version ?? null,
            channel: input.channel ?? "production",
            commit: input.commit ?? null,
            fingerprint: input.fingerprint ?? null,
            certificationRef: input.certificationRef ?? null,
            verificationRef: input.verificationRef ?? null,
            lifecycle: input.lifecycle ?? null,
            releasedAt
        };

        const announcementHash = createHash("sha256")
            .update(JSON.stringify(canonicalize(body)))
            .digest("hex");

        this._latest = Object.freeze({
            ...body,
            announcementHash
        });

        return this._latest;

    }

    getLatest() {

        return this._latest;

    }

}
