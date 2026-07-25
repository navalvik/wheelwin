/**
 * R8.0C — In-memory / filesystem certification registry.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class CertificationRegistry {

    /**
     * @param {{ storageDirectory?: string|null }} [options]
     */
    constructor({ storageDirectory = null } = {}) {

        this._storageDirectory = storageDirectory;

        this._latest = null;

        this._byFingerprint = new Map();

    }

    register(certificate) {

        const frozen = Object.freeze({ ...certificate });

        this._latest = frozen;

        if (frozen.fingerprint) {

            this._byFingerprint.set(frozen.fingerprint, frozen);

        }

        if (this._storageDirectory) {

            mkdirSync(this._storageDirectory, { recursive: true });

            writeFileSync(
                join(this._storageDirectory, "ReleaseCertificate.json"),
                JSON.stringify(frozen, null, 2) + "\n",
                "utf8"
            );

        }

        return frozen;

    }

    getLatest() {

        return this._latest;

    }

    getByFingerprint(fingerprint) {

        return this._byFingerprint.get(fingerprint) ?? null;

    }

    loadFromDisk() {

        if (!this._storageDirectory) {

            return null;

        }

        const path = join(this._storageDirectory, "ReleaseCertificate.json");

        if (!existsSync(path)) {

            return null;

        }

        try {

            const json = JSON.parse(readFileSync(path, "utf8"));

            return this.register(json);

        } catch {

            return null;

        }

    }

}
