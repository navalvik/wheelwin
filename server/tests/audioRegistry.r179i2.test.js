/**
 * R17.9I.2 — Audio Registry unit tests.
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

        assert.equal(typeof entry.eventId, "string");
        assert.ok(entry.eventId.length > 0);
        assert.equal(typeof entry.audioFile, "string");
        assert.ok(entry.audioFile.length > 0);
        assert.equal(typeof entry.category, "string");
        assert.equal(typeof entry.volume, "number");
        assert.equal(typeof entry.loop, "boolean");
        assert.equal(typeof entry.enabled, "boolean");

    }

    const spin = INITIAL_AUDIO_REGISTRY_ENTRIES.find(
        (e) => e.eventId === "WHEEL_SPIN_LOOP"
    );

    assert.equal(spin.loop, true);

    const winner = INITIAL_AUDIO_REGISTRY_ENTRIES.find(
        (e) => e.eventId === "WINNER_DECLARED"
    );

    assert.equal(winner.loop, false);

});

test("R17.9I.2 checkAudioAsset never throws and reports MISSING safely", () => {

    assert.equal(
        checkAudioAsset({ audioFile: "does/not/exist.ogg" }),
        AUDIO_ASSET_STATUS.MISSING
    );

    assert.equal(
        checkAudioAsset({ audioFile: "../escape.ogg" }),
        AUDIO_ASSET_STATUS.MISSING
    );

    assert.equal(
        checkAudioAsset(null),
        AUDIO_ASSET_STATUS.MISSING
    );

    assert.doesNotThrow(() => checkAudioAsset({ audioFile: "wheel/stop.ogg" }));

});

test("R17.9I.2 snapshot marks existing files AVAILABLE and placeholders MISSING", () => {

    const dir = mkdtempSync(join(tmpdir(), "ww-audio-registry-"));
    const wheelDir = join(dir, "wheel");

    mkdirSync(wheelDir, { recursive: true });
    writeFileSync(join(wheelDir, "spin_loop.ogg"), "fake-ogg");
    writeFileSync(join(wheelDir, "self_test.ogg"), "fake-ogg");
    writeFileSync(join(wheelDir, "brake_loop.ogg"), "fake-ogg");

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

    const spin = snapshot.entries.find((e) => e.eventId === "WHEEL_SPIN_LOOP");
    const stop = snapshot.entries.find((e) => e.eventId === "WHEEL_STOP");

    assert.equal(spin.status, AUDIO_ASSET_STATUS.AVAILABLE);
    assert.equal(spin.loop, true);
    assert.equal(stop.status, AUDIO_ASSET_STATUS.MISSING);
    assert.equal(stop.loop, false);

    assert.equal(snapshot.summary.available, 3);
    assert.ok(snapshot.summary.missing >= 1);
    assert.ok(warnings.some((w) => String(w).includes("AUDIO_MISSING_FILE")));

    rmSync(dir, { recursive: true, force: true });

});

test("R17.9I.2 registry loads against real client assets without throwing", () => {

    assert.doesNotThrow(() => {

        const snapshot = buildAudioRegistrySnapshot();

        assert.ok(snapshot.entries.length > 0);
        assert.ok(snapshot.summary.available >= 3);
        assert.ok(snapshot.summary.missing >= 1);

        const existing = snapshot.entries.filter(
            (e) => e.status === AUDIO_ASSET_STATUS.AVAILABLE
        );

        assert.ok(
            existing.some((e) => e.eventId === "WHEEL_SPIN_LOOP")
        );

    });

});
