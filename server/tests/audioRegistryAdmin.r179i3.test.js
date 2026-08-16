/**
 * R17.9I.3 — Audio Registry admin controls + validation tests.
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

test("R17.9I.3 validate rejects immutable fields and invalid volume", () => {

    const immutable = validateAudioRegistryPatch({
        entries: [{
            eventId: "WHEEL_SPIN_LOOP",
            audioFile: "wheel/hacked.ogg",
            volume: 0.2
        }]
    });

    assert.equal(immutable.ok, false);

    const volume = validateAudioRegistryPatch({
        entries: [{
            eventId: "WHEEL_SPIN_LOOP",
            volume: 1.5
        }]
    });

    assert.equal(volume.ok, false);

    const ok = validateAudioRegistryPatch({
        entries: [{
            eventId: "WHEEL_SPIN_LOOP",
            enabled: false,
            volume: 0.25,
            loop: true
        }]
    });

    assert.equal(ok.ok, true);
    assert.equal(ok.patches.WHEEL_SPIN_LOOP.enabled, false);
    assert.equal(ok.patches.WHEEL_SPIN_LOOP.volume, 0.25);
    assert.equal(ok.patches.WHEEL_SPIN_LOOP.loop, true);

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
            eventId: "WINNER_DECLARED",
            enabled: false,
            volume: 0.4,
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

    assert.equal(persisted.overrides.WINNER_DECLARED.enabled, false);
    assert.equal(persisted.overrides.WINNER_DECLARED.volume, 0.4);

    const audit = readAudioRegistryAudit({ limit: 20 }, env);

    assert.ok(audit.some((row) => row.event === "AUDIO_REGISTRY_CHANGED"
        && row.eventId === "WINNER_DECLARED"
        && row.field === "enabled"
        && row.newValue === false
        && row.user === "admin"));

    const snapshot = service.buildSnapshot({ canEdit: true });

    const winner = snapshot.entries.find((e) => e.eventId === "WINNER_DECLARED");

    assert.equal(winner.enabled, false);
    assert.equal(winner.volume, 0.4);
    assert.equal(snapshot.canEdit, true);
    assert.equal(snapshot.configVersion, 1);

    rmSync(dir, { recursive: true, force: true });

});
