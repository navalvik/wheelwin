/**
 * R7.0C — Configuration validation & secrets tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigurationManager } from "../config/ConfigurationManager.js";
import { ConfigurationError } from "../config/ConfigurationError.js";
import { OwnerConfiguration } from "../config/OwnerConfiguration.js";

const EXAMPLE_WALLET = "EQOwnerConfigExampleWalletDoNotUseInProductionXX";

function writeOwner(dir, body = { ownerWallet: EXAMPLE_WALLET }) {

    const path = join(dir, "owner.json");

    writeFileSync(
        path,
        typeof body === "string" ? body : `${JSON.stringify(body)}\n`
    );

    return path;

}

function baseEnv(overrides = {}) {

    return {
        PORT: "3001",
        HOST: "0.0.0.0",
        CLIENT_ORIGIN: "http://localhost:5173",
        NODE_ENV: "development",
        ROOM_MAX_PLAYERS: "3",
        TON_NETWORK: "testnet",
        TON_DEPLOY_MODE: "stub",
        LOG_LEVEL: "info",
        METRICS_ENABLED: "true",
        GRACEFUL_SHUTDOWN_TIMEOUT_MS: "30000",
        DEVELOPER_AUTH_ENABLED: "false",
        ...overrides
    };

}

function loadWith(env, ownerBody) {

    ConfigurationManager.resetForTests();

    OwnerConfiguration.resetForTests();

    const dir = mkdtempSync(join(tmpdir(), "ww-cfg-"));

    const ownerConfigPath = writeOwner(dir, ownerBody);

    return ConfigurationManager.load({
        env: baseEnv(env),
        ownerConfigPath,
        resetForTests: true
    });

}

function assertFails(env, ownerBody, keyFragment) {

    ConfigurationManager.resetForTests();

    OwnerConfiguration.resetForTests();

    const dir = mkdtempSync(join(tmpdir(), "ww-cfg-fail-"));

    let ownerConfigPath;

    if (ownerBody === null) {

        ownerConfigPath = join(dir, "missing-owner.json");

    } else {

        ownerConfigPath = writeOwner(dir, ownerBody);

    }

    assert.throws(
        () => ConfigurationManager.load({
            env: baseEnv(env),
            ownerConfigPath,
            resetForTests: true
        }),
        (error) => {

            assert.equal(error instanceof ConfigurationError, true);

            assert.match(error.message, /Configuration validation failed/);

            if (keyFragment) {

                assert.match(error.message, new RegExp(keyFragment));

            }

            // Secrets must never appear in clear text when present in env.
            assert.doesNotMatch(error.message, /super-secret-password-value/i);

            assert.doesNotMatch(error.message, /ton-mnemonic-should-stay-hidden/i);

            return true;

        }
    );

}

// --- Missing required variables ---
{
    assertFails({ PORT: "" }, undefined, "PORT");

    assertFails({ HOST: "" }, undefined, "HOST");

    assertFails({ CLIENT_ORIGIN: "" }, undefined, "CLIENT_ORIGIN");

    assertFails({ ROOM_MAX_PLAYERS: "" }, undefined, "ROOM_MAX_PLAYERS");

    assertFails({ TON_NETWORK: "" }, undefined, "TON_NETWORK");

    console.log("  missing required variables: OK");
}

// --- Invalid integer ---
{
    assertFails({ PORT: "abc" }, undefined, "PORT");

    assertFails({ ROOM_MAX_PLAYERS: "3.5" }, undefined, "ROOM_MAX_PLAYERS");

    assertFails({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: "nope" }, undefined, "GRACEFUL_SHUTDOWN_TIMEOUT_MS");

    console.log("  invalid integer: OK");
}

// --- Invalid boolean ---
{
    assertFails({ METRICS_ENABLED: "maybe" }, undefined, "METRICS_ENABLED");

    assertFails({ DEBUG_SIMULATION_LOOP: "yesplease" }, undefined, "DEBUG_SIMULATION_LOOP");

    console.log("  invalid boolean: OK");
}

// --- Invalid port / timeout ranges ---
{
    assertFails({ PORT: "0" }, undefined, "PORT");

    assertFails({ PORT: "70000" }, undefined, "PORT");

    assertFails({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: "-1" }, undefined, "GRACEFUL_SHUTDOWN_TIMEOUT_MS");

    assertFails({ TON_POLL_INTERVAL_MS: "50" }, undefined, "TON_POLL_INTERVAL_MS");

    console.log("  invalid port/timeout: OK");
}

// --- Invalid JSON owner ---
{
    assertFails({}, "{not-json", "owner\\.json");

    console.log("  invalid JSON owner: OK");
}

// --- Missing owner.json ---
{
    assertFails({}, null, "owner\\.json");

    console.log("  missing owner.json: OK");
}

// --- OWNER_WALLET env without owner.json ---
{
    ConfigurationManager.resetForTests();

    OwnerConfiguration.resetForTests();

    const runtime = ConfigurationManager.load({
        env: baseEnv({ OWNER_WALLET: EXAMPLE_WALLET }),
        ownerConfigPath: join(
            mkdtempSync(join(tmpdir(), "ww-cfg-env-owner-")),
            "missing-owner.json"
        ),
        resetForTests: true
    });

    assert.equal(runtime.owner.loaded, true);

    assert.equal(runtime.owner.ownerWallet, EXAMPLE_WALLET);

    assert.equal(runtime.owner.configPath, "env:OWNER_WALLET");

    console.log("  OWNER_WALLET without owner.json: OK");
}

// --- Missing developer secret (production) ---
{
    assertFails(
        {
            NODE_ENV: "production",
            DEVELOPER_AUTH_ENABLED: "true",
            ADMIN_USERNAME: "ops",
            ADMIN_PASSWORD_HASH: "scrypt:invalid:invalid",
            DEVELOPER_AUTH_SECRET: ""
        },
        undefined,
        "DEVELOPER_AUTH_SECRET"
    );

    console.log("  missing developer secret: OK");
}

// --- Insecure defaults rejected in production ---
{
    assertFails(
        {
            NODE_ENV: "production",
            DEVELOPER_AUTH_ENABLED: "true",
            ADMIN_USERNAME: "developer",
            ADMIN_PASSWORD_HASH: "scrypt:invalid:invalid",
            DEVELOPER_AUTH_PASSWORD: "developer",
            DEVELOPER_AUTH_SECRET: "change-me-developer-console-secret"
        },
        undefined,
        "DEVELOPER_AUTH"
    );

    console.log("  insecure production secrets: OK");
}

// --- Live TON without mnemonic ---
{
    assertFails(
        {
            TON_DEPLOY_MODE: "live",
            TON_DEPLOYER_MNEMONIC: ""
        },
        undefined,
        "TON_DEPLOYER_MNEMONIC"
    );

    console.log("  live TON without mnemonic: OK");
}

// --- Successful startup + immutability + secret policy ---
{
    const runtime = loadWith({
        DEVELOPER_AUTH_ENABLED: "false"
    });

    assert.equal(runtime.profile, "development");

    assert.equal(runtime.server.port, 3001);

    assert.equal(runtime.rooms.maxPlayers, 3);

    assert.equal(Object.isFrozen(runtime), true);

    assert.throws(() => {

        runtime.server.port = 9999;

    }, TypeError);

    const safe = runtime.toSafeSummary();

    const safeJson = JSON.stringify(safe);

    assert.equal(safe.features.developerAuthEnabled, false);

    assert.equal(safe.ton.network, "testnet");

    assert.doesNotMatch(safeJson, /ownerWallet/i);

    assert.doesNotMatch(safeJson, /passwordHash/i);

    assert.doesNotMatch(safeJson, /deployerMnemonic/i);

    assert.equal(safe.owner.loaded, true);

    assert.equal(ConfigurationManager.isLoaded(), true);

    // Secret values must not leak through error sanitization helpers.
    const secretRuntime = loadWith({
        DEVELOPER_AUTH_ENABLED: "true",
        DEVELOPER_AUTH_USERNAME: "devuser",
        DEVELOPER_AUTH_PASSWORD: "super-secret-password-value",
        DEVELOPER_AUTH_SECRET: "a-unique-dev-secret-16"
    });

    const secretSafe = JSON.stringify(secretRuntime.toSafeSummary());

    assert.doesNotMatch(secretSafe, /super-secret-password-value/);

    assert.doesNotMatch(secretSafe, /a-unique-dev-secret-16/);

    assert.equal(secretRuntime.developer.configured, true);

    console.log("  successful startup + immutability + secrets: OK");
}

ConfigurationManager.resetForTests();

OwnerConfiguration.resetForTests();

console.log("configurationValidation.test.js: OK");
