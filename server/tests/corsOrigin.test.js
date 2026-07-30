/**
 * CORS origin validation for host-independent LAN access.
 */

import assert from "node:assert/strict";

import {
    createCorsOriginValidator,
    isAllowedCorsOrigin
} from "../config/corsOrigin.js";

async function allows(clientOrigin, nodeEnv, origin) {

    return isAllowedCorsOrigin(clientOrigin, nodeEnv, origin);

}

// --- explicit whitelist ---

assert.equal(
    await allows("http://localhost:5173", "production", "http://localhost:5173"),
    true
);

assert.equal(
    await allows("http://localhost:5173", "production", "http://192.168.0.100:5173"),
    false
);

// --- development LAN auto-allow ---

assert.equal(
    await allows("http://localhost:5173", "development", "http://192.168.0.100:5173"),
    true
);

assert.equal(
    await allows("http://localhost:5173", "development", "http://127.0.0.1:5173"),
    true
);

assert.equal(
    await allows("http://localhost:5173", "development", "http://10.0.0.5:5173"),
    true
);

assert.equal(
    await allows("http://localhost:5173", "development", "http://172.16.0.5:5173"),
    true
);

// --- production rejects unknown LAN ---

assert.equal(
    await allows("http://localhost:5173", "production", "http://192.168.0.100:5173"),
    false
);

// --- comma-separated origins ---

assert.equal(
    await allows(
        ["http://localhost:5173", "http://game.example.com"],
        "production",
        "http://game.example.com"
    ),
    true
);

// --- production multi-origin (local + LAN + Vercel) ---

const PRODUCTION_ORIGINS = [
    "http://localhost:5173",
    "http://192.168.0.104:5173",
    "https://wheelwin-nine.vercel.app"
];

for (const origin of PRODUCTION_ORIGINS) {

    assert.equal(
        await allows(PRODUCTION_ORIGINS, "production", origin),
        true,
        `production must allow ${origin}`
    );

}

assert.equal(
    await allows(
        PRODUCTION_ORIGINS,
        "production",
        "https://other-frontend.example.com"
    ),
    false,
    "unknown production origin must be denied"
);

// --- missing Origin (same-site tools) ---

await new Promise((resolve, reject) => {

    createCorsOriginValidator("http://localhost:5173", "production")(
        undefined,
        (error, allowed) => {

            if (error) {

                reject(error);

                return;

            }

            try {

                assert.equal(allowed, true);

                resolve();

            } catch (assertError) {

                reject(assertError);

            }

        }
    );

});

console.log("corsOrigin.test.js passed");
