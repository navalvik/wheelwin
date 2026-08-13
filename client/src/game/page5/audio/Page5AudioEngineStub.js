/**
 * R15.1 — Page5 Audio Engine Stub (temporary production stabilization).
 *
 * Preserves the Audio Engine API and AudioContext integration points while
 * disabling all playback. No AudioContext, no asset loads, no autoplay prompts.
 *
 * Future: replace this stub with a real Page5 Audio Engine that reuses the
 * same public surface (and/or AdaptiveAudioEngine under client/src/game/audio/).
 */

const STUB_STATUS = Object.freeze({
    loaded: true,
    unlocked: false,
    musicPlaying: false,
    musicPaused: false,
    mechanicalPlaying: false,
    selfTestPlaying: false,
    brakePlaying: false,
    playbackRate: 1,
    volumes: Object.freeze({}),
    loadedTracks: Object.freeze([]),
    contextState: "stub-disabled",
    enabled: false
});

export class Page5AudioEngineStub {

    constructor() {

        this._volume = 0;
        this._initialized = false;

    }

    /**
     * Required stub API — no-op initializer.
     */
    init() {

        this._initialized = true;

        return this;

    }

    playMusic() {

        // Intentionally empty — no playback.

    }

    stopMusic() {

        // Intentionally empty — no playback.

    }

    setVolume(channelOrLevel, level) {

        // Accept value(s) for API compatibility; do not apply audio.
        if (typeof level === "number") {

            this._volume = level;

        } else if (typeof channelOrLevel === "number") {

            this._volume = channelOrLevel;

        }

    }

    isEnabled() {

        return false;

    }

    // --- Compatibility surface used by AudioContext / EngineBridge ---

    async load() {

        if (!this._initialized) {

            this.init();

        }

        return this.getStatus();

    }

    unlock() {

        // Do not create or resume AudioContext.

    }

    isUnlocked() {

        return false;

    }

    setPlaybackRate() {

        // No-op.

    }

    updateWheelSpeed() {

        // No-op — physics remains independent.

    }

    playBackground() {

        this.playMusic();

    }

    stopBackground() {

        this.stopMusic();

    }

    pauseBackground() {

        // No-op.

    }

    resumeBackground() {

        // No-op.

    }

    playMechanical() {

        // No-op.

    }

    stopMechanical() {

        // No-op.

    }

    playButtonPress() {

        // No-op — C22 button logic is unchanged; only audio is silenced.

    }

    playButtonRelease() {

        // No-op.

    }

    playWin() {

        // No-op.

    }

    playLost() {

        // No-op.

    }

    playCountdownIntro() {

        // No-op.

    }

    playSelfTest() {

        // No-op.

    }

    stopSelfTest() {

        // No-op.

    }

    playBrake() {

        // No-op.

    }

    stopBrake() {

        // No-op.

    }

    handleGameState() {

        // No-op — game state transitions must not start audio.

    }

    restoreSessionSnapshot() {

        // No-op.

    }

    getStatus() {

        return {
            ...STUB_STATUS,
            volumes: { ...STUB_STATUS.volumes },
            loadedTracks: [...STUB_STATUS.loadedTracks]
        };

    }

    dispose() {

        this._initialized = false;

    }

}

export default Page5AudioEngineStub;
