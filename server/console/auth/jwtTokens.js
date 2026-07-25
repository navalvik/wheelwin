/**
 * R6.1 — Minimal HS256 JWT helpers (Node crypto only; no gameplay deps).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

function base64UrlEncode(value) {

    return Buffer.from(value)
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

}

function base64UrlDecode(value) {

    const padded = value.replace(/-/g, "+").replace(/_/g, "/");

    const pad = padded.length % 4 === 0
        ? ""
        : "=".repeat(4 - (padded.length % 4));

    return Buffer.from(padded + pad, "base64").toString("utf8");

}

function signInput(input, secret) {

    return createHmac("sha256", secret)
        .update(input)
        .digest("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

}

export function signHs256Jwt(payload, secret, expiresInSeconds) {

    const header = { alg: "HS256", typ: "JWT" };

    const now = Math.floor(Date.now() / 1000);

    const body = {
        ...payload,
        iat: now,
        exp: now + expiresInSeconds
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));

    const encodedPayload = base64UrlEncode(JSON.stringify(body));

    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const signature = signInput(signingInput, secret);

    return `${signingInput}.${signature}`;

}

export function verifyHs256Jwt(token, secret) {

    if (!token || typeof token !== "string") {

        return null;

    }

    const parts = token.split(".");

    if (parts.length !== 3) {

        return null;

    }

    const [encodedHeader, encodedPayload, signature] = parts;

    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const expected = signInput(signingInput, secret);

    const left = Buffer.from(signature);

    const right = Buffer.from(expected);

    if (left.length !== right.length || !timingSafeEqual(left, right)) {

        return null;

    }

    let payload;

    try {

        payload = JSON.parse(base64UrlDecode(encodedPayload));

    } catch {

        return null;

    }

    if (!payload?.exp || payload.exp * 1000 <= Date.now()) {

        return null;

    }

    return payload;

}
