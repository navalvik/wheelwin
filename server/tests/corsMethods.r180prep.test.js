/**
 * R18.0-prep — CORS method allow-list must cover every method used by the
 * Developer Console cross-origin API. Regression for the production
 * "Failed to fetch" on DELETE /console/advertisements/:id.
 */
import assert from "node:assert/strict";

import { loadServerConfig } from "../config/server.js";

const config = loadServerConfig({
    PORT: "3001",
    HOST: "0.0.0.0",
    CLIENT_ORIGIN: "https://wheelwin-nine.vercel.app",
    NODE_ENV: "production"
});

// --- Test 1: all console API methods are allowed ------------------------------

for (const method of ["GET", "POST", "DELETE", "PATCH", "PUT"]) {

    assert.ok(
        config.cors.methods.includes(method),
        `CORS methods must include ${method}`
    );

}

console.log("  test 1 (CORS methods cover console API) passed");

// --- Test 2: origin validator still enforced -----------------------------------

function checkOrigin(origin) {

    return new Promise((resolve) => {

        config.corsOrigin(origin, (err, allow) => resolve(!err && allow === true));

    });

}

assert.equal(
    await checkOrigin("https://wheelwin-nine.vercel.app"),
    true,
    "configured client origin must remain allowed"
);

assert.equal(
    await checkOrigin("https://evil.example.com"),
    false,
    "foreign origins must still be denied"
);

console.log("  test 2 (origin validation unchanged) passed");

console.log("corsMethods.r180prep.test.js: all passed");
