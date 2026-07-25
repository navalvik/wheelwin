/**
 * R8.0B — Release channel constants.
 */

export const RELEASE_CHANNEL = Object.freeze({
    DEVELOPMENT: "development",
    INTERNAL: "internal",
    RC: "rc",
    BETA: "beta",
    PRODUCTION: "production"
});

export const RELEASE_CHANNELS = Object.freeze(Object.values(RELEASE_CHANNEL));

export function isValidReleaseChannel(value) {

    return RELEASE_CHANNELS.includes(String(value || "").trim().toLowerCase());

}
