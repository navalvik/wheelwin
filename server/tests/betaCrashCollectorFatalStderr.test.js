import assert from "node:assert/strict";

import { BetaCrashCollector } from "../beta/BetaCrashCollector.js";

const collector = new BetaCrashCollector();
let stderrOutput = "";
let exitCode = null;
const originalWrite = process.stderr.write;
const originalExit = process.exit;

try {
    process.stderr.write = (chunk) => {
        stderrOutput += String(chunk);
        return true;
    };
    process.exit = (code) => {
        exitCode = code;
    };

    collector.installProcessHandlers();
    const handler = process.listeners("uncaughtException").at(-1);
    assert.equal(typeof handler, "function", "uncaught exception handler is installed");

    handler(new Error("boom secret=supersecret token:abc"));

    assert.equal(exitCode, 1, "fatal uncaught exception preserves exit code 1");
    assert.ok(stderrOutput.includes("[WHEELWIN_FATAL_UNCAUGHT_EXCEPTION]"), "fatal report is synchronously written to stderr");
    assert.ok(stderrOutput.includes("uncaughtException"), "fatal report identifies the exception kind");
    assert.ok(stderrOutput.includes("[REDACTED]"), "sensitive fields are redacted before persistence");
    assert.ok(!stderrOutput.includes("supersecret"), "secret value is not written to stderr");
    assert.ok(!stderrOutput.includes("token:abc"), "token value is not written to stderr");
    assert.equal(collector.count(), 1, "crash report remains available in memory until process exit");

    console.log("betaCrashCollectorFatalStderr.test.js: all passed");
} finally {
    collector.uninstallProcessHandlers();
    process.stderr.write = originalWrite;
    process.exit = originalExit;
}
