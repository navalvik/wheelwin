/**
 * R8.0B — SHA-256 checksum helpers.
 */

import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { finished } from "node:stream/promises";

export class ChecksumGenerator {

    /**
     * @param {string|Buffer} data
     * @returns {string} hex sha256
     */
    static hashBuffer(data) {

        return createHash("sha256").update(data).digest("hex");

    }

    /**
     * @param {string} filePath
     * @returns {Promise<string>}
     */
    static async hashFile(filePath) {

        const hash = createHash("sha256");

        const stream = createReadStream(filePath);

        stream.on("data", (chunk) => hash.update(chunk));

        await finished(stream);

        return hash.digest("hex");

    }

    /**
     * Deterministic hash of sorted "relativePath  hex" lines.
     * @param {Array<{ path: string, sha256: string }>} entries
     */
    static hashManifestEntries(entries) {

        const lines = [...entries]
            .map((e) => `${e.path}  ${e.sha256}`)
            .sort((a, b) => a.localeCompare(b))
            .join("\n");

        return this.hashBuffer(lines + (lines ? "\n" : ""));

    }

    /**
     * Write checksums file (sha256sum format).
     * @param {string} outputPath
     * @param {Array<{ path: string, sha256: string }>} entries
     */
    static writeChecksumFile(outputPath, entries) {

        const body = [...entries]
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((e) => `${e.sha256}  ${e.path}`)
            .join("\n") + "\n";

        writeFileSync(outputPath, body, "utf8");

        return body;

    }

    /**
     * Parse sha256sum-style file.
     * @param {string} filePath
     */
    static readChecksumFile(filePath) {

        const text = readFileSync(filePath, "utf8");

        const entries = [];

        for (const line of text.split(/\r?\n/)) {

            const trimmed = line.trim();

            if (!trimmed || trimmed.startsWith("#")) {

                continue;

            }

            const match = /^([a-f0-9]{64})\s+(\S+)$/i.exec(trimmed);

            if (match) {

                entries.push({ sha256: match[1].toLowerCase(), path: match[2] });

            }

        }

        return entries;

    }

}
