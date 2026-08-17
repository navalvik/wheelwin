/**
 * R17.9J.2B — Audio Registry asset upload into client/src/assets/audio.
 */

import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AudioRegistryService } from "../console/configuration/AudioRegistryService.js";
import {
    AUDIO_UPLOAD_MAX_BYTES,
    isOggBuffer,
    validateAudioAssetUpload,
    writeAudioAssetUpload
} from "../console/configuration/uploadAudioRegistryAsset.js";
import { resolveAudioPlaybackPermissionById } from "../console/configuration/resolveAudioPlaybackPermission.js";

function makeOggBuffer(size = 64) {

    const buffer = Buffer.alloc(size, 0);

    buffer.write("OggS", 0, "ascii");

    return buffer;

}

{

    assert.equal(isOggBuffer(makeOggBuffer()), true);
    assert.equal(isOggBuffer(Buffer.from("RIFF")), false);

    const badExt = validateAudioAssetUpload({
        id: "wheel.stop",
        originalFilename: "stop.exe",
        buffer: makeOggBuffer()
    });

    assert.equal(badExt.ok, false);

    const wrongName = validateAudioAssetUpload({
        id: "wheel.stop",
        originalFilename: "other.ogg",
        buffer: makeOggBuffer()
    });

    assert.equal(wrongName.ok, false);
    assert.match(wrongName.error, /stop\.ogg/i);

    const tooBig = validateAudioAssetUpload({
        id: "wheel.stop",
        originalFilename: "stop.ogg",
        buffer: makeOggBuffer(AUDIO_UPLOAD_MAX_BYTES + 1)
    });

    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.status, 413);

    console.log("  upload validation rejects non-ogg / wrong name / oversized");

}

{

    const dir = mkdtempSync(join(tmpdir(), "ww-audio-upload-"));
    const assetsRoot = join(dir, "assets");

    mkdirSync(join(assetsRoot, "wheel"), { recursive: true });

    const before = writeAudioAssetUpload({
        id: "wheel.stop",
        originalFilename: "stop.ogg",
        buffer: makeOggBuffer(128),
        assetsRoot
    });

    assert.equal(before.ok, true);
    assert.equal(before.assetStatus, "AVAILABLE");
    assert.equal(before.exists, true);

    const target = join(assetsRoot, "wheel", "stop.ogg");

    assert.equal(existsSync(target), true);
    assert.equal(readFileSync(target).subarray(0, 4).toString("ascii"), "OggS");

    const env = {
        AUDIO_REGISTRY_STATE_PATH: join(dir, "audio-registry-runtime.json"),
        AUDIO_REGISTRY_AUDIT_PATH: join(dir, "audio-registry-audit.jsonl"),
        AUDIO_ASSETS_ROOT: assetsRoot
    };

    const service = new AudioRegistryService({ env });

    service.initialize();

    // Preserve enabled/loop across upload.
    service.update({
        entries: [{ id: "wheel.stop", enabled: false, loop: true }]
    }, {
        username: "admin",
        role: "Administrator"
    });

    const uploaded = service.uploadAsset(
        "wheel.stop",
        makeOggBuffer(256),
        {
            originalFilename: "stop.ogg",
            username: "admin",
            role: "Administrator",
            assetsRoot
        }
    );

    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.assetStatus, "AVAILABLE");

    const stop = uploaded.registry.entries.find((e) => e.id === "wheel.stop");

    assert.equal(stop.exists, true);
    assert.equal(stop.status, "AVAILABLE");
    assert.equal(stop.enabled, false);
    assert.equal(stop.loop, true);

    const permission = resolveAudioPlaybackPermissionById(
        uploaded.registry.entries,
        "wheel.stop"
    );

    // enabled false → still denied for playback, but asset is AVAILABLE
    assert.equal(permission.allowed, false);
    assert.equal(permission.reason, "DISABLED");
    assert.equal(stop.status, "AVAILABLE");

    // Re-enable → permission allows
    service.update({
        entries: [{ id: "wheel.stop", enabled: true }]
    }, {
        username: "admin",
        role: "Administrator"
    });

    const snap = service.buildSnapshot({ canEdit: true, assetsRoot });
    const allowed = resolveAudioPlaybackPermissionById(snap.entries, "wheel.stop");

    assert.equal(allowed.allowed, true);

    // Missing entry stays missing when not uploaded
    const missing = snap.entries.find((e) => e.id === "result.winner");

    assert.equal(missing.status, "MISSING");

    rmSync(dir, { recursive: true, force: true });

    console.log("  upload writes client assets path; status AVAILABLE; enabled/loop preserved");

}

{

    // Viewer gate is route middleware; service itself is admin-called only.
    // Confirm unknown id cannot write arbitrary paths.
    const dir = mkdtempSync(join(tmpdir(), "ww-audio-upload-bad-"));
    const assetsRoot = join(dir, "assets");

    const evil = writeAudioAssetUpload({
        id: "../etc/passwd",
        originalFilename: "stop.ogg",
        buffer: makeOggBuffer(),
        assetsRoot
    });

    assert.equal(evil.ok, false);

    rmSync(dir, { recursive: true, force: true });

    console.log("  unknown / traversal ids rejected");

}

console.log("audioRegistryUpload.r179j2b.test.js: all assertions passed");
