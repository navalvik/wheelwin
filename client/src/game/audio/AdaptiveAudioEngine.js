import { GAME_STATES } from "../GameState";

import { createPlaceholderBuffers } from "./audioGenerators";

import {
    AUDIO_CHANNELS,
    AUDIO_TRACKS,
    DEFAULT_VOLUMES,
    clampPlaybackRate,
    mapWheelSpeedToPlaybackRate
} from "./audioUtils";

export class AdaptiveAudioEngine {

    constructor() {

        this._context = null;

        this._buffers = new Map();

        this._loaded = false;

        this._unlocked = false;

        this._volumes = { ...DEFAULT_VOLUMES };

        this._playbackRate = 1;

        this._musicNodes = null;

        this._mechanicalNodes = null;

        this._musicPlaying = false;

        this._mechanicalPlaying = false;

        this._musicPaused = false;

        this._loadedTracks = [];

        this._lastGameState = null;

    }

    async load() {

        if (this._loaded) {

            return this.getStatus();

        }

        const AudioContextClass = window.AudioContext
            || window.webkitAudioContext;

        if (!AudioContextClass) {

            throw new Error("Web Audio API is not supported in this browser");

        }

        this._context = new AudioContextClass();

        const placeholders = createPlaceholderBuffers(this._context);

        Object.entries(placeholders).forEach(([track, buffer]) => {

            this._buffers.set(track, buffer);

            this._loadedTracks.push(track);

        });

        this._loaded = true;

        return this.getStatus();

    }

    unlock() {

        if (!this._context) {

            return;

        }

        if (this._context.state === "suspended") {

            this._context.resume();

        }

        this._unlocked = true;

    }

    isUnlocked() {

        return this._unlocked;

    }

    setVolume(channel, level) {

        const nextLevel = Math.max(0, Math.min(1, level));

        this._volumes[channel] = nextLevel;

        this._applyChannelVolume(AUDIO_CHANNELS.MUSIC, this._musicNodes);

        this._applyChannelVolume(AUDIO_CHANNELS.MECHANICAL, this._mechanicalNodes);

    }

    setPlaybackRate(rate) {

        this._playbackRate = clampPlaybackRate(rate);

        this._applyPlaybackRate(this._musicNodes);

        this._applyPlaybackRate(this._mechanicalNodes);

    }

    updateWheelSpeed(wheelSpeed) {

        this.setPlaybackRate(mapWheelSpeedToPlaybackRate(wheelSpeed));

    }

    playBackground() {

        if (!this._canPlay()) {

            return;

        }

        this.stopBackground();

        this._musicNodes = this._startLoop(
            AUDIO_TRACKS.BACKGROUND_MUSIC,
            AUDIO_CHANNELS.MUSIC
        );

        this._musicPlaying = Boolean(this._musicNodes);

        this._musicPaused = false;

    }

    stopBackground() {

        this._stopNodes(this._musicNodes);

        this._musicNodes = null;

        this._musicPlaying = false;

        this._musicPaused = false;

        this.stopMechanical();

    }

    pauseBackground() {

        if (!this._musicPlaying || this._musicPaused) {

            return;

        }

        this._context.suspend();

        this._musicPaused = true;

    }

    resumeBackground() {

        if (!this._musicPlaying || !this._musicPaused) {

            return;

        }

        this._context.resume();

        this._musicPaused = false;

    }

    playMechanical() {

        if (!this._canPlay()) {

            return;

        }

        this.stopMechanical();

        this._mechanicalNodes = this._startLoop(
            AUDIO_TRACKS.MECHANICAL_LOOP,
            AUDIO_CHANNELS.MECHANICAL
        );

        this._mechanicalPlaying = Boolean(this._mechanicalNodes);

    }

    stopMechanical() {

        this._stopNodes(this._mechanicalNodes);

        this._mechanicalNodes = null;

        this._mechanicalPlaying = false;

    }

    playButtonPress() {

        this._playOneShot(AUDIO_TRACKS.BUTTON_PRESS, AUDIO_CHANNELS.EFFECTS);

    }

    playButtonRelease() {

        this._playOneShot(AUDIO_TRACKS.BUTTON_RELEASE, AUDIO_CHANNELS.EFFECTS);

    }

    playWin() {

        this._playOneShot(AUDIO_TRACKS.WIN, AUDIO_CHANNELS.RESULT);

    }

    playLost() {

        this._playOneShot(AUDIO_TRACKS.LOST, AUDIO_CHANNELS.RESULT);

    }

    playCountdownIntro() {

        this._playOneShot(AUDIO_TRACKS.COUNTDOWN_INTRO, AUDIO_CHANNELS.EFFECTS);

    }

    playSelfTest() {

        this._playOneShot(AUDIO_TRACKS.SELF_TEST, AUDIO_CHANNELS.EFFECTS);

    }

    handleGameState(gameState, options = {}) {

        if (gameState === this._lastGameState) {

            return;

        }

        const previousState = this._lastGameState;

        this._lastGameState = gameState;

        switch (gameState) {

            case GAME_STATES.READY:

                this.stopBackground();

                break;

            case GAME_STATES.COUNTDOWN:

                if (previousState === GAME_STATES.READY) {

                    this.playCountdownIntro();

                }

                this.stopBackground();

                break;

            case GAME_STATES.SELF_TEST:

                this.playSelfTest();

                this.stopBackground();

                break;

            case GAME_STATES.SPEED:

                this.playBackground();

                this.playMechanical();

                break;

            case GAME_STATES.BRAKE:

                if (!this._musicPlaying) {

                    this.playBackground();

                    this.playMechanical();

                }

                break;

            case GAME_STATES.RESULT:

                this.stopBackground();

                break;

            default:

                break;

        }

    }

    restoreSessionSnapshot(snapshot = {}) {

        this._lastGameState = null;

        this.handleGameState(snapshot.gameState, {
            resultOutcome: snapshot.resultOutcome
        });

    }

    getStatus() {

        return {
            loaded: this._loaded,
            unlocked: this._unlocked,
            musicPlaying: this._musicPlaying,
            musicPaused: this._musicPaused,
            mechanicalPlaying: this._mechanicalPlaying,
            playbackRate: this._playbackRate,
            volumes: { ...this._volumes },
            loadedTracks: [...this._loadedTracks],
            contextState: this._context?.state || "uninitialized"
        };

    }

    dispose() {

        this.stopBackground();

        this._buffers.clear();

        this._loaded = false;

        this._loadedTracks = [];

        if (this._context) {

            this._context.close();

            this._context = null;

        }

    }

    _canPlay() {

        return this._loaded && this._unlocked && this._context;

    }

    _startLoop(trackName, channel) {

        const buffer = this._buffers.get(trackName);

        if (!buffer || !this._context) {

            return null;

        }

        const source = this._context.createBufferSource();

        const gainNode = this._context.createGain();

        source.buffer = buffer;

        source.loop = true;

        source.playbackRate.value = this._playbackRate;

        gainNode.gain.value = this._volumes[channel];

        source.connect(gainNode);

        gainNode.connect(this._context.destination);

        source.start(0);

        return { source, gainNode };

    }

    _playOneShot(trackName, channel) {

        if (!this._canPlay()) {

            return;

        }

        const buffer = this._buffers.get(trackName);

        if (!buffer || !this._context) {

            return;

        }

        const source = this._context.createBufferSource();

        const gainNode = this._context.createGain();

        source.buffer = buffer;

        source.playbackRate.value = 1;

        gainNode.gain.value = this._volumes[channel];

        source.connect(gainNode);

        gainNode.connect(this._context.destination);

        source.start(0);

    }

    _stopNodes(nodes) {

        if (!nodes?.source) {

            return;

        }

        try {

            nodes.source.stop();

        } catch {

            // Source may already be stopped.

        }

        nodes.source.disconnect();

        nodes.gainNode.disconnect();

    }

    _applyPlaybackRate(nodes) {

        if (!nodes?.source) {

            return;

        }

        nodes.source.playbackRate.value = this._playbackRate;

    }

    _applyChannelVolume(channel, nodes) {

        if (!nodes?.gainNode) {

            return;

        }

        nodes.gainNode.gain.value = this._volumes[channel];

    }

}
