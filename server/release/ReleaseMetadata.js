/**
 * R8.0B — Immutable release metadata.
 */

export class ReleaseMetadata {

    /**
     * @param {{
     *   version: string,
     *   channel: string,
     *   commit: string,
     *   branch: string,
     *   builtAt: string,
     *   nodeVersion: string,
     *   packageVersion: string,
     *   profile: string,
     *   fingerprint: string,
     *   globalChecksum: string,
     *   label: string,
     *   status?: string
     * }} input
     */
    constructor(input) {

        this.version = input.version;

        this.channel = input.channel;

        this.commit = input.commit;

        this.branch = input.branch;

        this.builtAt = input.builtAt;

        this.nodeVersion = input.nodeVersion;

        this.packageVersion = input.packageVersion;

        this.profile = input.profile;

        this.fingerprint = input.fingerprint;

        this.globalChecksum = input.globalChecksum;

        this.label = input.label;

        this.status = input.status ?? "built";

        Object.freeze(this);

    }

    toSafeSummary() {

        return Object.freeze({
            version: this.version,
            channel: this.channel,
            commit: this.commit,
            branch: this.branch,
            builtAt: this.builtAt,
            nodeVersion: this.nodeVersion,
            packageVersion: this.packageVersion,
            profile: this.profile,
            fingerprint: this.fingerprint,
            globalChecksum: this.globalChecksum,
            label: this.label,
            status: this.status
        });

    }

    toJSON() {

        return { ...this.toSafeSummary() };

    }

}
