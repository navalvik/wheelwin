/**
 * R9.0B — Version lifecycle tracking.
 */

import { VERSION_SUPPORT_STATUS } from "./OperationsConfiguration.js";
import {
    createServiceVersion,
    withServiceVersionPatch
} from "./models/ServiceVersion.js";

export class VersionLifecycleManager {

    /**
     * @param {{ supportWindowDays?: number }} [options]
     */
    constructor(options = {}) {

        this._supportWindowDays = options.supportWindowDays ?? 90;

        /** @type {Map<string, ReturnType<typeof createServiceVersion>>} */
        this._versions = new Map();

        this._activeVersion = null;

    }

    clear() {

        this._versions.clear();

        this._activeVersion = null;

    }

    list() {

        return [...this._versions.values()];

    }

    getActive() {

        return this._activeVersion
            ? this._versions.get(this._activeVersion) ?? null
            : null;

    }

    /**
     * @param {{
     *   version: string,
     *   releaseTimestamp?: number,
     *   gaTimestamp?: number,
     *   activate?: boolean
     * }} input
     */
    register(input) {

        const version = createServiceVersion({
            version: input.version,
            releaseTimestamp: input.releaseTimestamp ?? Date.now(),
            gaTimestamp: input.gaTimestamp ?? null,
            supportStatus: input.activate === false
                ? VERSION_SUPPORT_STATUS.SUPPORTED
                : VERSION_SUPPORT_STATUS.ACTIVE
        });

        if (input.activate !== false) {

            this._demoteActiveToSupported();

            this._activeVersion = version.version;

        }

        this._versions.set(version.version, version);

        return version;

    }

    activate(versionId) {

        const existing = this._versions.get(versionId);

        if (!existing) {

            throw new Error(`Unknown version: ${versionId}`);

        }

        this._demoteActiveToSupported();

        const updated = withServiceVersionPatch(existing, {
            supportStatus: VERSION_SUPPORT_STATUS.ACTIVE,
            gaTimestamp: existing.gaTimestamp ?? Date.now(),
            retirementStatus: false
        });

        this._versions.set(versionId, updated);

        this._activeVersion = versionId;

        return updated;

    }

    deprecate(versionId) {

        return this._setStatus(versionId, VERSION_SUPPORT_STATUS.DEPRECATED);

    }

    retire(versionId) {

        const updated = this._setStatus(
            versionId,
            VERSION_SUPPORT_STATUS.RETIRED,
            { retirementStatus: true }
        );

        if (this._activeVersion === versionId) {

            this._activeVersion = null;

        }

        return updated;

    }

    /**
     * Auto-deprecate versions older than support window (relative to active GA).
     */
    applySupportWindow(now = Date.now()) {

        const windowMs = this._supportWindowDays * 24 * 60 * 60 * 1000;

        const active = this.getActive();

        const anchor = active?.gaTimestamp
            ?? active?.releaseTimestamp
            ?? now;

        for (const [id, version] of this._versions) {

            if (id === this._activeVersion) {

                continue;

            }

            if (version.supportStatus === VERSION_SUPPORT_STATUS.RETIRED) {

                continue;

            }

            const ts = version.releaseTimestamp ?? version.gaTimestamp;

            if (ts != null && (anchor - ts) > windowMs) {

                this._versions.set(
                    id,
                    withServiceVersionPatch(version, {
                        supportStatus: VERSION_SUPPORT_STATUS.DEPRECATED
                    })
                );

            }

        }

        return this.summary();

    }

    summary() {

        const byStatus = Object.create(null);

        for (const s of Object.values(VERSION_SUPPORT_STATUS)) {

            byStatus[s] = 0;

        }

        for (const v of this._versions.values()) {

            byStatus[v.supportStatus] = (byStatus[v.supportStatus] ?? 0) + 1;

        }

        return Object.freeze({
            total: this._versions.size,
            activeVersion: this._activeVersion,
            byStatus: Object.freeze({ ...byStatus }),
            versions: Object.freeze(
                this.list().map((v) => Object.freeze({
                    version: v.version,
                    supportStatus: v.supportStatus,
                    retirementStatus: v.retirementStatus
                }))
            )
        });

    }

    _demoteActiveToSupported() {

        if (!this._activeVersion) {

            return;

        }

        const current = this._versions.get(this._activeVersion);

        if (!current) {

            return;

        }

        this._versions.set(
            this._activeVersion,
            withServiceVersionPatch(current, {
                supportStatus: VERSION_SUPPORT_STATUS.SUPPORTED
            })
        );

    }

    _setStatus(versionId, supportStatus, extra = {}) {

        const existing = this._versions.get(versionId);

        if (!existing) {

            throw new Error(`Unknown version: ${versionId}`);

        }

        const updated = withServiceVersionPatch(existing, {
            supportStatus,
            ...extra
        });

        this._versions.set(versionId, updated);

        return updated;

    }

}
