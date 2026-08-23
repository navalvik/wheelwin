/**
 * Telegram Mini App initData validation primitive.
 *
 * Pure module. Node built-in crypto only.
 *
 * Ownership:
 * - This module owns ONLY raw initData signature + freshness validation.
 * - It does not authenticate sessions, does not touch rooms, payments,
 *   gameplay or recovery domains.
 * - User identity (telegramUserId) is extracted only AFTER successful
 *   signature validation.
 *
 * Security rules:
 * - Never uses initDataUnsafe.
 * - Never logs initData, botToken, secret keys or hashes.
 */

import crypto from 'node:crypto';

export const DEFAULT_INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

// auth_date may not be more than this far in the future.
const MAX_FUTURE_AUTH_DATE_SECONDS = 60;

const WEB_APP_DATA_KEY = 'WebAppData';

/**
 * Parse raw Telegram Mini App initData query string.
 *
 * @param {string} initData Raw initData query string.
 * @returns {{ params: URLSearchParams, hash: string|null, authDate: string|null, userRaw: string|null }}
 */
export function parseInitData(initData) {
    if (typeof initData !== 'string' || initData.length === 0) {
        throw new Error('initData must be a non-empty string');
    }

    const params = new URLSearchParams(initData);

    return {
        params,
        hash: params.get('hash'),
        authDate: params.get('auth_date'),
        userRaw: params.get('user')
    };
}

/**
 * Build the data-check-string: all fields except `hash`,
 * sorted by key, joined with a newline as "key=value".
 *
 * @param {URLSearchParams|Map<string,string>|Object} params
 * @returns {string}
 */
export function buildDataCheckString(params) {
    let entries;
    if (params instanceof URLSearchParams) {
        entries = Array.from(params.entries());
    } else if (params instanceof Map) {
        entries = Array.from(params.entries());
    } else if (params && typeof params === 'object') {
        entries = Object.entries(params);
    } else {
        throw new Error('params must be URLSearchParams, Map or plain object');
    }

    return entries
        .filter(([key]) => key !== 'hash')
        .map(([key, value]) => `${key}=${value}`)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .join(String.fromCharCode(10));
}

/**
 * Derive the Telegram secret key:
 * HMAC-SHA256(key="WebAppData", message=botToken).
 *
 * @param {string} botToken Bot token. Never logged.
 * @returns {Buffer}
 */
export function deriveSecretKey(botToken) {
    if (typeof botToken !== 'string' || botToken.length === 0) {
        throw new Error('botToken must be a non-empty string');
    }
    return crypto.createHmac('sha256', WEB_APP_DATA_KEY).update(botToken).digest();
}

/**
 * Validate raw Telegram Mini App initData.
 *
 * @param {Object} options
 * @param {string} options.initData Raw initData query string.
 * @param {string} options.botToken Bot token used to sign initData.
 * @param {number} [options.maxAgeSeconds] Max allowed age of auth_date. Default 24h.
 * @param {number} [options.nowSeconds] Current unix time override (for tests).
 * @returns {{ valid: boolean, reason?: string, telegramUserId?: number }}
 */
export function validateTelegramInitData(options) {
    if (!options || typeof options !== 'object') {
        return { valid: false, reason: 'INVALID_OPTIONS' };
    }

    const { initData, botToken } = options;
    const maxAgeSeconds =
        Number.isFinite(options.maxAgeSeconds) && options.maxAgeSeconds > 0
            ? Math.floor(options.maxAgeSeconds)
            : DEFAULT_INIT_DATA_MAX_AGE_SECONDS;

    let parsed;
    try {
        parsed = parseInitData(initData);
    } catch {
        return { valid: false, reason: 'MALFORMED_INIT_DATA' };
    }

    // Required fields.
    if (!parsed.hash) {
        return { valid: false, reason: 'MISSING_HASH' };
    }
    if (!parsed.authDate) {
        return { valid: false, reason: 'MISSING_AUTH_DATE' };
    }
    if (!parsed.userRaw) {
        return { valid: false, reason: 'MISSING_USER' };
    }

    // Hash format: lowercase hex, 64 chars (SHA-256).
    if (!/^[0-9a-f]{64}$/.test(parsed.hash)) {
        return { valid: false, reason: 'INVALID_HASH_FORMAT' };
    }

    // Signature check BEFORE any identity extraction.
    let dataCheckString;
    try {
        dataCheckString = buildDataCheckString(parsed.params);
    } catch {
        return { valid: false, reason: 'MALFORMED_INIT_DATA' };
    }

    let secretKey;
    try {
        secretKey = deriveSecretKey(botToken);
    } catch {
        return { valid: false, reason: 'INVALID_BOT_TOKEN' };
    }

    const computedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest();

    const providedHash = Buffer.from(parsed.hash, 'hex');

    // Constant-time comparison.
    if (
        computedHash.length !== providedHash.length ||
        !crypto.timingSafeEqual(computedHash, providedHash)
    ) {
        return { valid: false, reason: 'SIGNATURE_MISMATCH' };
    }

    // Freshness checks (after signature).
    const authDateNumber = Number(parsed.authDate);
    if (!Number.isInteger(authDateNumber) || authDateNumber <= 0) {
        return { valid: false, reason: 'INVALID_AUTH_DATE' };
    }

    const nowSeconds =
        Number.isFinite(options.nowSeconds) && options.nowSeconds >= 0
            ? Math.floor(options.nowSeconds)
            : Math.floor(Date.now() / 1000);

    if (authDateNumber > nowSeconds + MAX_FUTURE_AUTH_DATE_SECONDS) {
        return { valid: false, reason: 'AUTH_DATE_IN_FUTURE' };
    }

    if (nowSeconds - authDateNumber > maxAgeSeconds) {
        return { valid: false, reason: 'AUTH_DATE_EXPIRED' };
    }

    // Identity extraction ONLY after successful signature validation.
    let user;
    try {
        user = JSON.parse(parsed.userRaw);
    } catch {
        return { valid: false, reason: 'INVALID_USER_JSON' };
    }

    if (!user || typeof user !== 'object') {
        return { valid: false, reason: 'INVALID_USER_JSON' };
    }

    if (user.id === undefined || user.id === null) {
        return { valid: false, reason: 'MISSING_USER_ID' };
    }

    if (!Number.isInteger(user.id) || user.id <= 0) {
        return { valid: false, reason: 'INVALID_USER_ID' };
    }

    return { valid: true, telegramUserId: user.id };
}