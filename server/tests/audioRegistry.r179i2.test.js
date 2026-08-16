/**
 * R17.9I.2 / R17.9I.4 — Audio Registry unit tests (updated for file-centric model).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildAudioRegistrySnapshot } from "../console/configuration/buildAudioRegistrySnapshot.js";
import { INITIAL_AUDIO_REGISTRY_ENTRIES } from "../console/configuration/audioRegistryEntries.js";
import {
    AUDIO_ASSET_STATUS
} from "../console/configuration/audioRegistryConstants.js";
import { checkAudioAsset } from "../console/configuration/checkAudioAsset.js";

test("R17.9I.2 every initial entry has required fields including loop", () => {

    assert.ok(INITIAL_AUDIO_REGISTRY_ENTRIES.length > 0);

    for (const entry of INITIAL_AUDIO_REGISTRY_ENTRIES) {

        assert.equal(typeof entry.id, "string");
        assert.ok(entry.id.length > 0);
        assert.equal(typeof entry.file, "string");
        assert.ok(entry.file.length > 0);
        assert.equal(typeof entry.category, "string");
        assert.equal(typeof entry.loop, "boolean");
        assert.equal(typeof entry.enabled, "boolean");

    }

    const spin = INITIAL_AUDIO_REGISTRY_ENTRIES.find(
        (e) => e.id === "wheel.spin"
    );

    assert.equal(spin.loop, true);

    const winner = INITIAL_AUDIO_REGISTRY_ENTRIES.find(
        (e) => e.id === "result.winner"
    );

    assert.equal(winner.loop, false);

});

test("R17.9I.2 checkAudioAsset never throws and reports MISSING safely", () => {

    assert.equal(
        checkAudioAsset({ file: "does/not/exist.ogg" }),
        AUDIO_ASSET_STATUS.MISSING
    );

    assert.equal(
        checkAudioAsset({ file: "../escape.ogg" }),
        AUDIO_ASSET_STATUS.MISSING
    );

    assert.equal(
        checkAudioAsset(null),
        AUDIO_ASSET_STATUS.MISSING
    );

    assert.doesNotThrow(() => checkAudioAsset({ file: "wheel/stop.ogg" }));

});

test("R17.9I.2 snapshot marks existing files AVAILABLE and placeholders MISSING", () => {

    const dir = mkdtempSync(join(tmpdir(), "ww-audio-registry-"));
    const wheelDir = join(dir, "wheel");

    mkdirSync(wheelDir, { recursive: true });
    writeFileSync(join(wheelDir, "spin_loop.ogg"), "fake-ogg");
    writeFileSync(join(wheelDir, "self_test.ogg"), "fake-ogg");

    const warnings = [];

    const snapshot = buildAudioRegistrySnapshot({
        assetsRoot: dir,
        logger: {
            warn: (message) => warnings.push(message)
        }
    });

    assert.equal(snapshot.readOnly, true);
    assert.equal(snapshot.canEdit, false);
    assert.ok(snapshot.entries.length >= 10);

    const spin = snapshot.entries.find((e) => e.id === "wheel.spin");
    const stop = snapshot.entries.find((e) => e.id === "wheel.stop");

    assert.equal(spin.status, AUDIO_ASSET_STATUS.AVAILABLE);
    assert.equal(spin.loop, true);
    assert.equal(stop.status, AUDIO_ASSET_STATUS.MISSING);
    assert.equal(stop.loop, false);

    assert.equal(snapshot.summary.available, 2);
    assert.ok(snapshot.summary.missing >= 1);
    assert.ok(warnings.some((w) => String(w).includes("AUDIO_MISSING_FILE")));

    rmSync(dir, { recursive: true, force: true });

});

test("R17.9I.2 registry loads against real client assets without throwing", () => {

    assert.doesNotThrow(() => {

        const snapshot = buildAudioRegistrySnapshot();

        assert.ok(snapshot.entries.length > 0);
        assert.ok(snapshot.summary.available >= 2);
        assert.ok(snapshot.summary.missing >= 1);

        const existing = snapshot.entries.filter(
            (e) => e.status === AUDIO_ASSET_STATUS.AVAILABLE
        );

        assert.ok(
            existing.some((e) => e.id === "wheel.spin")
        );

    });

});
