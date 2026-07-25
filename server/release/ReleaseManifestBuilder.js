/**
 * R8.0B — ReleaseManifest.json builder.
 */

export class ReleaseManifestBuilder {

    /**
     * @param {{
     *   metadata: import("./ReleaseMetadata.js").ReleaseMetadata,
     *   artifacts: Array<{ path: string, sha256: string, bytes: number, kind: string }>,
     *   documentation: string[],
     *   checksumsFile: string,
     *   notesFile: string,
     *   compatibility?: object
     * }} input
     */
    static build(input) {

        const metadata = input.metadata;

        return Object.freeze({
            schemaVersion: 1,
            version: metadata.version,
            channel: metadata.channel,
            label: metadata.label,
            status: metadata.status,
            compatibility: Object.freeze({
                node: input.compatibility?.node ?? ">=18",
                serverAuthoritative: true,
                ...(input.compatibility ?? {})
            }),
            artifacts: Object.freeze(
                input.artifacts.map((a) => Object.freeze({ ...a }))
            ),
            documentation: Object.freeze([...(input.documentation ?? [])]),
            checksums: Object.freeze({
                algorithm: "sha256",
                file: input.checksumsFile,
                global: metadata.globalChecksum
            }),
            notes: input.notesFile,
            build: Object.freeze({
                commit: metadata.commit,
                branch: metadata.branch,
                builtAt: metadata.builtAt,
                nodeVersion: metadata.nodeVersion,
                packageVersion: metadata.packageVersion,
                profile: metadata.profile,
                fingerprint: metadata.fingerprint
            }),
            visibility: Object.freeze({
                channel: metadata.channel,
                public: metadata.channel === "production"
                    || metadata.channel === "beta",
                preRelease: metadata.channel === "rc"
                    || metadata.channel === "beta"
                    || metadata.channel === "internal"
                    || metadata.channel === "development"
            })
        });

    }

}
