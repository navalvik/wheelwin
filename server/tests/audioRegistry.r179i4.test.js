/**
 * R17.9I.4 — Audio Registry runtime controls tests.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AudioRegistryService } from "../console/configuration/AudioRegistryService.js";
import { buildAudioRegistrySnapshot } from "../console/configuration/buildAudioRegistrySnapshot.js";
import { INITIAL_AUDIO_REGISTRY_ENTRIES } from "../console/configuration/audioRegistryEntries.js";
import { AUDIO_ASSET_STATUS } from "../console/configuration/audioRegistryConstants.js";
import { checkAudioAsset } from "../console/configuration/checkAudioAsset.js";
import { validateAudioRegistryPatch } from "../console/configuration/validateAudioRegistryPatch.js";
import {
    resolveAudioPlaybackPermission,
    resolveAudioPlaybackPermissionById
} from "../console/configuration/resolveAudioPlaybackPermission.js";
import { readAudioRegistryAudit } from "../console/configuration/audioRegistryAuditStore.js";
import {
    resolveAudioPlaybackPermission as resolveClientPlaybackPermission
} from "../../client/src/game/audio/resolveAudioPlaybackPermission.js";

test("R17.9I.4 static registry matches target asset tree shape", () => {

    assert.ok(INITIAL_AUDIO_REGISTRY_ENTRIES.length >= 11);

    for (const entry of INITIAL_AUDIO_REGISTRY_ENTRIES) {

        assert.equal(typeof entry.id, "string");
        assert.equal(typeof entry.file, "string");
        assert.equal(typeof entry.category, "string");
        assert.equal(typeof entry.enabled, "boolean");
        assert.equal(typeof entry.loop, "boolean");

    }

    const spin = INITIAL_AUDIO_REGISTRY_ENTRIES.find((e) => e.id === "wheel.spin");

    assert.equal(spin.file, "wheel/spin_loop.ogg");
    assert.equal(spin.loop, true);

    const stop = INITIAL_AUDIO_REGISTRY_ENTRIES.find((e) => e.id === "wheel.stop");

    assert.equal(stop.file, "wheel/stop.ogg");
    assert.equal(stop.loop, false);

});

test("R17.9I.4 missing files do not throw and report MISSING", () => {

    assert.doesNotThrow(() => {

        assert.equal(
            checkAudioAsset({ file: "wheel/stop.ogg" }),
            AUDIO_ASSET_STATUS.MISSING
        );

    });

});

test("R17.9I.4 snapshot detects existing and missing assets", () => {

    const dir = mkdtempSync(join(tmpdir(), "ww-audio-i4-"));
    const wheelDir = join(dir, "wheel");

    mkdirSync(wheelDir, { recursive: true });
    writeFileSync(join(wheelDir, "spin_loop.ogg"), "fake");
    writeFileSync(join(wheelDir, "self_test.ogg"), "fake");

    const snapshot = buildAudioRegistrySnapshot({ assetsRoot: dir });
    const spin = snapshot.entries.find((e) => e.id === "wheel.spin");
    const stop = snapshot.entries.find((e) => e.id === "wheel.stop");

    assert.equal(spin.status, AUDIO_ASSET_STATUS.AVAILABLE);
    assert.equal(spin.exists, true);
    assert.equal(stop.status, AUDIO_ASSET_STATUS.MISSING);
    assert.equal(stop.exists, false);

    rmSync(dir, { recursive: true, force: true });

});

test("R17.9I.4 validate allows enabled/loop only", () => {

    const bad = validateAudioRegistryPatch({
        entries: [{ id: "wheel.spin", volume: 0.5 }]
    });

    assert.equal(bad.ok, false);

    const ok = validateAudioRegistryPatch({
        entries: [{ id: "wheel.spin", enabled: false, loop: true }]
    });

    assert.equal(ok.ok, true);
    assert.equal(ok.patches["wheel.spin"].enabled, false);
    assert.equal(ok.patches["wheel.spin"].loop, true);

});

test("R17.9I.4 playback permission denies disabled and missing", () => {

    const disabled = resolveAudioPlaybackPermission({
        id: "wheel.spin",
        file: "wheel/spin_loop.ogg",
        enabled: false,
        loop: true,
        status: "AVAILABLE"
    });

    assert.equal(disabled.allowed, false);
    assert.equal(disabled.reason, "DISABLED");

    const missing = resolveAudioPlaybackPermission({
        id: "wheel.stop",
        file: "wheel/stop.ogg",
        enabled: true,
        loop: false,
        status: "MISSING"
    });

    assert.equal(missing.allowed, false);
    assert.equal(missing.reason, "MISSING");

    const allowed = resolveAudioPlaybackPermission({
        id: "wheel.spin",
        file: "wheel/spin_loop.ogg",
        enabled: true,
        loop: true,
        status: "AVAILABLE"
    });

    assert.equal(allowed.allowed, true);
    assert.equal(allowed.loop, true);

    const byId = resolveAudioPlaybackPermissionById([
        {
            id: "wheel.spin",
            file: "wheel/spin_loop.ogg",
            enabled: true,
            loop: true,
            status: "AVAILABLE"
        }
    ], "wheel.spin");

    assert.equal(byId.allowed, true);

    const clientDenied = resolveClientPlaybackPermission({
        id: "result.winner",
        file: "result/winner.ogg",
        enabled: false,
        status: "AVAILABLE"
    });

    assert.equal(clientDenied.allowed, false);

});

test("R17.9I.4 overrides persist across service reload", () => {

    const dir = mkdtempSync(join(tmpdir(), "ww-audio-i4-persist-"));

    const env = {
        AUDIO_REGISTRY_STATE_PATH: join(dir, "audio-registry-runtime.json"),
        AUDIO_REGISTRY_AUDIT_PATH: join(dir, "audio-registry-audit.jsonl")
    };

    const first = new AudioRegistryService({ env });

    first.initialize();

    const result = first.update({
        entries: [{ id: "wheel.spin", enabled: false, loop: true }]
    }, {
        username: "admin",
        role: "Administrator"
    });

    assert.equal(result.ok, true);

    const second = new AudioRegistryService({ env });

    second.initialize();

    const spin = second.getEffectiveEntries().find((e) => e.id === "wheel.spin");

    assert.equal(spin.enabled, false);
    assert.equal(spin.loop, true);

    const permission = second.resolvePlaybackPermission("wheel.spin");

    assert.equal(permission.allowed, false);
    assert.equal(permission.reason, "DISABLED");

    const audit = readAudioRegistryAudit({ limit: 20 }, env);

    assert.ok(audit.some((row) => row.event === "AUDIO_REGISTRY_CHANGED"
        && (row.id === "wheel.spin" || row.eventId === "wheel.spin")
        && row.field === "enabled"
        && row.newValue === false));

    rmSync(dir, { recursive: true, force: true });

});
