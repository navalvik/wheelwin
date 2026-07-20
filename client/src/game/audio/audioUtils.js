import { BASE_WHEEL_SPEED_DEG } from "../physics/physicsUtils";

export const AUDIO_CHANNELS = Object.freeze({
    MUSIC: "music",
    MECHANICAL: "mechanical",
    EFFECTS: "effects",
    RESULT: "result"
});

export const PLAYBACK_RATE_MIN = 0.8;

export const PLAYBACK_RATE_MAX = 1.5;

export const DEFAULT_VOLUMES = Object.freeze({
    [AUDIO_CHANNELS.MUSIC]: 0.45,
    [AUDIO_CHANNELS.MECHANICAL]: 0.3,
    [AUDIO_CHANNELS.EFFECTS]: 0.65,
    [AUDIO_CHANNELS.RESULT]: 0.75
});

export const AUDIO_TRACKS = Object.freeze({
    BACKGROUND_MUSIC: "backgroundMusic",
    MECHANICAL_LOOP: "mechanicalLoop",
    COUNTDOWN_INTRO: "countdownIntro",
    SELF_TEST: "selfTest",
    BRAKE: "brake",
    BUTTON_PRESS: "buttonPress",
    BUTTON_RELEASE: "buttonRelease",
    WIN: "win",
    LOST: "lost"
});

export function clampPlaybackRate(rate) {

    return Math.max(
        PLAYBACK_RATE_MIN,
        Math.min(PLAYBACK_RATE_MAX, rate)
    );

}

export function mapWheelSpeedToPlaybackRate(wheelSpeed) {

    // Base 1.0 at BASE_WHEEL_SPEED_DEG (1 rps). Higher speed raises rate.
    const normalizedSpeed = Math.max(0, wheelSpeed) / BASE_WHEEL_SPEED_DEG;

    if (normalizedSpeed <= 0) {

        return PLAYBACK_RATE_MIN;

    }

    return clampPlaybackRate(normalizedSpeed);

}
