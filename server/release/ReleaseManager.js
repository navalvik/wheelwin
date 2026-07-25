/**
 * R8.0B — Central release coordinator (build + runtime metadata).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { ReleaseBuilder } from "./ReleaseBuilder.js";
import { ReleaseMetadata } from "./ReleaseMetadata.js";
import { RELEASE_CHANNEL, isValidReleaseChannel } from "./releaseTypes.js";
import { LoggingManager } from "../logging/LoggingManager.js";
import { LOG_LEVELS } from "../logging/levels.js";

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ReleaseManager {

    static _instance = null;

    constructor() {

        this._config = null;

        this._current = null;

        this._lastBuild = null;

        this._repoRoot = resolve(__dirname, "../..");

    }

    static getInstance() {

        if (!ReleaseManager._instance) {

            ReleaseManager._instance = new ReleaseManager();

        }

        return ReleaseManager._instance;

    }

    static resetForTests() {

        ReleaseManager._instance = null;

    }

    /**
     * @param {{
     *   channel?: string,
     *   outputDirectory?: string,
     *   signingEnabled?: boolean,
     *   generateChecksums?: boolean,
     *   includeDocs?: boolean,
     *   includeReports?: boolean,
     *   version?: string,
     *   commit?: string,
     *   branch?: string,
     *   profile?: string,
     *   repoRoot?: string
     * }} config
     */
    initialize(config = {}) {

        const pkg = this._readPackageVersion();

        const channel = String(
            config.channel || RELEASE_CHANNEL.DEVELOPMENT
        ).toLowerCase();

        this._config = {
            channel: isValidReleaseChannel(channel)
                ? channel
                : RELEASE_CHANNEL.DEVELOPMENT,
            outputDirectory: config.outputDirectory
                || join(this._repoRoot, "release"),
            signingEnabled: config.signingEnabled === true,
            generateChecksums: config.generateChecksums !== false,
            includeDocs: config.includeDocs !== false,
            includeReports: config.includeReports !== false,
            version: config.version || pkg,
            commit: config.commit
                || process.env.GIT_COMMIT
                || process.env.COMMIT_SHA
                || "unknown",
            branch: config.branch
                || process.env.GIT_BRANCH
                || "unknown",
            profile: config.profile || "development",
            packageVersion: pkg
        };

        if (config.repoRoot) {

            this._repoRoot = config.repoRoot;

        }

        this._current = this._loadLatestMetadata() ?? new ReleaseMetadata({
            version: this._config.version,
            channel: this._config.channel,
            commit: this._config.commit,
            branch: this._config.branch,
            builtAt: null,
            nodeVersion: process.version,
            packageVersion: this._config.packageVersion,
            profile: this._config.profile,
            fingerprint: "unbuilt",
            globalChecksum: "unbuilt",
            label: `wheelwin-${this._config.version}-${this._config.channel}`,
            status: "runtime"
        });

        return this;

    }

    isInitialized() {

        return this._config != null;

    }

    getConfig() {

        return this._config ? { ...this._config } : null;

    }

    /**
     * Run full release package pipeline.
     */
    async createRelease(overrides = {}) {

        if (!this._config) {

            this.initialize(overrides);

        }

        const cfg = { ...this._config, ...overrides };

        this._log("info", "Release started", {
            version: cfg.version,
            channel: cfg.channel
        });

        const builder = new ReleaseBuilder({
            repoRoot: this._repoRoot,
            outputDirectory: cfg.outputDirectory,
            version: cfg.version,
            channel: cfg.channel,
            profile: cfg.profile,
            commit: cfg.commit,
            branch: cfg.branch,
            packageVersion: cfg.packageVersion,
            includeDocs: cfg.includeDocs,
            includeReports: cfg.includeReports,
            generateChecksums: cfg.generateChecksums,
            onEvent: (event, fields) => {

                const level = event === "release_verified" && fields?.ok === false
                    ? "warn"
                    : "info";

                this._log(level, `Release ${event}`, fields);

            }
        });

        const result = await builder.build();

        if (result.ok) {

            this._lastBuild = result;

            this._current = result.metadata;

            this._log("info", "Release completed", {
                version: result.metadata.version,
                fingerprint: result.metadata.fingerprint,
                releaseRoot: result.releaseRoot
            });

        } else {

            this._log("warn", "Release failed", {
                errors: result.errors
            });

        }

        return result;

    }

    getSafeStatus() {

        const meta = this._current?.toSafeSummary?.() ?? null;

        return Object.freeze({
            initialized: this.isInitialized(),
            channel: this._config?.channel ?? null,
            outputDirectoryConfigured: Boolean(this._config?.outputDirectory),
            generateChecksums: this._config?.generateChecksums !== false,
            includeDocs: this._config?.includeDocs !== false,
            signingEnabled: this._config?.signingEnabled === true,
            version: meta?.version ?? this._config?.version ?? null,
            commit: meta?.commit ?? this._config?.commit ?? null,
            branch: meta?.branch ?? this._config?.branch ?? null,
            builtAt: meta?.builtAt ?? null,
            fingerprint: meta?.fingerprint ?? null,
            status: meta?.status ?? null,
            profile: meta?.profile ?? this._config?.profile ?? null,
            label: meta?.label ?? null
        });

    }

    getCurrentMetadata() {

        return this._current;

    }

    getLastBuild() {

        return this._lastBuild;

    }

    _readPackageVersion() {

        try {

            const pkg = require("../package.json");

            return pkg.version || "0.0.0";

        } catch {

            return "0.0.0";

        }

    }

    _loadLatestMetadata() {

        // Optional: load from RELEASE_METADATA_PATH env for runtime display
        const path = process.env.RELEASE_METADATA_PATH;

        if (!path || !existsSync(path)) {

            return null;

        }

        try {

            const json = JSON.parse(readFileSync(path, "utf8"));

            return new ReleaseMetadata({
                version: json.version,
                channel: json.channel,
                commit: json.commit,
                branch: json.branch,
                builtAt: json.builtAt,
                nodeVersion: json.nodeVersion || process.version,
                packageVersion: json.packageVersion || json.version,
                profile: json.profile || "unknown",
                fingerprint: json.fingerprint,
                globalChecksum: json.globalChecksum || "unknown",
                label: json.label || `wheelwin-${json.version}`,
                status: json.status || "verified"
            });

        } catch {

            return null;

        }

    }

    _log(level, message, fields) {

        const manager = LoggingManager.getInstance();

        if (!manager.isInitialized()) {

            return;

        }

        const mapped = level === "warn" ? LOG_LEVELS.WARN : LOG_LEVELS.INFO;

        manager.write({
            level: mapped,
            service: "wheelwin-release",
            message,
            fields
        });

    }

}

export { RELEASE_CHANNEL, RELEASE_CHANNELS } from "./releaseTypes.js";
