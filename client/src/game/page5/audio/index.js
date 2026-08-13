/**
 * R15.1 — Page5 audio package.
 * Currently exports the playback-disabled stub. AdaptiveAudioEngine remains
 * available under client/src/game/audio/ for a future real implementation.
 */

export {
    Page5AudioEngineStub,
    Page5AudioEngineStub as AudioEngineStub
} from "./Page5AudioEngineStub.js";

export { Page5AudioEngineStub as default } from "./Page5AudioEngineStub.js";
