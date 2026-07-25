/**
 * R7.0C — Developer authentication configuration schema.
 */

export const DEVELOPER_SCHEMA = Object.freeze({
    DEVELOPER_AUTH_ENABLED: Object.freeze({
        key: "DEVELOPER_AUTH_ENABLED",
        type: "boolean",
        required: false,
        category: "Authentication",
        suggestedFix: "Set DEVELOPER_AUTH_ENABLED to true or false."
    }),
    DEVELOPER_AUTH_SECRET: Object.freeze({
        key: "DEVELOPER_AUTH_SECRET",
        type: "secret",
        requiredInProduction: true,
        minLength: 16,
        category: "Authentication",
        suggestedFix: "Set a strong unique DEVELOPER_AUTH_SECRET (min 16 chars)."
    }),
    DEVELOPER_AUTH_USERNAME: Object.freeze({
        key: "DEVELOPER_AUTH_USERNAME",
        type: "string",
        requiredInProduction: true,
        category: "Authentication",
        suggestedFix: "Set DEVELOPER_AUTH_USERNAME."
    }),
    DEVELOPER_AUTH_PASSWORD: Object.freeze({
        key: "DEVELOPER_AUTH_PASSWORD",
        type: "secret",
        requiredInProduction: true,
        minLength: 8,
        category: "Authentication",
        suggestedFix: "Set a strong DEVELOPER_AUTH_PASSWORD (min 8 chars)."
    }),
    DEVELOPER_AUTH_ACCESS_TTL_SECONDS: Object.freeze({
        key: "DEVELOPER_AUTH_ACCESS_TTL_SECONDS",
        type: "integer",
        required: false,
        min: 60,
        category: "Authentication",
        suggestedFix: "Set DEVELOPER_AUTH_ACCESS_TTL_SECONDS to an integer >= 60."
    }),
    DEVELOPER_AUTH_REFRESH_TTL_SECONDS: Object.freeze({
        key: "DEVELOPER_AUTH_REFRESH_TTL_SECONDS",
        type: "integer",
        required: false,
        min: 60,
        category: "Authentication",
        suggestedFix: "Set DEVELOPER_AUTH_REFRESH_TTL_SECONDS to an integer >= 60."
    })
});
