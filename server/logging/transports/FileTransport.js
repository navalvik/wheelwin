/**
 * R7.0D — File transport with size-based rotation.
 *
 * Writes run only from LoggingManager's async flush path (never on the
 * gameplay tick). appendFileSync keeps rotation/tests deterministic.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export class FileTransport {

    /**
     * @param {{
     *   filePath: string,
     *   formatter: { format: Function },
     *   maxFileSizeBytes: number,
     *   onRotate?: Function
     * }} options
     */
    constructor({
        filePath,
        formatter,
        maxFileSizeBytes,
        onRotate = null
    }) {

        this._filePath = filePath;

        this._formatter = formatter;

        this._maxFileSizeBytes = maxFileSizeBytes;

        this._onRotate = onRotate;

        this._bytesWritten = 0;

        this._enabled = true;

        this._ensureDirectory();

        this._refreshSize();

    }

    get filePath() {

        return this._filePath;

    }

    get activeFileName() {

        const parts = this._filePath.replace(/\\/g, "/").split("/");

        return parts[parts.length - 1] ?? "app.log";

    }

    write(record) {

        if (!this._enabled) {

            return;

        }

        const chunk = this._formatter.format(record);

        const size = Buffer.byteLength(chunk, "utf8");

        if (this._bytesWritten + size > this._maxFileSizeBytes
            && this._bytesWritten > 0) {

            this._rotate();

        }

        appendFileSync(this._filePath, chunk, "utf8");

        this._bytesWritten += size;

    }

    flush() {

        // appendFileSync is durable per write

    }

    close() {

        // no open handle

    }

    setEnabled(enabled) {

        this._enabled = enabled === true;

    }

    _ensureDirectory() {

        const dir = dirname(this._filePath);

        if (!existsSync(dir)) {

            mkdirSync(dir, { recursive: true });

        }

    }

    _refreshSize() {

        if (!existsSync(this._filePath)) {

            this._bytesWritten = 0;

            return;

        }

        try {

            this._bytesWritten = statSync(this._filePath).size;

        } catch {

            this._bytesWritten = 0;

        }

    }

    _rotate() {

        const rotatedPath = `${this._filePath}.${Date.now()}`;

        try {

            if (existsSync(this._filePath)) {

                renameSync(this._filePath, rotatedPath);

            }

        } catch {

            // continue appending if rename fails
        }

        this._bytesWritten = 0;

        if (typeof this._onRotate === "function") {

            try {

                this._onRotate(rotatedPath);

            } catch {

                // retention failures must not break logging
            }

        }

    }

}
