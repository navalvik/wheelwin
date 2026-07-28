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
    ADMIN_USERNAME: Object.freeze({
        key: "ADMIN_USERNAME",
        type: "string",
        requiredInProduction: true,
        category: "Authentication",
        suggestedFix: "Set ADMIN_USERNAME (or DEVELOPER_AUTH_USERNAME)."
    }),
    ADMIN_PASSWORD_HASH: Object.freeze({
        key: "ADMIN_PASSWORD_HASH",
        type: "secret",
        requiredInProduction: true,
        category: "Authentication",
        suggestedFix: "Set ADMIN_PASSWORD_HASH using server/scripts/hash-admin-password.js."
    }),
    VIEWER_USERNAME: Object.freeze({
        key: "VIEWER_USERNAME",
        type: "string",
        required: false,
        category: "Authentication",
        suggestedFix: "Optional read-only dashboard username."
    }),
    VIEWER_PASSWORD_HASH: Object.freeze({
        key: "VIEWER_PASSWORD_HASH",
        type: "secret",
        required: false,
        category: "Authentication",
        suggestedFix: "Optional read-only dashboard password hash."
    }),
    DEVELOPER_AUTH_USERNAME: Object.freeze({
        key: "DEVELOPER_AUTH_USERNAME",
        type: "string",
        required: false,
        category: "Authentication",
        suggestedFix: "Legacy alias for ADMIN_USERNAME."
    }),
    DEVELOPER_AUTH_PASSWORD: Object.freeze({
        key: "DEVELOPER_AUTH_PASSWORD",
        type: "secret",
        required: false,
        category: "Authentication",
        suggestedFix: "Development-only plain password fallback. Use ADMIN_PASSWORD_HASH in staging/production."
    }),
    DEVELOPER_AUTH_ACCESS_TTL_SECONDS: Object.freeze({
        key: "DEVELOPER_AUTH_ACCESS_TTL_SECONDS",
        type: "integer",
        required: false,
        min: 60,
        category: "Authentication",
        suggestedFix: "Set DEVELOPER_AUTH_ACCESS_TTL_SECONDS to an integer >= 60."
    }),
    ADMIN_SESSION_TIMEOUT_SECONDS: Object.freeze({
        key: "ADMIN_SESSION_TIMEOUT_SECONDS",
        type: "integer",
        required: false,
        min: 60,
        category: "Authentication",
        suggestedFix: "Alias for DEVELOPER_AUTH_ACCESS_TTL_SECONDS."
    }),
    DEVELOPER_AUTH_REFRESH_TTL_SECONDS: Object.freeze({
        key: "DEVELOPER_AUTH_REFRESH_TTL_SECONDS",
        type: "integer",
        required: false,
        min: 60,
        category: "Authentication",
        suggestedFix: "Set DEVELOPER_AUTH_REFRESH_TTL_SECONDS to an integer >= 60."
    }),
    APP_ENVIRONMENT: Object.freeze({
        key: "APP_ENVIRONMENT",
        type: "string",
        required: false,
        category: "Environment",
        suggestedFix: "Set APP_ENVIRONMENT to DEVELOPMENT, TESTNET, or MAINNET."
    }),
    BLOCKCHAIN_NETWORK: Object.freeze({
        key: "BLOCKCHAIN_NETWORK",
        type: "string",
        required: false,
        category: "Environment",
        suggestedFix: "Alias for APP_ENVIRONMENT."
    })
});
