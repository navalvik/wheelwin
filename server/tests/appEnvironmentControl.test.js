/**
 * R6.1 — Application environment control tests.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    hashAdminPassword
} from "../console/auth/adminPasswordHash.js";
import { loadDeveloperAuthConfig } from "../console/auth/developerAuthConfig.js";
import { AppEnvironmentService } from "../console/environment/AppEnvironmentService.js";
import { APP_ENVIRONMENT } from "../console/environment/AppEnvironment.js";
import { readEnvironmentState } from "../console/environment/environmentStateStore.js";
import { LoggerService } from "../services/LoggerService.js";

function buildService(env, stateDir) {

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const config = loadDeveloperAuthConfig({
        ...env,
        APP_ENVIRONMENT_STATE_PATH: join(stateDir, "app-environment.json")
    }, { nodeEnv: "development" });

    return {
        service: new AppEnvironmentService({
            developerConfig: config,
            logger,
            env: {
                ...env,
                APP_ENVIRONMENT_STATE_PATH: join(stateDir, "app-environment.json")
            }
        }),
        config,
        stateDir,
        shutdown() {

            logger.shutdown();

        }
    };

}

const tempRoot = mkdtempSync(join(tmpdir(), "wheelwin-env-"));

try {

    // TESTNET → MAINNET requires password + ENABLE MAINNET
    {

        const hash = hashAdminPassword("mainnet-secret");

        const stack = buildService({
            DEVELOPER_AUTH_SECRET: "unit-test-secret-16chars",
            ADMIN_USERNAME: "admin",
            ADMIN_PASSWORD_HASH: hash,
            APP_ENVIRONMENT: "TESTNET"
        }, join(tempRoot, "mainnet-guard"));

        try {

            const denied = stack.service.switchEnvironment({
                targetEnvironment: "MAINNET",
                password: "wrong",
                confirmationPhrase: "ENABLE MAINNET",
                username: "admin",
                clientIp: "10.0.0.5"
            });

            assert.equal(denied.ok, false);

            const phraseDenied = stack.service.switchEnvironment({
                targetEnvironment: "MAINNET",
                password: "mainnet-secret",
                confirmationPhrase: "ENABLE MAINNET",
                finalConfirmationPhrase: "not-understood",
                username: "admin",
                clientIp: "10.0.0.5"
            });

            assert.equal(phraseDenied.ok, false);

            const understandDenied = stack.service.switchEnvironment({
                targetEnvironment: "MAINNET",
                password: "mainnet-secret",
                confirmationPhrase: "enable mainnet",
                username: "admin",
                clientIp: "10.0.0.5"
            });

            assert.equal(understandDenied.ok, false);

            const ok = stack.service.switchEnvironment({
                targetEnvironment: "MAINNET",
                password: "mainnet-secret",
                confirmationPhrase: "ENABLE MAINNET",
                finalConfirmationPhrase: "I UNDERSTAND",
                username: "admin",
                role: "Administrator",
                sessionId: "sess-test-1",
                clientIp: "10.0.0.5"
            });

            assert.equal(ok.ok, true);

            assert.equal(ok.restartRequired, true);

            const persisted = readEnvironmentState({
                APP_ENVIRONMENT_STATE_PATH: join(stack.stateDir, "app-environment.json")
            });

            assert.equal(persisted.appEnvironment, APP_ENVIRONMENT.MAINNET);

            assert.equal(persisted.tonNetwork, "mainnet");

            console.log("  mainnet protection flow: OK");

        } finally {

            stack.shutdown();

        }

    }

    // MAINNET → TESTNET requires password
    {

        const hash = hashAdminPassword("switch-back");

        const stack = buildService({
            DEVELOPER_AUTH_SECRET: "unit-test-secret-16chars",
            ADMIN_USERNAME: "admin",
            ADMIN_PASSWORD_HASH: hash,
            APP_ENVIRONMENT: "MAINNET"
        }, join(tempRoot, "mainnet-downgrade"));

        try {

            const ok = stack.service.switchEnvironment({
                targetEnvironment: "TESTNET",
                password: "switch-back",
                username: "admin",
                clientIp: "192.168.1.20"
            });

            assert.equal(ok.ok, true);

            console.log("  mainnet to testnet switch: OK");

        } finally {

            stack.shutdown();

        }

    }

} finally {

    rmSync(tempRoot, { recursive: true, force: true });

}

console.log("appEnvironmentControl.test.js: all assertions passed");
