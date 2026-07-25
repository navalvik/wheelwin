/**
 * R8.0B — Artifact packaging into release/ tree.
 */

import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { ChecksumGenerator } from "./ChecksumGenerator.js";

const IGNORE_DIR_NAMES = new Set([
    "node_modules",
    ".git",
    "logs",
    "coverage",
    "dist-ssr",
    ".cursor",
    "_node_modules"
]);

export class ReleaseArtifactManager {

    /**
     * @param {{
     *   repoRoot: string,
     *   outputRoot: string,
     *   includeDocs?: boolean,
     *   includeReports?: boolean
     * }} options
     */
    constructor(options) {

        this._repoRoot = options.repoRoot;

        this._outputRoot = options.outputRoot;

        this._includeDocs = options.includeDocs !== false;

        this._includeReports = options.includeReports !== false;

    }

    ensureLayout() {

        for (const dir of [
            "server",
            "client",
            "documentation",
            "manifests",
            "checksums",
            "release-notes"
        ]) {

            mkdirSync(join(this._outputRoot, dir), { recursive: true });

        }

    }

    /**
     * Package server sources (excluding node_modules / logs).
     * @returns {Promise<Array<{ path: string, absolutePath: string, bytes: number, kind: string }>>}
     */
    async packageServer() {

        const source = join(this._repoRoot, "server");

        const target = join(this._outputRoot, "server");

        this._copyFiltered(source, target, (rel) => {

            const parts = rel.split(/[/\\]/);

            if (parts.some((p) => IGNORE_DIR_NAMES.has(p))) {

                return false;

            }

            const base = parts[parts.length - 1] ?? "";

            if (base === ".env" || /^\.env\.(local|production|staging)$/i.test(base)) {

                return false;

            }

            return true;

        });

        // Marker describing package
        writeFileSync(
            join(target, "ARTIFACT.json"),
            JSON.stringify({
                kind: "server",
                note: "Server source package for release (node_modules excluded)"
            }, null, 2),
            "utf8"
        );

        return this._listFiles(target, "server", "server");

    }

    /**
     * Package client dist if present, else client source snapshot.
     */
    async packageClient() {

        const dist = join(this._repoRoot, "client", "dist");

        const target = join(this._outputRoot, "client");

        let mode = "source";

        if (existsSync(dist) && statSync(dist).isDirectory()) {

            cpSync(dist, join(target, "dist"), { recursive: true });

            mode = "dist";

        } else {

            const source = join(this._repoRoot, "client");

            this._copyFiltered(source, join(target, "source"), (rel) => {

                const parts = rel.split(/[/\\]/);

                if (parts.some((p) => IGNORE_DIR_NAMES.has(p))) {

                    return false;

                }

                return true;

            });

        }

        writeFileSync(
            join(target, "ARTIFACT.json"),
            JSON.stringify({
                kind: "client",
                mode
            }, null, 2),
            "utf8"
        );

        return this._listFiles(target, "client", "client");

    }

    /**
     * Copy documentation + optional validation reports.
     */
    async packageDocumentation() {

        const docs = [];

        if (!this._includeDocs) {

            return docs;

        }

        const docRoot = join(this._repoRoot, "docs");

        const target = join(this._outputRoot, "documentation");

        if (existsSync(docRoot)) {

            this._copyFiltered(docRoot, target, () => true);

        }

        const publicDocs = join(this._repoRoot, "client", "public", "docs");

        if (existsSync(publicDocs)) {

            cpSync(publicDocs, join(target, "product"), { recursive: true });

        }

        if (this._includeReports) {

            const arch = join(this._repoRoot, "docs", "architecture");

            if (existsSync(arch)) {

                const reports = readdirSync(arch)
                    .filter((f) => /Validation|Report/i.test(f) && f.endsWith(".md"));

                mkdirSync(join(target, "reports"), { recursive: true });

                for (const file of reports) {

                    copyFileSync(
                        join(arch, file),
                        join(target, "reports", file)
                    );

                }

            }

        }

        return this._listFiles(target, "documentation", "documentation");

    }

    /**
     * @param {Array<{ path: string, absolutePath: string, bytes: number, kind: string }>} files
     */
    async hashArtifacts(files) {

        const hashed = [];

        for (const file of files) {

            const sha256 = await ChecksumGenerator.hashFile(file.absolutePath);

            hashed.push({
                path: file.path.replace(/\\/g, "/"),
                absolutePath: file.absolutePath,
                bytes: file.bytes,
                kind: file.kind,
                sha256
            });

        }

        return hashed;

    }

    _copyFiltered(fromDir, toDir, acceptRel) {

        if (!existsSync(fromDir)) {

            mkdirSync(toDir, { recursive: true });

            return;

        }

        const walk = (dir) => {

            for (const entry of readdirSync(dir, { withFileTypes: true })) {

                const abs = join(dir, entry.name);

                const rel = relative(fromDir, abs);

                if (!acceptRel(rel)) {

                    continue;

                }

                if (entry.isDirectory()) {

                    walk(abs);

                } else if (entry.isFile()) {

                    const dest = join(toDir, rel);

                    mkdirSync(dirname(dest), { recursive: true });

                    copyFileSync(abs, dest);

                }

            }

        };

        walk(fromDir);

    }

    _listFiles(absoluteRoot, relativeRoot, kind) {

        const out = [];

        const walk = (dir) => {

            if (!existsSync(dir)) {

                return;

            }

            for (const entry of readdirSync(dir, { withFileTypes: true })) {

                const abs = join(dir, entry.name);

                if (entry.isDirectory()) {

                    walk(abs);

                } else if (entry.isFile()) {

                    const rel = join(relativeRoot, relative(absoluteRoot, abs))
                        .replace(/\\/g, "/");

                    out.push({
                        path: rel,
                        absolutePath: abs,
                        bytes: statSync(abs).size,
                        kind
                    });

                }

            }

        };

        walk(absoluteRoot);

        return out;

    }

}
