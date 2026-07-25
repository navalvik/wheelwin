/**
 * R8.0B — Deterministic build fingerprint.
 */

import { ChecksumGenerator } from "./ChecksumGenerator.js";

export class BuildFingerprint {

    /**
     * @param {{
     *   version: string,
     *   commit: string,
     *   channel: string,
     *   profile: string,
     *   artifactHashes: Array<{ path: string, sha256: string }>,
     *   nodeVersion?: string
     * }} input
     * @returns {string} hex fingerprint
     */
    static generate(input) {

        const payload = {
            version: input.version,
            commit: input.commit || "unknown",
            channel: input.channel,
            profile: input.profile || "unknown",
            nodeVersion: input.nodeVersion || process.version,
            artifacts: [...(input.artifactHashes ?? [])]
                .map((e) => ({ path: e.path, sha256: e.sha256 }))
                .sort((a, b) => a.path.localeCompare(b.path))
        };

        // Stable JSON (sorted keys via replacer order in object literals above).
        const canonical = JSON.stringify(payload);

        return ChecksumGenerator.hashBuffer(canonical);

    }

}
