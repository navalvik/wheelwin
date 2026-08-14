/**
 * R17.8M.1 — Admin TON deployer wallet observability tests.
 */

import assert from "node:assert/strict";
import http from "node:http";

import express from "express";
import { toNano } from "@ton/core";

import { hashAdminPassword } from "../console/auth/adminPasswordHash.js";
import { loadDeveloperAuthConfig } from "../console/auth/developerAuthConfig.js";
import { DeveloperAuthService } from "../console/auth/DeveloperAuthService.js";
import { registerDeveloperConsoleRoutes } from "../console/registerDeveloperConsoleRoutes.js";
import { createDeveloperAuthMiddleware } from "../console/auth/developerAuthMiddleware.js";
import { buildDeployerWalletStatus } from "../console/projectionBuilders/buildDeployerWalletStatus.js";
import { evaluateDeployerWalletReadiness } from "../console/projectionBuilders/evaluateDeployerWalletReadiness.js";
import { LoggerService } from "../services/LoggerService.js";

const TEST_MNEMONIC = [
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "abandon",
    "abandon", "abandon", "abandon", "abandon", "abandon", "about"
].join(" ");

const SECRET_MARKERS = [
    "mnemonic",
    "privateKey",
    "secret",
    "seed",
    "TON_DEPLOYER_MNEMONIC"
];

function assertNoSecrets(payload) {

    const serialized = JSON.stringify(payload).toLowerCase();

    for (const marker of SECRET_MARKERS) {

        assert.equal(
            serialized.includes(marker.toLowerCase()),
            false,
            `Response must not contain "${marker}"`
        );

    }

    assert.equal(
        serialized.includes(TEST_MNEMONIC.split(" ")[0]),
        false,
        "Response must not contain mnemonic words"
    );

}

function createStack(projectionService) {

    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const adminHash = hashAdminPassword("admin-pass-r178m1");
    const viewerHash = hashAdminPassword("viewer-pass-r178m1");

    const config = loadDeveloperAuthConfig({
        DEVELOPER_AUTH_SECRET: "unit-test-secret-16chars",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD_HASH: adminHash,
        VIEWER_USERNAME: "viewer",
        VIEWER_PASSWORD_HASH: viewerHash,
        DEVELOPER_AUTH_ENABLED: "true"
    }, { nodeEnv: "development" });

    const authService = new DeveloperAuthService({ config, logger });

    const app = express();

    app.use(express.json({ limit: "32kb" }));

    registerDeveloperConsoleRoutes(app, projectionService, {
        authMiddleware: createDeveloperAuthMiddleware(authService),
        authService
    });

    const server = http.createServer(app);

    return {
        authService,
        server,
        logger,
        tokenFor(username, password) {

            const result = authService.login({
                username,
                password,
                clientIp: "127.0.0.1"
            });

            assert.equal(result.ok, true);

            return result.session.accessToken;

        },
        async listen() {

            await new Promise((resolve) => {

                server.listen(0, "127.0.0.1", resolve);

            });

            const { port } = server.address();

            this.baseUrl = `http://127.0.0.1:${port}`;

            return this.baseUrl;

        },
        async request(method, path, { token = null } = {}) {

            const headers = {};

            if (token) {

                headers.Authorization = `Bearer ${token}`;

            }

            const response = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers
            });

            const text = await response.text();
            let json = null;

            if (text) {

                try {

                    json = JSON.parse(text);

                } catch {

                    json = text;

                }

            }

            return {
                status: response.status,
                json
            };

        },
        async close() {

            await new Promise((resolve, reject) => {

                server.close((error) => (error ? reject(error) : resolve()));

            });

            logger.shutdown();

        }
    };

}

async function runReadinessTests() {

    const errorCase = evaluateDeployerWalletReadiness(toNano("0.007"));

    assert.equal(errorCase.status, "ERROR");
    assert.equal(errorCase.reason, "INSUFFICIENT_DEPLOYER_BALANCE");

    const warningCase = evaluateDeployerWalletReadiness(toNano("0.1"));

    assert.equal(warningCase.status, "WARNING");
    assert.equal(warningCase.reason, "LOW_DEPLOYER_RESERVE");

    const readyCase = evaluateDeployerWalletReadiness(toNano("0.5"));

    assert.equal(readyCase.status, "READY");
    assert.equal(readyCase.reason, "DEPLOYER_WALLET_READY");

}

async function runBuilderSecretTest() {

    const status = await buildDeployerWalletStatus({
        runtimeConfig: {
            ton: {
                deployerMnemonic: TEST_MNEMONIC,
                network: "testnet"
            }
        },
        tonService: {
            async getBalance() {

                return toNano("0.007");

            },
            async getSeqno() {

                return 100;

            }
        }
    });

    assert.equal(status.walletType, "WalletContractV4R2");
    assert.equal(status.walletId, 698983191);
    assert.equal(status.readiness.status, "ERROR");
    assertNoSecrets(status);

}

async function runHttpTests() {

    const projectionService = {
        async buildDeployerWalletStatus() {

            return buildDeployerWalletStatus({
                runtimeConfig: {
                    ton: {
                        deployerMnemonic: TEST_MNEMONIC,
                        network: "testnet"
                    }
                },
                tonService: {
                    async getBalance() {

                        return toNano("0.1");

                    },
                    async getSeqno() {

                        return 42;

                    }
                }
            });

        }
    };

    const stack = createStack(projectionService);

    await stack.listen();

    try {

        const adminToken = stack.tokenFor("admin", "admin-pass-r178m1");
        const viewerToken = stack.tokenFor("viewer", "viewer-pass-r178m1");

        const adminResponse = await stack.request(
            "GET",
            "/console/ton/deployer-wallet",
            { token: adminToken }
        );

        assert.equal(adminResponse.status, 200);
        assert.equal(adminResponse.json.walletType, "WalletContractV4R2");
        assert.equal(adminResponse.json.readiness.status, "WARNING");
        assertNoSecrets(adminResponse.json);

        const viewerResponse = await stack.request(
            "GET",
            "/console/ton/deployer-wallet",
            { token: viewerToken }
        );

        assert.equal(viewerResponse.status, 403);
        assert.equal(viewerResponse.json.error, "Forbidden");

    } finally {

        await stack.close();

    }

}

async function main() {

    await runReadinessTests();
    await runBuilderSecretTest();
    await runHttpTests();

    process.stdout.write("deployerWalletObservability.test.js passed\n");

}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
