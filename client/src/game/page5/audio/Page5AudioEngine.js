/**
 * R17.9I.5 — Page5 Audio Engine with Audio Registry gating.
 *
 * Same public API as Page5AudioEngineStub. Before playback:
 *   eventId → registry entry → enabled + AVAILABLE → play (loop from registry)
 * Otherwise silent skip. Never throws into React / gameplay.
 */

import { GAME_STATES } from "../../GameState.js";

import spinLoopUrl from "../../../assets/audio/wheel/spin_loop.ogg";
import selfTestUrl from "../../../assets/audio/wheel/self_test.ogg";
import brakeLoopUrl from "../../../assets/audio/wheel/brake_loop.ogg";

import {
    CLIENT_AUDIO_REGISTRY_DEFAULTS
} from "../../audio/audioRegistryCatalog.js";
import {
    resolvePage5AudioEventPermission
} from "../../audio/resolvePage5AudioEventPermission.js";

/**
 * Bundled asset URLs keyed by registry file path.
 * Missing registry files simply have no URL → silent skip.
 */
const BUNDLED_ASSET_URLS = Object.freeze({
    "wheel/spin_loop.ogg": spinLoopUrl,
    "wheel/self_test.ogg": selfTestUrl,
    "wheel/brake_loop.ogg": brakeLoopUrl
});

function createEmptyStatus(overrides = {}) {

    return {
        loaded: false,
        unlocked: false,
        musicPlaying: false,
        musicPaused: false,
        mechanicalPlaying: false,
        selfTestPlaying: false,
        brakePlaying: false,
        playbackRate: 1,
        volumes: {},
        loadedTracks: [],
        contextState: "uninitialized",
        enabled: true,
        registryLoaded: false,
        ...overrides
    };

}

export class Page5AudioEngine {

    constructor() {

        this._initialized = false;
        this._context = null;
        this._unlocked = false;
        this._registryById = new Map();
        this._buffers = new Map();
        this._loopNodes = new Map();
        this._lastGameState = null;
        this._mechanicalPlaying = false;
        this._selfTestPlaying = false;
        this._brakePlaying = false;
        this._loaded = false;

        this.setRegistryEntries(CLIENT_AUDIO_REGISTRY_DEFAULTS);

    }

    init() {

        this._initialized = true;

        return this;

    }

    /**
     * Apply registry snapshot entries (from /audio/registry or defaults).
     * Never throws.
     * @param {object[]} entries
     */
    setRegistryEntries(entries) {

        try {

            const next = new Map();
            const list = Array.isArray(entries) ? entries : [];

            for (const entry of list) {

                const id = String(entry?.id ?? "").trim();

                if (!id) {

                    continue;

                }

                next.set(id, {
                    id,
                    file: String(entry.file ?? entry.audioFile ?? "").trim(),
                    category: entry.category ?? null,
                    enabled: entry.enabled !== false,
                    loop: entry.loop === true,
                    status: entry.status ?? null,
                    exists: entry.exists
                });

            }

            if (next.size > 0) {

                this._registryById = next;

            }

        } catch {

            // keep previous registry
        }

    }

    async load() {

        try {

            if (!this._initialized) {

                this.init();

            }

            const AudioContextClass = typeof window !== "undefined"
                ? (window.AudioContext || window.webkitAudioContext)
                : null;

            if (!AudioContextClass) {

                this._loaded = true;

                return this.getStatus();

            }

            if (!this._context) {

                this._context = new AudioContextClass();

            }

            this._loaded = true;

            return this.getStatus();

        } catch {

            this._loaded = true;

            return this.getStatus();

        }

    }

    unlock() {

        try {

            if (!this._context) {

                return;

            }

            if (this._context.state === "suspended") {

                void this._context.resume().catch(() => {});

            }

            this._unlocked = true;

        } catch {

            // silent
        }

    }

    isUnlocked() {

        return this._unlocked === true;

    }

    isEnabled() {

        return true;

    }

    setVolume() {

        // Registry does not expose per-channel volume in I.5.

    }

    setPlaybackRate() {

        // no-op for registry-gated one-shots / loops in this stage
    }

    updateWheelSpeed() {

        // Physics remains independent; rate mapping deferred.
    }

    playMusic() {

        // Background bed not in I.5 event map.
    }

    stopMusic() {

        this.stopBackground();

    }

    playBackground() {

        this.playMusic();

    }

    stopBackground() {

        // no dedicated background registry event
    }

    pauseBackground() {}

    resumeBackground() {}

    playMechanical() {

        void this._playEvent("WHEEL_SPIN_LOOP", { preferLoopKey: "mechanical" });

    }

    stopMechanical() {

        this._stopLoop("mechanical");
        this._mechanicalPlaying = false;

    }

    playSelfTest() {

        void this._playEvent("WHEEL_SELF_TEST", { preferLoopKey: "selfTest" });

    }

    stopSelfTest() {

        this._stopLoop("selfTest");
        this._selfTestPlaying = false;

    }

    playBrake() {

        void this._playEvent("WHEEL_BRAKE_LOOP", { preferLoopKey: "brake" });

    }

    stopBrake() {

        this._stopLoop("brake");
        this._brakePlaying = false;

    }

    playButtonPress() {

        void this._playEvent("PLAYER_INPUT");

    }

    playButtonRelease() {

        // Release shares PLAYER_INPUT mapping only for press in this stage.
    }

    playWin() {

        void this._playEvent("WINNER_DECLARED");

    }

    playLost() {

        void this._playEvent("LOSER_RESULT");

    }

    playCountdownIntro() {

        // Not in the I.5 connected event list.
    }

    handleGameState(gameState) {

        try {

            if (gameState === this._lastGameState) {

                return;

            }

            const previousState = this._lastGameState;

            this._lastGameState = gameState;

            if (previousState === GAME_STATES.SELF_TEST
                && gameState !== GAME_STATES.SELF_TEST) {

                this.stopSelfTest();

            }

            if (previousState === GAME_STATES.BRAKE
                && gameState !== GAME_STATES.BRAKE) {

                this.stopBrake();

            }

            if (previousState === GAME_STATES.SPEED
                && gameState !== GAME_STATES.SPEED) {

                this.stopMechanical();

            }

            switch (gameState) {

                case GAME_STATES.READY:
                    this.stopSelfTest();
                    this.stopBrake();
                    this.stopMechanical();
                    break;

                case GAME_STATES.SELF_TEST:
                    this.stopBrake();
                    this.stopMechanical();
                    this.playSelfTest();
                    break;

                case GAME_STATES.SPEED:
                    this.stopSelfTest();
                    this.stopBrake();
                    this.playMechanical();
                    break;

                case GAME_STATES.BRAKE:
                    this.stopSelfTest();
                    this.stopMechanical();
                    this.playBrake();
                    break;

                case GAME_STATES.RESULT:
                    this.stopSelfTest();
                    this.stopBrake();
                    this.stopMechanical();
                    break;

                default:
                    break;

            }

        } catch {

            // silent — never affect game phases
        }

    }

    restoreSessionSnapshot(snapshot = {}) {

        try {

            this._lastGameState = null;
            this.handleGameState(snapshot.gameState);

        } catch {

            // silent
        }

    }

    getStatus() {

        return createEmptyStatus({
            loaded: this._loaded,
            unlocked: this._unlocked,
            mechanicalPlaying: this._mechanicalPlaying,
            selfTestPlaying: this._selfTestPlaying,
            brakePlaying: this._brakePlaying,
            contextState: this._context?.state
                ?? (this._loaded ? "running-safe" : "uninitialized"),
            registryLoaded: this._registryById.size > 0,
            loadedTracks: [...this._buffers.keys()]
        });

    }

    dispose() {

        try {

            this.stopSelfTest();
            this.stopMechanical();
            this.stopBrake();

            for (const buffer of this._buffers.values()) {

                void buffer;

            }

            this._buffers.clear();

            if (this._context) {

                void this._context.close?.().catch(() => {});

            }

        } catch {

            // silent
        }

        this._context = null;
        this._initialized = false;
        this._unlocked = false;
        this._loaded = false;

    }

    /**
     * Resolve registry permission for a Page5 event id.
     * @param {string} eventId
     */
    resolveEventPermission(eventId) {

        return resolvePage5AudioEventPermission(
            eventId,
            this._registryById,
            {
                treatBundledAsAvailable: (file) => Boolean(
                    BUNDLED_ASSET_URLS[file]
                )
            }
        );

    }

    /**
     * @param {string} eventId
     * @param {{ preferLoopKey?: string }} [options]
     */
    async _playEvent(eventId, { preferLoopKey = null } = {}) {

        try {

            const permission = this.resolveEventPermission(eventId);

            if (!permission.allowed) {

                return;

            }

            if (!this._context) {

                return;

            }

            if (!this._unlocked) {

                this.unlock();

            }

            const url = BUNDLED_ASSET_URLS[permission.file];

            if (!url) {

                // File not in client bundle → silent skip (same as MISSING).
                return;

            }

            const buffer = await this._loadBuffer(permission.file, url);

            if (!buffer) {

                return;

            }

            if (permission.loop === true) {

                const key = preferLoopKey || permission.id;

                this._stopLoop(key);
                this._startLoop(key, buffer);

                if (key === "mechanical") {

                    this._mechanicalPlaying = true;

                }

                if (key === "selfTest") {

                    this._selfTestPlaying = true;

                }

                if (key === "brake") {

                    this._brakePlaying = true;

                }

                return;

            }

            this._playOneShot(buffer);

        } catch {

            // silent skip
        }

    }

    async _loadBuffer(fileKey, url) {

        try {

            if (this._buffers.has(fileKey)) {

                return this._buffers.get(fileKey);

            }

            if (!this._context) {

                return null;

            }

            const response = await fetch(url);

            if (!response.ok) {

                return null;

            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = await this._context.decodeAudioData(arrayBuffer.slice(0));

            this._buffers.set(fileKey, buffer);

            return buffer;

        } catch {

            return null;

        }

    }

    _startLoop(key, buffer) {

        try {

            if (!this._context || !buffer) {

                return;

            }

            const source = this._context.createBufferSource();
            const gain = this._context.createGain();

            source.buffer = buffer;
            source.loop = true;
            gain.gain.value = 0.65;
            source.connect(gain);
            gain.connect(this._context.destination);
            source.start(0);

            this._loopNodes.set(key, { source, gain });

        } catch {

            // silent
        }

    }

    _stopLoop(key) {

        try {

            const nodes = this._loopNodes.get(key);

            if (!nodes) {

                return;

            }

            try {

                nodes.source.stop(0);

            } catch {

                // already stopped
            }

            try {

                nodes.source.disconnect();
                nodes.gain.disconnect();

            } catch {

                // silent
            }

            this._loopNodes.delete(key);

        } catch {

            // silent
        }

    }

    _playOneShot(buffer) {

        try {

            if (!this._context || !buffer) {

                return;

            }

            const source = this._context.createBufferSource();
            const gain = this._context.createGain();

            source.buffer = buffer;
            source.loop = false;
            gain.gain.value = 0.7;
            source.connect(gain);
            gain.connect(this._context.destination);
            source.start(0);

        } catch {

            // silent
        }

    }

}

export default Page5AudioEngine;
