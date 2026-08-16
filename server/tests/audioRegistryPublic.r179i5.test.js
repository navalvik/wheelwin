/**
 * R17.9I.5 — Public Audio Registry endpoint + playback permission wiring.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

import { AudioRegistryService } from "../console/configuration/AudioRegistryService.js";

function registerPublicAudioRegistryRoute(app, audioRegistryService) {

    app.get("/audio/registry", (req, res) => {

        try {

            if (!audioRegistryService?.buildSnapshot) {

                res.status(503).json({
                    entries: [],
                    canEdit: false,
                    reason: "audio_registry_unavailable"
                });

                return;

            }

            const snapshot = audioRegistryService.buildSnapshot({
                canEdit: false
            });

            res.json({
                schemaVersion: snapshot.schemaVersion ?? 1,
                configVersion: snapshot.configVersion ?? 0,
                canEdit: false,
                entries: Array.isArray(snapshot.entries)
                    ? snapshot.entries
                    : [],
                updatedAt: snapshot.updatedAt ?? null
            });

        } catch {

            res.status(200).json({
                schemaVersion: 1,
                configVersion: 0,
                canEdit: false,
                entries: [],
                updatedAt: null
            });

        }

    });

}

{

    const dir = mkdtempSync(join(tmpdir(), "ww-audio-registry-public-"));
    const assetsRoot = join(dir, "assets");

    mkdirSync(join(assetsRoot, "wheel"), { recursive: true });
    writeFileSync(join(assetsRoot, "wheel", "spin_loop.ogg"), "ogg");

    const env = {
        AUDIO_REGISTRY_STATE_PATH: join(dir, "audio-registry-runtime.json"),
        AUDIO_REGISTRY_AUDIT_PATH: join(dir, "audio-registry-audit.jsonl"),
        AUDIO_ASSETS_ROOT: assetsRoot
    };

    const service = new AudioRegistryService({ env });

    service.initialize();

    // Disable spin via runtime override — public snapshot must reflect it.
    service.update({
        entries: [{ id: "wheel.spin", enabled: false }]
    }, {
        username: "test-admin",
        role: "Administrator"
    });

    const app = express();

    registerPublicAudioRegistryRoute(app, service);

    const server = await new Promise((resolve) => {

        const s = app.listen(0, "127.0.0.1", () => resolve(s));

    });

    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/audio/registry`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.canEdit, false);
    assert.ok(Array.isArray(body.entries));
    assert.ok(body.entries.length >= 11);

    const spin = body.entries.find((entry) => entry.id === "wheel.spin");

    assert.ok(spin);
    assert.equal(spin.enabled, false);
    assert.equal(spin.loop, true);
    assert.equal(typeof spin.status, "string");

    await new Promise((resolve, reject) => {

        server.close((error) => (error ? reject(error) : resolve()));

    });

    rmSync(dir, { recursive: true, force: true });

    console.log("  GET /audio/registry returns read-only snapshot with overrides");

}

console.log("audioRegistryPublic.r179i5.test.js: all assertions passed");
