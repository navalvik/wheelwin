/**
 * R7.0D — Central logging entry point (application + audit).
 *
 * Asynchronous enqueue so gameplay loops are never blocked by disk I/O.
 */

import { join } from "node:path";

import {
    LOG_CHANNELS,
    LOG_FORMATS,
    LOG_LEVELS,
    normalizeLogLevel,
    shouldEmit
} from "./levels.js";
import { LogSanitizer } from "./LogSanitizer.js";
import { LogCorrelation } from "./LogCorrelation.js";
import { LoggerFactory } from "./LoggerFactory.js";
import { JsonFormatter } from "./formatters/JsonFormatter.js";
import { ConsoleFormatter } from "./formatters/ConsoleFormatter.js";
import { ConsoleTransport } from "./transports/ConsoleTransport.js";
import { FileTransport } from "./transports/FileTransport.js";
import { LogRotationManager } from "./LogRotationManager.js";

const DEFAULT_RECENT_BUFFER = 200;

export class LoggingManager {

    static _instance = null;

    constructor() {

        this._initialized = false;

        this._config = null;

        this._sanitizer = new LogSanitizer();

        this._factory = new LoggerFactory(this);

        this._consoleTransport = null;

        this._appFileTransport = null;

        this._auditFileTransport = null;

        this._rotationManager = null;

        this._queue = [];

        this._flushScheduled = false;

        this._recent = [];

        this._subscribers = new Set();

        this._meta = {
            environment: "development",
            profile: "development",
            version: "unknown",
            lifecycleState: null
        };

        this._stats = {
            written: 0,
            dropped: 0,
            lastError: null
        };

    }

    static getInstance() {

        if (!LoggingManager._instance) {

            LoggingManager._instance = new LoggingManager();

        }

        return LoggingManager._instance;

    }

    static resetForTests() {

        if (LoggingManager._instance) {

            LoggingManager._instance.shutdown();

        }

        LoggingManager._instance = null;

    }

    /**
     * @param {{
     *   level: string,
     *   directory?: string|null,
     *   maxFileSizeMb?: number,
     *   maxFiles?: number,
     *   maxAgeDays?: number,
     *   format?: string,
     *   enableConsole?: boolean,
     *   enableFile?: boolean,
     *   environment?: string,
     *   profile?: string,
     *   version?: string,
     *   recentBufferSize?: number
     * }} config
     */
    initialize(config) {

        if (this._initialized) {

            this.shutdown();

        }

        this._config = {
            level: normalizeLogLevel(config.level, LOG_LEVELS.INFO),
            directory: config.directory || null,
            maxFileSizeMb: Number(config.maxFileSizeMb) > 0
                ? Number(config.maxFileSizeMb)
                : 10,
            maxFiles: Number(config.maxFiles) > 0 ? Number(config.maxFiles) : 10,
            maxAgeDays: Number(config.maxAgeDays) > 0
                ? Number(config.maxAgeDays)
                : 14,
            format: config.format === LOG_FORMATS.CONSOLE
                ? LOG_FORMATS.CONSOLE
                : LOG_FORMATS.JSON,
            enableConsole: config.enableConsole !== false,
            enableFile: config.enableFile === true && Boolean(config.directory),
            recentBufferSize: Number(config.recentBufferSize) > 0
                ? Number(config.recentBufferSize)
                : DEFAULT_RECENT_BUFFER
        };

        this._meta.environment = config.environment || "development";

        this._meta.profile = config.profile || "development";

        this._meta.version = config.version || "unknown";

        const consoleFormatter = this._config.format === LOG_FORMATS.CONSOLE
            ? new ConsoleFormatter()
            : new JsonFormatter();

        this._consoleTransport = new ConsoleTransport({
            formatter: consoleFormatter
        });

        this._consoleTransport.setEnabled(this._config.enableConsole);

        if (this._config.enableFile) {

            const maxBytes = this._config.maxFileSizeMb * 1024 * 1024;

            const jsonFormatter = new JsonFormatter();

            const appPath = join(this._config.directory, "application.log");

            const auditPath = join(this._config.directory, "audit.log");

            this._rotationManager = new LogRotationManager({
                directory: this._config.directory,
                activeFileNames: ["application.log", "audit.log"],
                maxFiles: this._config.maxFiles,
                maxAgeDays: this._config.maxAgeDays
            });

            const onRotate = () => this._rotationManager.onRotated();

            this._appFileTransport = new FileTransport({
                filePath: appPath,
                formatter: jsonFormatter,
                maxFileSizeBytes: maxBytes,
                onRotate
            });

            this._auditFileTransport = new FileTransport({
                filePath: auditPath,
                formatter: jsonFormatter,
                maxFileSizeBytes: maxBytes,
                onRotate
            });

            this._rotationManager.cleanup();

        }

        this._initialized = true;

        return this;

    }

    isInitialized() {

        return this._initialized === true;

    }

    getFactory() {

        return this._factory;

    }

    setLifecycleState(state) {

        this._meta.lifecycleState = state ?? null;

    }

    setMinimumLevel(level) {

        if (!this._config) {

            return;

        }

        this._config.level = normalizeLogLevel(level, this._config.level);

    }

    /**
     * Structured write — primary API.
     */
    write({
        level,
        channel = LOG_CHANNELS.APPLICATION,
        service = "wheelwin-server",
        message,
        fields = {},
        error = null
    }) {

        if (!this._initialized) {

            // Bootstrap fallback before initialize — never throw.
            process.stderr.write(`${message}\n`);

            return;

        }

        if (!shouldEmit(level, this._config.level)) {

            this._stats.dropped += 1;

            return;

        }

        const correlated = LogCorrelation.resolve(fields);

        const sanitizedFields = this._sanitizer.sanitizeFields(correlated);

        const record = {
            timestamp: new Date().toISOString(),
            level,
            channel,
            service,
            message: this._sanitizer.sanitizeMessage(message),
            traceId: sanitizedFields.traceId,
            environment: this._meta.environment,
            profile: this._meta.profile,
            version: this._meta.version,
            lifecycleState: this._meta.lifecycleState
                ?? sanitizedFields.lifecycleState
                ?? null
        };

        for (const key of [
            "roomId",
            "gameId",
            "playerId",
            "contractId",
            "paymentId",
            "setupSessionId",
            "resultSessionId",
            "recoveryId",
            "simulationId"
        ]) {

            if (sanitizedFields[key] != null) {

                record[key] = sanitizedFields[key];

            }

        }

        // Extra non-id fields (excluding ones already copied)
        for (const [key, value] of Object.entries(sanitizedFields)) {

            if (record[key] !== undefined || key === "traceId"
                || key === "lifecycleState") {

                continue;

            }

            record[key] = value;

        }

        if (error) {

            record.error = this._sanitizer.sanitizeError(error);

        }

        this._enqueue(Object.freeze(record));

    }

    audit(message, fields = {}, level = LOG_LEVELS.INFO) {

        this.write({
            level,
            channel: LOG_CHANNELS.AUDIT,
            service: "wheelwin-audit",
            message,
            fields
        });

    }

    /**
     * R7.20C — Architectural decision trace (Developer Log + Railway stdout).
     * High-level lifecycle decisions only — not low-level forensics.
     *
     * @param {{
     *   stage: string,
     *   decision: string,
     *   reason: string,
     *   caller: string,
     *   nextAction: string,
     *   roomId?: string|null,
     *   gameId?: string|null,
     *   level?: string
     * }} params
     */
    decisionTrace({
        stage,
        decision,
        reason,
        caller,
        nextAction,
        roomId = null,
        gameId = null,
        level = LOG_LEVELS.INFO
    }) {

        const message = [
            "==================================================",
            "DECISION TRACE",
            "==================================================",
            `Stage: ${stage ?? "unknown"}`,
            `Decision: ${decision ?? "unknown"}`,
            `Reason: ${reason ?? "unspecified"}`,
            `Caller: ${caller ?? "unknown"}`,
            `Next Action: ${nextAction ?? "none"}`,
            "=================================================="
        ].join(" | ");

        this.write({
            level,
            channel: LOG_CHANNELS.APPLICATION,
            service: "DECISION_TRACE",
            message,
            fields: {
                category: "DECISION_TRACE",
                stage: stage ?? null,
                decision: decision ?? null,
                reason: reason ?? null,
                caller: caller ?? null,
                nextAction: nextAction ?? null,
                roomId: roomId ?? null,
                gameId: gameId ?? null
            }
        });

    }

    subscribe(handler) {

        if (typeof handler === "function") {

            this._subscribers.add(handler);

        }

        return () => this._subscribers.delete(handler);

    }

    getRecentRecords({ channel = null, limit = 100 } = {}) {

        let list = this._recent;

        if (channel) {

            list = list.filter((entry) => entry.channel === channel);

        }

        return list.slice(Math.max(0, list.length - limit));

    }

    /**
     * Safe health / console status — no absolute filesystem paths.
     */
    getSafeStatus() {

        const rotation = this._rotationManager?.getStatus?.() ?? {
            rotationCount: 0,
            lastCleanupAt: null,
            lastDeleted: 0
        };

        return Object.freeze({
            status: this._initialized ? "ok" : "stopped",
            level: this._config?.level ?? null,
            format: this._config?.format ?? null,
            consoleEnabled: this._config?.enableConsole === true,
            fileEnabled: this._config?.enableFile === true,
            activeLogFile: this._config?.enableFile
                ? "application.log"
                : null,
            activeAuditFile: this._config?.enableFile ? "audit.log" : null,
            rotationStatus: this._config?.enableFile ? "enabled" : "disabled",
            rotationCount: rotation.rotationCount,
            retention: Object.freeze({
                maxFiles: this._config?.maxFiles ?? null,
                maxAgeDays: this._config?.maxAgeDays ?? null,
                lastCleanupAt: rotation.lastCleanupAt,
                lastDeleted: rotation.lastDeleted
            }),
            stats: Object.freeze({ ...this._stats })
        });

    }

    flushSync() {

        this._flush();

        this._consoleTransport?.flush?.();

        this._appFileTransport?.flush?.();

        this._auditFileTransport?.flush?.();

    }

    shutdown() {

        this.flushSync();

        this._appFileTransport?.close?.();

        this._auditFileTransport?.close?.();

        this._appFileTransport = null;

        this._auditFileTransport = null;

        this._consoleTransport = null;

        this._rotationManager = null;

        this._subscribers.clear();

        this._initialized = false;

    }

    _enqueue(record) {

        this._queue.push(record);

        if (!this._flushScheduled) {

            this._flushScheduled = true;

            setImmediate(() => this._flush());

        }

    }

    _flush() {

        this._flushScheduled = false;

        if (this._queue.length === 0) {

            return;

        }

        const batch = this._queue;

        this._queue = [];

        for (const record of batch) {

            try {

                this._consoleTransport?.write(record);

                if (record.channel === LOG_CHANNELS.AUDIT) {

                    this._auditFileTransport?.write(record);

                } else {

                    this._appFileTransport?.write(record);

                }

                this._pushRecent(record);

                this._stats.written += 1;

                for (const handler of this._subscribers) {

                    try {

                        handler(record);

                    } catch {

                        // subscriber faults must not break logging
                    }

                }

            } catch (error) {

                this._stats.lastError = error?.message ?? "log_write_failed";

            }

        }

    }

    _pushRecent(record) {

        this._recent.push(record);

        const max = this._config?.recentBufferSize ?? DEFAULT_RECENT_BUFFER;

        if (this._recent.length > max) {

            this._recent.splice(0, this._recent.length - max);

        }

    }

}
