/**
 * R7.0D — Production logging subsystem tests.
 */

import assert from "node:assert/strict";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoggingManager } from "../logging/LoggingManager.js";
import { LogSanitizer } from "../logging/LogSanitizer.js";
import { JsonFormatter } from "../logging/formatters/JsonFormatter.js";
import { LogCorrelation } from "../logging/LogCorrelation.js";
import { RetentionPolicy } from "../logging/retention/RetentionPolicy.js";
import { LOG_CHANNELS, LOG_LEVELS, shouldEmit } from "../logging/levels.js";

function flush(ms = 20) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function reset() {

    LoggingManager.resetForTests();

}

// --- Level filtering ---
{
    assert.equal(shouldEmit(LOG_LEVELS.ERROR, LOG_LEVELS.INFO), true);

    assert.equal(shouldEmit(LOG_LEVELS.TRACE, LOG_LEVELS.INFO), false);

    assert.equal(shouldEmit(LOG_LEVELS.INFO, LOG_LEVELS.INFO), true);

    assert.equal(shouldEmit(LOG_LEVELS.DEBUG, LOG_LEVELS.WARN), false);

    console.log("  log level filtering: OK");
}

// --- JSON formatting ---
{
    const formatter = new JsonFormatter();

    const line = formatter.format({
        timestamp: "2026-01-01T00:00:00.000Z",
        level: "info",
        service: "test",
        message: "hello",
        traceId: "abc"
    });

    assert.equal(line.endsWith("\n"), true);

    const parsed = JSON.parse(line);

    assert.equal(parsed.message, "hello");

    assert.equal(parsed.traceId, "abc");

    console.log("  JSON formatting: OK");
}

// --- Secret redaction ---
{
    const sanitizer = new LogSanitizer();

    const message = sanitizer.sanitizeMessage("login password=hunter2 token=abc");

    assert.match(message, /\[redacted\]/);

    assert.doesNotMatch(message, /hunter2/);

    const fields = sanitizer.sanitizeFields({
        password: "secret",
        roomId: "ABC123"
    });

    assert.equal(fields.roomId, "ABC123");

    assert.equal(fields.password, "[redacted]");

    console.log("  secret redaction: OK");
}

// --- Correlation inheritance ---
{
    reset();

    const manager = LoggingManager.getInstance();

    manager.initialize({
        level: LOG_LEVELS.TRACE,
        enableConsole: false,
        enableFile: false,
        format: "json"
    });

    await LogCorrelation.withContext({ traceId: "trace-parent", roomId: "R1" }, async () => {

        manager.write({
            level: LOG_LEVELS.INFO,
            message: "child-log",
            fields: { gameId: "G1" }
        });

    });

    await flush();

    const recent = manager.getRecentRecords({ limit: 5 });

    assert.equal(recent.length >= 1, true);

    const last = recent[recent.length - 1];

    assert.equal(last.traceId, "trace-parent");

    assert.equal(last.roomId, "R1");

    assert.equal(last.gameId, "G1");

    console.log("  correlation inheritance: OK");
}

// --- Audit separation ---
{
    reset();

    const dir = mkdtempSync(join(tmpdir(), "ww-log-audit-"));

    const manager = LoggingManager.getInstance();

    manager.initialize({
        level: LOG_LEVELS.INFO,
        directory: dir,
        enableConsole: false,
        enableFile: true,
        format: "json",
        maxFileSizeMb: 5,
        maxFiles: 5,
        maxAgeDays: 7
    });

    manager.write({
        level: LOG_LEVELS.INFO,
        channel: LOG_CHANNELS.APPLICATION,
        message: "app-event"
    });

    manager.audit("developer login success", { username: "ops" });

    manager.flushSync();

    const appLog = readFileSync(join(dir, "application.log"), "utf8");

    const auditLog = readFileSync(join(dir, "audit.log"), "utf8");

    assert.match(appLog, /app-event/);

    assert.doesNotMatch(appLog, /developer login success/);

    assert.match(auditLog, /developer login success/);

    assert.doesNotMatch(auditLog, /app-event/);

    console.log("  audit separation: OK");
}

// --- Rotation trigger ---
{
    reset();

    const dir = mkdtempSync(join(tmpdir(), "ww-log-rot-"));

    const manager = LoggingManager.getInstance();

    manager.initialize({
        level: LOG_LEVELS.INFO,
        directory: dir,
        enableConsole: false,
        enableFile: true,
        format: "json",
        maxFileSizeMb: 0.0001, // ~100 bytes — force rotate quickly
        maxFiles: 20,
        maxAgeDays: 7
    });

    for (let i = 0; i < 40; i += 1) {

        manager.write({
            level: LOG_LEVELS.INFO,
            message: `rotation-line-${i}-${"x".repeat(40)}`
        });

    }

    manager.flushSync();

    const files = readdirSync(dir).filter((name) => name.startsWith("application"));

    assert.equal(files.length >= 2, true, "rotation should create archived files");

    const status = manager.getSafeStatus();

    assert.equal(status.rotationStatus, "enabled");

    assert.equal(status.activeLogFile, "application.log");

    assert.equal(status.level, LOG_LEVELS.INFO);

    // No absolute paths in safe status
    const statusJson = JSON.stringify(status);

    assert.doesNotMatch(statusJson, /ww-log-rot/);

    console.log("  rotation trigger: OK");
}

// --- Retention cleanup ---
{
    const dir = mkdtempSync(join(tmpdir(), "ww-log-ret-"));

    writeFileSync(join(dir, "application.log"), "active\n");

    writeFileSync(join(dir, "application.log.1001"), "old\n");

    writeFileSync(join(dir, "application.log.1002"), "old\n");

    const policy = new RetentionPolicy({
        directory: dir,
        activeFileNames: ["application.log", "audit.log"],
        maxFiles: 0,
        maxAgeDays: 1
    });

    const result = policy.cleanup();

    assert.equal(existsSync(join(dir, "application.log")), true);

    assert.equal(result.deleted.length >= 1, true);

    console.log("  retention cleanup: OK");
}

// --- Lifecycle logging via manager meta ---
{
    reset();

    const manager = LoggingManager.getInstance();

    manager.initialize({
        level: LOG_LEVELS.INFO,
        enableConsole: false,
        enableFile: false
    });

    manager.setLifecycleState("DRAINING");

    manager.audit("lifecycle RUNNING → DRAINING", {
        lifecycleState: "DRAINING",
        reason: "SIGTERM"
    });

    manager.flushSync();

    const audits = manager.getRecentRecords({ channel: LOG_CHANNELS.AUDIT });

    assert.equal(audits.length >= 1, true);

    assert.equal(audits[audits.length - 1].lifecycleState, "DRAINING");

    console.log("  lifecycle logging: OK");
}

reset();

console.log("productionLogging.test.js: OK");
