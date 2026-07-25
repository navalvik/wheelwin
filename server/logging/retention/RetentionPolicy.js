/**
 * R7.0D — Log file retention (age + count). Never deletes the active file.
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";

export class RetentionPolicy {

    /**
     * @param {{
     *   directory: string,
     *   activeFileNames: string[],
     *   maxFiles: number,
     *   maxAgeDays: number
     * }} options
     */
    constructor({
        directory,
        activeFileNames,
        maxFiles,
        maxAgeDays
    }) {

        this._directory = directory;

        this._active = new Set(activeFileNames);

        this._maxFiles = maxFiles;

        this._maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

    }

    /**
     * @returns {{ deleted: string[], kept: number }}
     */
    cleanup() {

        let entries;

        try {

            entries = readdirSync(this._directory)
                .filter((name) => name.endsWith(".log") || /\.log\.\d+$/.test(name))
                .map((name) => {

                    const fullPath = join(this._directory, name);

                    let mtimeMs = 0;

                    try {

                        mtimeMs = statSync(fullPath).mtimeMs;

                    } catch {

                        mtimeMs = 0;

                    }

                    return { name, fullPath, mtimeMs };

                });

        } catch {

            return { deleted: [], kept: 0 };

        }

        const deleted = [];

        const now = Date.now();

        const inactive = entries.filter((entry) => !this._active.has(entry.name));

        // Age-based cleanup
        for (const entry of inactive) {

            if (this._maxAgeMs > 0 && now - entry.mtimeMs > this._maxAgeMs) {

                try {

                    unlinkSync(entry.fullPath);

                    deleted.push(entry.name);

                } catch {

                    // ignore
                }

            }

        }

        // Refresh list after age deletes
        const remaining = inactive
            .filter((entry) => !deleted.includes(entry.name))
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

        if (Number.isFinite(this._maxFiles)
            && this._maxFiles >= 0
            && remaining.length > this._maxFiles) {

            const overflow = remaining.slice(this._maxFiles);

            for (const entry of overflow) {

                try {

                    unlinkSync(entry.fullPath);

                    deleted.push(entry.name);

                } catch {

                    // ignore
                }

            }

        }

        return {
            deleted,
            kept: Math.max(0, inactive.length - deleted.length)
        };

    }

}
