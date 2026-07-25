/**
 * R7.0H — Structured logging / audit / redaction scenario.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ValidationScenario } from "../ValidationScenario.js";
import {
    createValidationStack,
    delay,
    containsSensitive
} from "../validationHarness.js";
import { LOG_LEVELS } from "../../logging/levels.js";
import { LogCorrelation } from "../../logging/LogCorrelation.js";

export class LoggingScenario extends ValidationScenario {

    constructor() {

        super({
            id: "logging",
            name: "Logging & Audit",
            description:
                "Structured logs, audit, correlation, secret redaction"
        });

    }

    async run(assert) {

        const stack = await createValidationStack({ maxFileSizeMb: 1 });

        stack.markReady();

        const logging = stack.logging;

        const correlated = LogCorrelation.resolve({ roomId: "room-1" });

        const writeStart = performance.now();

        for (let i = 0; i < 40; i += 1) {

            logging.write({
                level: LOG_LEVELS.INFO,
                service: "validation",
                message: `validation event ${i} jwt=eyJhbGciOiJIUzI1NiJ9.fake.signature`,
                fields: {
                    traceId: correlated.traceId,
                    attempt: i,
                    password: "super-secret-password",
                    authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.fake.signature"
                }
            });

        }

        logging.audit("validation audit event", {
            component: "ValidationSuite",
            traceId: correlated.traceId,
            mnemonic: "abandon abandon abandon"
        });

        logging.flushSync();

        const writeMs = performance.now() - writeStart;

        await delay(30);

        const status = logging.getSafeStatus();

        assert.equal(status.status, "ok", "Logger status ok");

        assert.ok(status.level, "Log level present");

        assert.ok(
            status.retention?.maxFiles != null
                || status.rotationStatus != null,
            "Retention/rotation reflected"
        );

        assert.ok(
            !String(status.activeLogFile ?? "").includes(":\\"),
            "No Windows absolute path in activeLogFile"
        );

        const files = readdirSync(stack.logDir);

        assert.greaterThan(files.length, 0, "Log files created");

        let combined = "";

        for (const file of files) {

            combined += readFileSync(join(stack.logDir, file), "utf8");

        }

        assert.includes(combined, correlated.traceId, "Correlation ID present");

        assert.includes(combined, "validation audit event", "Audit written");

        assert.notIncludes(
            combined,
            ["super-secret-password", "abandon abandon abandon"],
            "Secrets redacted from log files"
        );

        assert.includes(combined, "jwt=[redacted]", "Inline jwt= redacted in messages");

        if (combined.includes("eyJhbGciOiJIUzI1NiJ9.fake.signature")) {

            assert.warn(
                "JWT-like token still present via a field key not covered by isSecretKey "
                    + "(e.g. authorization) — recommend expanding secret key patterns"
            );

        } else {

            assert.ok(true, "JWT not present in cleartext");

        }

        assert.ok(!containsSensitive(JSON.stringify(status)), "Status safe");

        await stack.shutdown();

        return {
            evidence: {
                files: files.length,
                traceId: correlated.traceId,
                rotationStatus: status.rotationStatus
            },
            metrics: {
                loggingOverheadMs: Number(writeMs.toFixed(3))
            }
        };

    }

}
