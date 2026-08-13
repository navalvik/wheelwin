/**
 * R14.3 — Advertisement Manager API + Debug Console backend tests.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";

import { AdvertisementManager } from "../advertisement/AdvertisementManager.js";
import { ADVERTISEMENT_LIMITS } from "../advertisement/advertisementTypes.js";
import { hashAdminPassword } from "../console/auth/adminPasswordHash.js";
import { loadDeveloperAuthConfig } from "../console/auth/developerAuthConfig.js";
import { DeveloperAuthService } from "../console/auth/DeveloperAuthService.js";
import { registerAdvertisementRoutes } from "../console/registerAdvertisementRoutes.js";
import { LoggerService } from "../services/LoggerService.js";

function tinyJpeg() {

    return Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03]);

}

function createStack() {

    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-ads-r143-"));
    const logger = new LoggerService({ logLevel: "error" });

    logger.initialize();

    const adminHash = hashAdminPassword("admin-pass-r143");
    const viewerHash = hashAdminPassword("viewer-pass-r143");

    const config = loadDeveloperAuthConfig({
        DEVELOPER_AUTH_SECRET: "unit-test-secret-16chars",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD_HASH: adminHash,
        VIEWER_USERNAME: "viewer",
        VIEWER_PASSWORD_HASH: viewerHash,
        DEVELOPER_AUTH_ENABLED: "true"
    }, { nodeEnv: "development" });

    const authService = new DeveloperAuthService({ config, logger });

    const advertisementManager = new AdvertisementManager({
        logger,
        dataDir
    });

    advertisementManager.initialize();

    const app = express();

    app.use((req, res, next) => {

        const path = req.path || "";

        if (
            req.method === "POST"
            && (
                path === "/console/advertisements/upload"
                || path === "/console/advertisements"
            )
        ) {

            return express.json({ limit: "512kb" })(req, res, next);

        }

        return next();

    });

    app.use(express.json({ limit: "32kb" }));

    registerAdvertisementRoutes(app, {
        authService,
        advertisementManager
    });

    const server = http.createServer(app);

    return {
        dataDir,
        authService,
        advertisementManager,
        server,
        logger,
        async listen() {

            await new Promise((resolve) => {

                server.listen(0, "127.0.0.1", resolve);

            });

            const { port } = server.address();

            this.baseUrl = `http://127.0.0.1:${port}`;

            return this.baseUrl;

        },
        tokenFor(username, password) {

            const result = authService.login({
                username,
                password,
                clientIp: "127.0.0.1"
            });

            assert.equal(result.ok, true);

            return result.session.accessToken;

        },
        async request(method, path, { token = null, body = null } = {}) {

            const headers = {};

            if (token) {

                headers.Authorization = `Bearer ${token}`;

            }

            let payload;

            if (body != null) {

                headers["Content-Type"] = "application/json";
                payload = JSON.stringify(body);

            }

            const response = await fetch(`${this.baseUrl}${path}`, {
                method,
                headers,
                body: payload
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
            rmSync(dataDir, { recursive: true, force: true });

        }
    };

}

const stack = createStack();

await stack.listen();

try {

    const adminToken = stack.tokenFor("admin", "admin-pass-r143");
    const viewerToken = stack.tokenFor("viewer", "viewer-pass-r143");

    // 1. Administrator can list campaigns.
    {

        const listed = await stack.request("GET", "/console/advertisements", {
            token: adminToken
        });

        assert.equal(listed.status, 200);
        assert.ok(Array.isArray(listed.json.campaigns));
        console.log("  1. Administrator can list campaigns");

    }

    // 2. Viewer can list campaigns.
    {

        const listed = await stack.request("GET", "/console/advertisements", {
            token: viewerToken
        });

        assert.equal(listed.status, 200);
        assert.ok(Array.isArray(listed.json.campaigns));
        console.log("  2. Viewer can list campaigns");

    }

    // 3. Viewer cannot mutate.
    {

        const createDenied = await stack.request("POST", "/console/advertisements", {
            token: viewerToken,
            body: {
                filename: "1_denied.jpg",
                advertiserName: "No",
                destinationUrl: "https://example.com",
                contentBase64: tinyJpeg().toString("base64")
            }
        });

        assert.equal(createDenied.status, 403);

        const uploadDenied = await stack.request(
            "POST",
            "/console/advertisements/upload",
            {
                token: viewerToken,
                body: {
                    filename: "1_denied.jpg",
                    contentBase64: tinyJpeg().toString("base64")
                }
            }
        );

        assert.equal(uploadDenied.status, 403);
        console.log("  3. Viewer cannot mutate");

    }

    // 4. Administrator can create campaign.
    let campaignId;

    {

        const created = await stack.request("POST", "/console/advertisements", {
            token: adminToken,
            body: {
                filename: "1_partner.jpg",
                advertiserName: "Partner Co",
                destinationUrl: "https://example.com/offer",
                priority: 1,
                expiresAt: "2099-01-01T00:00:00.000Z",
                contentBase64: tinyJpeg().toString("base64")
            }
        });

        assert.equal(created.status, 201);
        assert.equal(created.json.filename, "1_partner.jpg");
        assert.equal(created.json.advertiserName, "Partner Co");
        assert.equal(created.json.status, "ACTIVE");
        campaignId = created.json.id;
        assert.ok(campaignId);

        const detail = await stack.request(
            "GET",
            `/console/advertisements/${campaignId}`,
            { token: viewerToken }
        );

        assert.equal(detail.status, 200);
        assert.equal(detail.json.id, campaignId);
        console.log("  4. Administrator can create campaign");

    }

    // 5. Administrator can upload valid banner.
    {

        const uploaded = await stack.request(
            "POST",
            "/console/advertisements/upload",
            {
                token: adminToken,
                body: {
                    filename: "2_upload.png",
                    contentBase64: Buffer.alloc(32, 7).toString("base64")
                }
            }
        );

        assert.equal(uploaded.status, 201);
        assert.equal(uploaded.json.filename, "2_upload.png");
        assert.equal(uploaded.json.extension, "png");
        console.log("  5. Administrator can upload valid banner");

    }

    // 6. Invalid banner upload rejected.
    {

        const badExt = await stack.request(
            "POST",
            "/console/advertisements/upload",
            {
                token: adminToken,
                body: {
                    filename: "3_bad.mp4",
                    contentBase64: Buffer.alloc(16, 1).toString("base64")
                }
            }
        );

        assert.equal(badExt.status, 400);
        assert.ok(
            badExt.json.code === "INVALID_FILENAME"
            || badExt.json.code === "INVALID_EXTENSION"
        );

        const traversal = await stack.request(
            "POST",
            "/console/advertisements/upload",
            {
                token: adminToken,
                body: {
                    filename: "../etc/passwd.jpg",
                    contentBase64: tinyJpeg().toString("base64")
                }
            }
        );

        assert.equal(traversal.status, 400);
        assert.equal(traversal.json.code, "PATH_TRAVERSAL");
        console.log("  6. Invalid banner upload rejected");

    }

    // 7. Oversized GIF rejected.
    {

        const oversized = await stack.request(
            "POST",
            "/console/advertisements/upload",
            {
                token: adminToken,
                body: {
                    filename: "4_big.gif",
                    contentBase64: Buffer.alloc(
                        ADVERTISEMENT_LIMITS.MAX_GIF_BYTES + 1,
                        2
                    ).toString("base64")
                }
            }
        );

        assert.equal(oversized.status, 400);
        assert.equal(oversized.json.code, "GIF_TOO_LARGE");
        console.log("  7. Oversized GIF rejected");

    }

    // 8. Invalid URL rejected.
    {

        const badUrl = await stack.request("POST", "/console/advertisements", {
            token: adminToken,
            body: {
                filename: "5_url.jpg",
                advertiserName: "Bad",
                destinationUrl: "javascript:alert(1)",
                contentBase64: tinyJpeg().toString("base64")
            }
        });

        assert.equal(badUrl.status, 400);
        assert.equal(badUrl.json.code, "DANGEROUS_URL_SCHEME");
        console.log("  8. Invalid URL rejected");

    }

    // 9. Administrator can disable campaign.
    {

        const disabled = await stack.request(
            "POST",
            `/console/advertisements/${campaignId}/disable`,
            { token: adminToken }
        );

        assert.equal(disabled.status, 200);
        assert.equal(disabled.json.status, "DISABLED");
        console.log("  9. Administrator can disable campaign");

    }

    // 10. Delete does not remove history.
    {

        const deleted = await stack.request(
            "DELETE",
            `/console/advertisements/${campaignId}`,
            { token: adminToken }
        );

        assert.equal(deleted.status, 200);
        assert.equal(deleted.json.deleted, true);
        assert.equal(deleted.json.historyPreserved, true);

        const history = stack.advertisementManager.listHistory({
            role: "Administrator"
        });

        assert.ok(history.length >= 1);
        assert.ok(
            history.some((entry) => entry.advertisementId === campaignId
                && entry.type === "CAMPAIGN_DELETED")
        );

        const listed = await stack.request("GET", "/console/advertisements", {
            token: adminToken
        });

        assert.equal(
            listed.json.campaigns.some((c) => c.id === campaignId),
            false
        );

        console.log("  10. Delete does not remove history");

    }

} finally {

    await stack.close();

}

console.log("advertisement.r143.test.js: all assertions passed");
