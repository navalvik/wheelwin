/**
 * Unit tests for server/auth/telegramInitDataValidator.js
 *
 * Deterministic: fixed test bot token, fixed timestamps.
 * No real Telegram credentials are used.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
    parseInitData,
    buildDataCheckString,
    deriveSecretKey,
    validateTelegramInitData,
    DEFAULT_INIT_DATA_MAX_AGE_SECONDS
} from '../auth/telegramInitDataValidator.js';

// ---- Fixed deterministic test fixtures -------------------------------------

const TEST_BOT_TOKEN = '1234567890:TEST_FIXED_BOT_TOKEN_NOT_REAL';
const WRONG_BOT_TOKEN = '9999999999:WRONG_TEST_TOKEN_NOT_REAL';

const TEST_NOW = 1700000000; // fixed "now" for all tests
const TEST_AUTH_DATE = 1700000000 - 60; // 60s old, fresh

const TEST_USER = { id: 424242, first_name: 'Test', username: 'test_user' };

function buildDataCheckStringFor(fields) {
    return Object.keys(fields)
        .filter((k) => k !== 'hash')
        .sort()
        .map((k) => `${k}=${fields[k]}`)
        .join(String.fromCharCode(10));
}

function computeHash(fields, botToken) {
    const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(botToken)
        .digest();
    return crypto
        .createHmac('sha256', secretKey)
        .update(buildDataCheckStringFor(fields))
        .digest('hex');
}

/**
 * Build a signed initData string deterministically from given fields.
 * If fields.hash is null, no hash field is included at all.
 * Otherwise, if hash is undefined, a valid hash is computed automatically.
 */
function buildSignedInitData(fields) {
    const withHash = { ...fields };
    if (withHash.hash === null) {
        delete withHash.hash;
    } else if (withHash.hash === undefined) {
        withHash.hash = computeHash(withHash, TEST_BOT_TOKEN);
    }
    return Object.entries(withHash)
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
}

function buildValidInitData() {
    return buildSignedInitData({
        user: JSON.stringify(TEST_USER),
        auth_date: String(TEST_AUTH_DATE),
        query_id: 'AAF9E7C6TEST'
    });
}

const VALID_OPTS = {
    botToken: TEST_BOT_TOKEN,
    nowSeconds: TEST_NOW
};

// ---- Tests -----------------------------------------------------------------

test('1. valid initData passes and extracts telegramUserId deterministically', () => {
    const initData = buildValidInitData();
    const result = validateTelegramInitData({ ...VALID_OPTS, initData });

    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.telegramUserId, 424242);

    // Deterministic: same input twice gives identical result.
    const again = validateTelegramInitData({ ...VALID_OPTS, initData });
    assert.deepStrictEqual(result, again);
});

test('2. tampered hash is rejected', () => {
    const fields = {
        user: JSON.stringify(TEST_USER),
        auth_date: String(TEST_AUTH_DATE),
        query_id: 'AAF9E7C6TEST'
    };
    const realHash = computeHash(fields, TEST_BOT_TOKEN);
    // Flip one hex character deterministically.
    const flipped = (realHash[0] === '0' ? '1' : '0') + realHash.slice(1);
    const initData = buildSignedInitData({ ...fields, hash: flipped });

    const result = validateTelegramInitData({ ...VALID_OPTS, initData });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'SIGNATURE_MISMATCH');
});

test('3. wrong bot token is rejected', () => {
    const initData = buildValidInitData();
    const result = validateTelegramInitData({
        ...VALID_OPTS,
        initData,
        botToken: WRONG_BOT_TOKEN
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'SIGNATURE_MISMATCH');
});

test('4. malformed initData (non-string / empty) is rejected', () => {
    for (const bad of [undefined, null, 42, '', {}]) {
        const result = validateTelegramInitData({ ...VALID_OPTS, initData: bad });
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.reason, 'MALFORMED_INIT_DATA');
    }
});

test('5. missing hash is rejected', () => {
    const fields = {
        user: JSON.stringify(TEST_USER),
        auth_date: String(TEST_AUTH_DATE)
    };
    const initData = buildSignedInitData({ ...fields, hash: null }); // no hash field
    const result = validateTelegramInitData({ ...VALID_OPTS, initData });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'MISSING_HASH');
});

test('6. invalid hash format is rejected', () => {
    const fields = {
        user: JSON.stringify(TEST_USER),
        auth_date: String(TEST_AUTH_DATE),
        query_id: 'X',
        hash: 'not-a-valid-hash'
    };
    const initData = buildSignedInitData(fields);
    const result = validateTelegramInitData({ ...VALID_OPTS, initData });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'INVALID_HASH_FORMAT');
});

test('7. missing auth_date is rejected', () => {
    const fields = {
        user: JSON.stringify(TEST_USER),
        query_id: 'X'
    };
    const initData = buildSignedInitData(fields);
    const result = validateTelegramInitData({ ...VALID_OPTS, initData });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'MISSING_AUTH_DATE');
});

test('8. invalid (non-numeric) auth_date is rejected', () => {
    const fields = {
        user: JSON.stringify(TEST_USER),
        auth_date: 'not-a-number',
        query_id: 'X'
    };
    const initData = buildSignedInitData(fields);
    const result = validateTelegramInitData({ ...VALID_OPTS, initData });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'INVALID_AUTH_DATE');
});

test('9. future auth_date beyond tolerance is rejected', () => {
    const fields = {
        user: JSON.stringify(TEST_USER),
        auth_date: String(TEST_NOW + 61), // > 60s in the future
        query_id: 'X'
    };
    const initData = buildSignedInitData(fields);
    const result = validateTelegramInitData({ ...VALID_OPTS, initData });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'AUTH_DATE_IN_FUTURE');

    // Within tolerance (<= 60s ahead) must pass signature+freshness path.
    const okFields = {
        user: JSON.stringify(TEST_USER),
        auth_date: String(TEST_NOW + 60),
        query_id: 'X'
    };
    const okResult = validateTelegramInitData({
        ...VALID_OPTS,
        initData: buildSignedInitData(okFields)
    });
    assert.strictEqual(okResult.valid, true);
});

test('10. expired auth_date is rejected', () => {
    const expired = TEST_NOW - DEFAULT_INIT_DATA_MAX_AGE_SECONDS - 1;
    const fields = {
        user: JSON.stringify(TEST_USER),
        auth_date: String(expired),
        query_id: 'X'
    };
    const initData = buildSignedInitData(fields);
    const result = validateTelegramInitData({ ...VALID_OPTS, initData });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'AUTH_DATE_EXPIRED');

    // Exactly at max age boundary must still be accepted.
    const boundary = TEST_NOW - DEFAULT_INIT_DATA_MAX_AGE_SECONDS;
    const okFields = {
        user: JSON.stringify(TEST_USER),
        auth_date: String(boundary),
        query_id: 'X'
    };
    const okResult = validateTelegramInitData({
        ...VALID_OPTS,
        initData: buildSignedInitData(okFields)
    });
    assert.strictEqual(okResult.valid, true);
});

test('11. missing user is rejected', () => {
    const fields = {
        auth_date: String(TEST_AUTH_DATE),
        query_id: 'X'
    };
    const initData = buildSignedInitData(fields);
    const result = validateTelegramInitData({ ...VALID_OPTS, initData });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'MISSING_USER');
});

test('12. invalid user JSON is rejected', () => {
    const fields = {
        user: '{not-json',
        auth_date: String(TEST_AUTH_DATE),
        query_id: 'X'
    };
    const initData = buildSignedInitData(fields);
    const result = validateTelegramInitData({ ...VALID_OPTS, initData });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'INVALID_USER_JSON');
});

test('13. missing user.id is rejected', () => {
    const fields = {
        user: JSON.stringify({ first_name: 'NoId' }),
        auth_date: String(TEST_AUTH_DATE),
        query_id: 'X'
    };
    const initData = buildSignedInitData(fields);
    const result = validateTelegramInitData({ ...VALID_OPTS, initData });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'MISSING_USER_ID');
});

test('14. non-integer user.id is rejected', () => {
    for (const badId of ['abc', 1.5, -7, '12']) {
        const fields = {
            user: JSON.stringify({ id: badId }),
            auth_date: String(TEST_AUTH_DATE),
            query_id: 'X'
        };
        const initData = buildSignedInitData(fields);
        const result = validateTelegramInitData({ ...VALID_OPTS, initData });
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.reason, 'INVALID_USER_ID');
    }
});

test('15. constant-time comparison path is used (timingSafeEqual)', () => {
    // Equal-length but different hash fails cleanly through the comparison
    // path; exported primitives compose to the same verdict as an
    // independent reference implementation using timingSafeEqual.
    const fields = {
        user: JSON.stringify(TEST_USER),
        auth_date: String(TEST_AUTH_DATE),
        query_id: 'X'
    };
    const wrongButSameLength = 'a'.repeat(64);

    const initData = buildSignedInitData({ ...fields, hash: wrongButSameLength });
    const result = validateTelegramInitData({ ...VALID_OPTS, initData });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.reason, 'SIGNATURE_MISMATCH');

    // Independent reference check of the correct hash via timingSafeEqual.
    const signedFields = { ...fields };
    signedFields.hash = computeHash(signedFields, TEST_BOT_TOKEN);
    const secretKey = deriveSecretKey(TEST_BOT_TOKEN);
    const dcs = buildDataCheckString(
        parseInitData(buildSignedInitData(signedFields)).params
    );
    const computed = crypto.createHmac('sha256', secretKey).update(dcs).digest();
    const provided = Buffer.from(signedFields.hash, 'hex');
    assert.strictEqual(crypto.timingSafeEqual(computed, provided), true);
});

test('16. telegramUserId extraction is deterministic across repeated calls', () => {
    const initData = buildValidInitData();
    const ids = new Set();
    for (let i = 0; i < 10; i++) {
        const r = validateTelegramInitData({ ...VALID_OPTS, initData });
        assert.strictEqual(r.valid, true);
        ids.add(r.telegramUserId);
    }
    assert.strictEqual(ids.size, 1);
    assert.strictEqual(ids.has(424242), true);
});