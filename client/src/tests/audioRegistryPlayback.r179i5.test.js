/**
 * R17.9I.5 — Audio Registry → Page5 playback connection tests.
 *
 * Presentation only. Does not require Web Audio / DOM / asset bundling.
 */

import assert from "node:assert/strict";

import {
    AUDIO_EVENT_REGISTRY_IDS,
    mapAudioEventToRegistryId
} from "../game/audio/audioRegistryCatalog.js";
import {
    resolveAudioPlaybackPermission,
    AUDIO_PLAYBACK_DENY_REASONS
} from "../game/audio/resolveAudioPlaybackPermission.js";
import {
    resolvePage5AudioEventPermission
} from "../game/audio/resolvePage5AudioEventPermission.js";
import { Page5AudioEngineStub } from "../game/page5/audio/Page5AudioEngineStub.js";

{
    assert.equal(
        mapAudioEventToRegistryId("WHEEL_SPIN_LOOP"),
        "wheel.spin"
    );
    assert.equal(
        mapAudioEventToRegistryId("WHEEL_BRAKE_LOOP"),
        "wheel.brake"
    );
    assert.equal(
        mapAudioEventToRegistryId("WHEEL_SELF_TEST"),
        "wheel.self_test"
    );
    assert.equal(
        mapAudioEventToRegistryId("PLAYER_INPUT"),
        "ui.button_click"
    );
    assert.equal(
        mapAudioEventToRegistryId("WINNER_DECLARED"),
        "result.winner"
    );
    assert.equal(
        mapAudioEventToRegistryId("LOSER_RESULT"),
        "result.loser"
    );
    assert.equal(mapAudioEventToRegistryId("UNKNOWN"), null);
    assert.equal(Object.keys(AUDIO_EVENT_REGISTRY_IDS).length, 6);
    console.log("  event → registry id map covers existing Page5 events only");
}

{
    const allowed = resolveAudioPlaybackPermission({
        id: "wheel.spin",
        file: "wheel/spin_loop.ogg",
        enabled: true,
        loop: true,
        status: "AVAILABLE"
    });

    assert.equal(allowed.allowed, true);
    assert.equal(allowed.loop, true);
    assert.equal(allowed.reason, "OK");
    console.log("  enabled + AVAILABLE → playback allowed; loop forwarded");
}

{
    const disabled = resolveAudioPlaybackPermission({
        id: "wheel.spin",
        file: "wheel/spin_loop.ogg",
        enabled: false,
        loop: true,
        status: "AVAILABLE"
    });

    assert.equal(disabled.allowed, false);
    assert.equal(disabled.reason, AUDIO_PLAYBACK_DENY_REASONS.DISABLED);
    console.log("  disabled → silent skip");
}

{
    const missing = resolveAudioPlaybackPermission({
        id: "result.winner",
        file: "result/winner.ogg",
        enabled: true,
        loop: false,
        status: "MISSING"
    });

    assert.equal(missing.allowed, false);
    assert.equal(missing.reason, AUDIO_PLAYBACK_DENY_REASONS.MISSING);
    assert.equal(missing.loop, false);
    console.log("  MISSING asset → silent skip; loop still reported");
}

{
    const registry = new Map([
        ["wheel.spin", {
            id: "wheel.spin",
            file: "wheel/spin_loop.ogg",
            enabled: true,
            loop: true,
            status: "AVAILABLE"
        }],
        ["wheel.brake", {
            id: "wheel.brake",
            file: "wheel/brake.ogg",
            enabled: false,
            loop: false,
            status: "AVAILABLE"
        }],
        ["result.winner", {
            id: "result.winner",
            file: "result/winner.ogg",
            enabled: true,
            loop: false,
            status: "MISSING"
        }],
        ["result.loser", {
            id: "result.loser",
            file: "result/loser.ogg",
            enabled: true,
            loop: false,
            status: "AVAILABLE"
        }]
    ]);

    const spin = resolvePage5AudioEventPermission(
        "WHEEL_SPIN_LOOP",
        registry
    );
    const brake = resolvePage5AudioEventPermission(
        "WHEEL_BRAKE_LOOP",
        registry
    );
    const win = resolvePage5AudioEventPermission(
        "WINNER_DECLARED",
        registry
    );
    const lose = resolvePage5AudioEventPermission(
        "LOSER_RESULT",
        registry
    );

    assert.equal(spin.allowed, true);
    assert.equal(spin.loop, true);
    assert.equal(brake.allowed, false);
    assert.equal(brake.reason, AUDIO_PLAYBACK_DENY_REASONS.DISABLED);
    assert.equal(win.allowed, false);
    assert.equal(win.reason, AUDIO_PLAYBACK_DENY_REASONS.MISSING);
    assert.equal(lose.allowed, true);
    assert.equal(lose.loop, false);
    console.log("  Page5 event gate: allow / disable / missing / loop");
}

{
    const stub = new Page5AudioEngineStub();

    stub.init();

    assert.equal(stub.isEnabled(), false);
    assert.doesNotThrow(() => {

        stub.handleGameState("SELF_TEST");
        stub.playWin();
        stub.dispose();

    });

    console.log("  Page5AudioEngineStub safety surface preserved");
}

console.log("audioRegistryPlayback.r179i5.test.js: all assertions passed");
