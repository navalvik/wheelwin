/**
 * R17.9I.3 / R17.9I.4 — Audio Registry admin controls tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AudioRegistryService } from "../console/configuration/AudioRegistryService.js";
import { validateAudioRegistryPatch } from "../console/configuration/validateAudioRegistryPatch.js";
import { readAudioRegistryAudit } from "../console/configuration/audioRegistryAuditStore.js";
import {
    isAdministratorOnlySection
} from "../../client/src/console/consoleSections.js";

test("R17.9I.3 admin-only sections include R17.9 modules", () => {

    assert.equal(isAdministratorOnlySection("runtime-configuration"), true);
    assert.equal(isAdministratorOnlySection("wallet-monitoring"), true);
    assert.equal(isAdministratorOnlySection("audio-registry"), true);
    assert.equal(isAdministratorOnlySection("payments"), false);
    assert.equal(isAdministratorOnlySection("server-health"), false);

});

test("R17.9I.3 validate rejects immutable fields and volume edits", () => {

    const immutable = validateAudioRegistryPatch({
        entries: [{
            id: "wheel.spin",
            file: "wheel/hacked.ogg",
            enabled: false
        }]
    });

    assert.equal(immutable.ok, false);

    const volume = validateAudioRegistryPatch({
        entries: [{
            id: "wheel.spin",
            volume: 0.25
        }]
    });

    assert.equal(volume.ok, false);

    const ok = validateAudioRegistryPatch({
        entries: [{
            id: "wheel.spin",
            enabled: false,
            loop: true
        }]
    });

    assert.equal(ok.ok, true);
    assert.equal(ok.patches["wheel.spin"].enabled, false);
    assert.equal(ok.patches["wheel.spin"].loop, true);

});

test("R17.9I.3 service persists overrides and writes AUDIO_REGISTRY_CHANGED audit", () => {

    const dir = mkdtempSync(join(tmpdir(), "ww-audio-registry-admin-"));

    const env = {
        AUDIO_REGISTRY_STATE_PATH: join(dir, "audio-registry-runtime.json"),
        AUDIO_REGISTRY_AUDIT_PATH: join(dir, "audio-registry-audit.jsonl"),
        AUDIO_ASSETS_ROOT: join(dir, "assets")
    };

    const service = new AudioRegistryService({ env });

    service.initialize();

    const result = service.update({
        entries: [{
            id: "result.winner",
            enabled: false,
            loop: false
        }]
    }, {
        username: "admin",
        role: "Administrator"
    });

    assert.equal(result.ok, true);
    assert.equal(result.state.configVersion, 1);
    assert.ok(result.changes.length >= 1);

    const persisted = JSON.parse(
        readFileSync(env.AUDIO_REGISTRY_STATE_PATH, "utf8")
    );

    assert.equal(persisted.overrides["result.winner"].enabled, false);

    const audit = readAudioRegistryAudit({ limit: 20 }, env);

    assert.ok(audit.some((row) => row.event === "AUDIO_REGISTRY_CHANGED"
        && (row.id === "result.winner" || row.eventId === "result.winner")
        && row.field === "enabled"
        && row.newValue === false
        && row.user === "admin"));

    const snapshot = service.buildSnapshot({ canEdit: true });

    const winner = snapshot.entries.find((e) => e.id === "result.winner");

    assert.equal(winner.enabled, false);
    assert.equal(snapshot.canEdit, true);
    assert.equal(snapshot.configVersion, 1);

    rmSync(dir, { recursive: true, force: true });

});
