/**
 * R17.9I.2 — Audio Registry categories and asset status constants.
 */

export const AUDIO_REGISTRY_CATEGORIES = Object.freeze([
    "UI",
    "Lobby",
    "Verification",
    "Payment",
    "Game",
    "Result",
    "System"
]);

export const AUDIO_ASSET_STATUS = Object.freeze({
    AVAILABLE: "AVAILABLE",
    MISSING: "MISSING"
});

export const AUDIO_REGISTRY_SCHEMA_VERSION = 1;
