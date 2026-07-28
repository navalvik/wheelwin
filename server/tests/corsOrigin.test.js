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
