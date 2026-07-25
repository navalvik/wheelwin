/**
 * R7.0D — Coordinates rotation callbacks + retention cleanup.
 */

import { RetentionPolicy } from "./retention/RetentionPolicy.js";

export class LogRotationManager {

    constructor({
        directory,
        activeFileNames,
        maxFiles,
        maxAgeDays
    }) {

        this._policy = new RetentionPolicy({
            directory,
            activeFileNames,
            maxFiles,
            maxAgeDays
        });

        this._lastCleanupAt = null;

        this._lastDeleted = 0;

        this._rotationCount = 0;

    }

    onRotated() {

        this._rotationCount += 1;

        return this.cleanup();

    }

    cleanup() {

        const result = this._policy.cleanup();

        this._lastCleanupAt = Date.now();

        this._lastDeleted = result.deleted.length;

        return result;

    }

    getStatus() {

        return {
            rotationCount: this._rotationCount,
            lastCleanupAt: this._lastCleanupAt,
            lastDeleted: this._lastDeleted
        };

    }

}
