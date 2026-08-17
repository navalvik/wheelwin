/**
 * R17.9J.2C — Owner Fee Percent 0.01 precision validation + persistence.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RuntimeConfigurationService } from "../console/configuration/RuntimeConfigurationService.js";
import { validateRuntimeConfigurationPatch } from "../console/configuration/validateRuntimeConfigurationPatch.js";
import { readRuntimeConfigurationAudit } from "../console/configuration/runtimeConfigurationAuditStore.js";

test("R17.9J.2C ownerFeePercent accepts 0.01 precision values", () => {

    for (const value of [0, 0.01, 4.99, 5, 5.00, 5.15, 7.37, 100]) {

        const result = validateRuntimeConfigurationPatch({
            ownerFeePercent: value
        });

        assert.equal(result.ok, true, `expected valid: ${value}`);
        assert.equal(result.patch.ownerFeePercent, Number(value));

    }

});

test("R17.9J.2C ownerFeePercent rejects invalid range and precision", () => {

    for (const value of [-1, 100.01, 5.123, "abc"]) {

        const result = validateRuntimeConfigurationPatch({
            ownerFeePercent: value
        });

        assert.equal(result.ok, false, `expected invalid: ${value}`);

    }

});

test("R17.9J.2C persists decimal ownerFeePercent and audits it", () => {

    const dir = mkdtempSync(join(tmpdir(), "ww-runtime-fee-"));

    const env = {
        RUNTIME_CONFIGURATION_STATE_PATH: join(dir, "runtime-configuration.json"),
        RUNTIME_CONFIGURATION_AUDIT_PATH: join(dir, "runtime-configuration-audit.jsonl")
    };

    const service = new RuntimeConfigurationService({ env });

    service.initialize();

    const result = service.update({
        ownerFeePercent: 5.15
    }, {
        username: "admin",
        role: "Administrator"
    });

    assert.equal(result.ok, true);

    const persisted = JSON.parse(
        readFileSync(env.RUNTIME_CONFIGURATION_STATE_PATH, "utf8")
    );

    assert.equal(persisted.values.ownerFeePercent, 5.15);

    const reloaded = new RuntimeConfigurationService({ env });

    reloaded.initialize();

    assert.equal(reloaded.getState().values.ownerFeePercent, 5.15);

    const audit = readRuntimeConfigurationAudit({ limit: 20 }, env);

    assert.ok(audit.some((row) => row.event === "RUNTIME_CONFIG_CHANGED"
        && row.parameter === "ownerFeePercent"
        && row.newValue === 5.15
        && row.user === "admin"));

    rmSync(dir, { recursive: true, force: true });

});
