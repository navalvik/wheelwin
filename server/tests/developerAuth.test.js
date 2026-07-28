/**
 * R6.1 / R6.2 — Developer dashboard authentication tests.
 */
import assert from "node:assert/strict";

import {
    hashAdminPassword,
    verifyAdminPassword
} from "../console/auth/adminPasswordHash.js";
import {
    loadDeveloperAuthConfig,
    resolveLoginIdentity,
    verifyAdministratorPassword
} from "../console/auth/developerAuthConfig.js";
import { DeveloperAuthService } from "../console/auth/DeveloperAuthService.js";
import { LoggerService } from "../services/LoggerService.js";
import { DEVELOPER_ROLES } from "../console/auth/developerRoles.js";
import { canPerformAdministratorActions } from "../console/auth/developerRoles.js";

function buildAuthService(env) {

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const config = loadDeveloperAuthConfig(env, { nodeEnv: "development" });

    return {
        service: new DeveloperAuthService({ config, logger }),
        config,
        shutdown() {

            logger.shutdown();

        }
    };

}

// scrypt hash round-trip
{
    const hash = hashAdminPassword("wheelwin-admin-test-password");

    assert.equal(verifyAdminPassword("wheelwin-admin-test-password", hash), true);

    assert.equal(verifyAdminPassword("wrong-password", hash), false);

    console.log("  scrypt password hash: OK");
}

// ADMIN_USERNAME + ADMIN_PASSWORD_HASH login
{
    const hash = hashAdminPassword("admin-pass-12345");

    const stack = buildAuthService({
        DEVELOPER_AUTH_SECRET: "unit-test-secret-16chars",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD_HASH: hash,
        DEVELOPER_AUTH_ENABLED: "true"
    });

    try {

        const ok = stack.service.login({
            username: "admin",
            password: "admin-pass-12345",
            clientIp: "127.0.0.1"
        });

        assert.equal(ok.ok, true);

        assert.equal(ok.session.user.role, DEVELOPER_ROLES.ADMINISTRATOR);

        assert.ok(ok.session.sessionId);

        assert.equal(canPerformAdministratorActions(ok.session.user.role), true);

        const bad = stack.service.login({
            username: "admin",
            password: "nope",
            clientIp: "127.0.0.1"
        });

        assert.equal(bad.ok, false);

        console.log("  administrator login: OK");

    } finally {

        stack.shutdown();

    }

}

// viewer login
{
    const adminHash = hashAdminPassword("admin-pass-12345");

    const viewerHash = hashAdminPassword("viewer-pass-12345");

    const stack = buildAuthService({
        DEVELOPER_AUTH_SECRET: "unit-test-secret-16chars",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD_HASH: adminHash,
        VIEWER_USERNAME: "viewer",
        VIEWER_PASSWORD_HASH: viewerHash,
        DEVELOPER_AUTH_ENABLED: "true"
    });

    try {

        const identity = resolveLoginIdentity("viewer", "viewer-pass-12345", stack.config);

        assert.equal(identity.role, DEVELOPER_ROLES.VIEWER);

        const ok = stack.service.login({
            username: "viewer",
            password: "viewer-pass-12345",
            clientIp: "10.0.0.2"
        });

        assert.equal(ok.ok, true);

        assert.equal(ok.session.user.role, DEVELOPER_ROLES.VIEWER);

        assert.equal(ok.session.user.readOnly, true);

        assert.equal(canPerformAdministratorActions(ok.session.user.role), false);

        console.log("  viewer login: OK");

    } finally {

        stack.shutdown();

    }

}

// legacy dev plain password fallback
{
    const stack = buildAuthService({
        DEVELOPER_AUTH_SECRET: "unit-test-secret-16chars",
        DEVELOPER_AUTH_USERNAME: "developer",
        DEVELOPER_AUTH_PASSWORD: "developer",
        DEVELOPER_AUTH_ENABLED: "true",
        NODE_ENV: "development"
    });

    try {

        assert.equal(
            verifyAdministratorPassword("developer", stack.config),
            true
        );

        console.log("  legacy dev password fallback: OK");

    } finally {

        stack.shutdown();

    }

}

console.log("developerAuth.test.js: all assertions passed");
