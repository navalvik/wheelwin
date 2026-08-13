/**
 * R15.1 — Page5 Audio Engine Stub tests.
 */

import assert from "node:assert/strict";

import {
    Page5AudioEngineStub,
    AudioEngineStub
} from "../game/page5/audio/index.js";

{
    const engine = new Page5AudioEngineStub();

    assert.equal(typeof engine.init, "function");
    assert.equal(typeof engine.playMusic, "function");
    assert.equal(typeof engine.stopMusic, "function");
    assert.equal(typeof engine.setVolume, "function");
    assert.equal(typeof engine.isEnabled, "function");

    assert.equal(engine.isEnabled(), false);

    assert.doesNotThrow(() => {

        engine.init();
        engine.playMusic();
        engine.stopMusic();
        engine.setVolume(0.5);
        engine.setVolume("music", 0.25);
        engine.unlock();
        engine.handleGameState("SPEED");
        engine.updateWheelSpeed(40);
        engine.playButtonPress();
        engine.playButtonRelease();
        engine.playWin();
        engine.playLost();
        engine.dispose();

    });

    assert.equal(engine.isEnabled(), false);
    console.log("  stub public API is callable and disabled");

}

{

    const engine = new AudioEngineStub();

    engine.init();

    const status = await engine.load();

    assert.equal(status.enabled, false);
    assert.equal(status.musicPlaying, false);
    assert.equal(status.unlocked, false);
    assert.equal(status.contextState, "stub-disabled");
    assert.deepEqual(status.loadedTracks, []);
    assert.equal(engine.isUnlocked(), false);

    // Must not invent a Web Audio context.
    assert.equal(engine._context, undefined);
    console.log("  stub load returns disabled status without AudioContext");

}

console.log("page5AudioEngineStub.r151.test.js: all assertions passed");
