/**
 * R17.9G.1 — Runtime configuration validation + persistence smoke tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RuntimeConfigurationService } from "../console/configuration/RuntimeConfigurationService.js";
import { buildRuntimeConfigurationSnapshot } from "../console/configuration/buildRuntimeConfigurationSnapshot.js";
import { validateRuntimeConfigurationPatch } from "../console/configuration/validateRuntimeConfigurationPatch.js";
import { readRuntimeConfigurationAudit } from "../console/configuration/runtimeConfigurationAuditStore.js";

test("R17.9G.1 validate rejects invalid fee and non-positive timers", () => {

    const fee = validateRuntimeConfigurationPatch({
        ownerFeePercent: 150
    });

    assert.equal(fee.ok, false);

    const timer = validateRuntimeConfigurationPatch({
        setupTimeoutMs: 0
    });

    assert.equal(timer.ok, false);

    const verify = validateRuntimeConfigurationPatch({
        setupTimeoutMs: 1000,
        verifyTimeoutMs: 1000
    });

    assert.equal(verify.ok, false);

});

test("R17.9G.1 validate accepts editable timer and financial patch", () => {

    const result = validateRuntimeConfigurationPatch({
        setupTimeoutMs: 120000,
        paymentTimeoutMs: 90000,
        countdownDurationMs: 4000,
        brakeDurationMs: 7000,
        settlementTimeoutMs: 600000,
        baseStake1Gram: 1,
        baseStake2Gram: 10,
        ownerFeePercent: 7
    });

    assert.equal(result.ok, true);
    assert.equal(result.patch.ownerFeePercent, 7);
    assert.equal(result.patch.setupTimeoutMs, 120000);

});

test("R17.9G.1 viewer snapshot redacts editable values", () => {

    const dto = buildRuntimeConfigurationSnapshot({
        runtimeConfig: {
            rooms: { setupDurationMs: 300000, paymentSessionDurationMs: 300000 },
            gameplayPhases: { readyDurationMs: 3000, brakeDurationMs: 6000 },
            ton: { network: "testnet" }
        },
        canEdit: false,
        overrides: { ownerFeePercent: 7 }
    });

    assert.equal(dto.canEdit, false);
    assert.equal(dto.timers, null);
    assert.equal(dto.financial, null);
    assert.ok(dto.wallets);

});

test("R17.9G.1 admin snapshot includes settlement timeout and verify inherits setup", () => {

    const dto = buildRuntimeConfigurationSnapshot({
        runtimeConfig: {
            rooms: { setupDurationMs: 300000, paymentSessionDurationMs: 300000 },
            gameplayPhases: { readyDurationMs: 3000, brakeDurationMs: 6000 },
            ton: { network: "testnet" }
        },
        canEdit: true,
        overrides: {
            setupTimeoutMs: 120000,
            settlementTimeoutMs: 480000,
            ownerFeePercent: 7
        },
        configVersion: 3
    });

    assert.equal(dto.canEdit, true);
    assert.equal(dto.timers.setupTimeoutMs, 120000);
    assert.equal(dto.timers.verifyTimeoutMs, 120000);
    assert.equal(dto.timers.verifyEditable, false);
    assert.equal(dto.timers.settlementTimeoutMs, 480000);
    assert.equal(dto.financial.ownerFeePercent, 7);
    assert.equal(dto.configVersion, 3);
    assert.equal(dto.applyScope, "next_game_initialization_only");

});

test("R17.9G.1 service persists versioned values and writes audit records", () => {

    const dir = mkdtempSync(join(tmpdir(), "ww-runtime-config-"));

    const env = {
        RUNTIME_CONFIGURATION_STATE_PATH: join(dir, "runtime-configuration.json"),
        RUNTIME_CONFIGURATION_AUDIT_PATH: join(dir, "runtime-configuration-audit.jsonl")
    };

    const applied = [];

    const service = new RuntimeConfigurationService({
        env,
        applyAdapters: {
            setSetupDurationMs: (ms) => applied.push(["setup", ms]),
            setPaymentDurationMs: (ms) => applied.push(["payment", ms]),
            setPhaseTimerOverrides: (payload) => applied.push(["phase", payload]),
            setSettlementTimeoutMs: (ms) => applied.push(["settlement", ms]),
            setFinancialOverrides: (payload) => applied.push(["financial", payload])
        }
    });

    service.initialize();

    const result = service.update({
        setupTimeoutMs: 111000,
        ownerFeePercent: 6
    }, {
        username: "admin",
        role: "Administrator"
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.configVersion, 1);
    assert.equal(result.changes.length, 2);
    assert.ok(result.auditRecords.length >= 2);

    const persisted = JSON.parse(
        readFileSync(env.RUNTIME_CONFIGURATION_STATE_PATH, "utf8")
    );

    assert.equal(persisted.values.setupTimeoutMs, 111000);
    assert.equal(persisted.values.ownerFeePercent, 6);
    assert.ok(persisted.previousValues);

    const audit = readRuntimeConfigurationAudit({ limit: 20 }, env);

    assert.ok(audit.some((row) => row.event === "RUNTIME_CONFIG_CHANGED"
        && row.parameter === "ownerFeePercent"
        && row.newValue === 6
        && row.user === "admin"));

    assert.ok(applied.some((entry) => entry[0] === "setup" && entry[1] === 111000));
    assert.ok(applied.some((entry) => entry[0] === "financial"));

    rmSync(dir, { recursive: true, force: true });

});
