export { AdaptiveAudioEngine } from "./AdaptiveAudioEngine";

// R15.1 — real engine kept for future re-enable; Page5 currently uses
// client/src/game/page5/audio/Page5AudioEngineStub via AudioContext.

export {
    AUDIO_CHANNELS,
    AUDIO_TRACKS,
    DEFAULT_VOLUMES,
    PLAYBACK_RATE_MIN,
    PLAYBACK_RATE_MAX,
    clampPlaybackRate,
    mapWheelSpeedToPlaybackRate
} from "./audioUtils";

// R17.9I.4 — registry-aware silent playback gate (does not play audio).
export {
    AUDIO_PLAYBACK_DENY_REASONS,
    resolveAudioPlaybackPermission,
    resolveAudioPlaybackPermissionById
} from "./resolveAudioPlaybackPermission.js";
