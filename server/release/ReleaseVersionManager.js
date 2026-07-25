/**
 * R8.0B — Semantic version parsing / validation for releases.
 */

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export class ReleaseVersionManager {

    /**
     * @param {string} version
     * @returns {boolean}
     */
    static isValid(version) {

        return SEMVER_RE.test(String(version || "").trim());

    }

    /**
     * @param {string} version
     * @returns {{
     *   raw: string,
     *   major: number,
     *   minor: number,
     *   patch: number,
     *   prerelease: string|null,
     *   build: string|null,
     *   channelHint: string|null
     * }}
     */
    static parse(version) {

        const raw = String(version || "").trim();

        const match = SEMVER_RE.exec(raw);

        if (!match) {

            throw new Error(`Invalid semantic version: ${version}`);

        }

        const prerelease = match[4] ?? null;

        let channelHint = null;

        if (prerelease) {

            const lower = prerelease.toLowerCase();

            if (lower.startsWith("rc")) {

                channelHint = "rc";

            } else if (lower.startsWith("beta")) {

                channelHint = "beta";

            } else if (lower.startsWith("alpha") || lower.startsWith("internal")) {

                channelHint = "internal";

            }

        } else {

            channelHint = "production";

        }

        return {
            raw,
            major: Number(match[1]),
            minor: Number(match[2]),
            patch: Number(match[3]),
            prerelease,
            build: match[5] ?? null,
            channelHint
        };

    }

    /**
     * Build directory / artifact label from version + channel.
     */
    static buildLabel(version, channel) {

        const safeVersion = String(version).replace(/[^0-9A-Za-z.+-]/g, "_");

        const safeChannel = String(channel || "development").toLowerCase();

        return `wheelwin-${safeVersion}-${safeChannel}`;

    }

}
