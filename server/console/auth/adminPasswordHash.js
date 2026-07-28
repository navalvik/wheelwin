/**
 * R6.1 — Administrator password hashing (scrypt).
 * Passwords are never stored in plain text in configuration.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_OPTIONS = Object.freeze({
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
});

const KEY_LENGTH = 64;

const PREFIX = "scrypt:";

export function hashAdminPassword(password) {

    const salt = randomBytes(16);

    const hash = scryptSync(
        String(password),
        salt,
        KEY_LENGTH,
        SCRYPT_OPTIONS
    );

    return `${PREFIX}${salt.toString("base64url")}:${hash.toString("base64url")}`;

}

export function verifyAdminPassword(password, encodedHash) {

    if (!encodedHash || typeof encodedHash !== "string") {

        return false;

    }

    if (!encodedHash.startsWith(PREFIX)) {

        return false;

    }

    const body = encodedHash.slice(PREFIX.length);

    const separator = body.indexOf(":");

    if (separator <= 0) {

        return false;

    }

    const salt = Buffer.from(body.slice(0, separator), "base64url");

    const expected = Buffer.from(body.slice(separator + 1), "base64url");

    if (salt.length === 0 || expected.length === 0) {

        return false;

    }

    const actual = scryptSync(
        String(password),
        salt,
        expected.length,
        SCRYPT_OPTIONS
    );

    if (actual.length !== expected.length) {

        return false;

    }

    return timingSafeEqual(actual, expected);

}

export function isScryptPasswordHash(value) {

    return typeof value === "string" && value.startsWith(PREFIX);

}
