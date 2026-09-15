/**
 * R21 — Cross-runtime room network handoff server contract tests.
 *
 * Coverage:
 *  1. claim with valid shared secret + matching Telegram identity  -> success
 *  2. claim with valid secret + wrong Telegram identity            -> rejected
 *  3. claim with wrong / missing secret                            -> rejected
 *  4. claim for expired / nonexistent handoff                      -> rejected
 *  5. complete with valid secret + active claim                    -> success
 *  6. complete without claim                                       -> rejected
 *  7. complete with wrong Telegram identity                        -> rejected
 *  8. repeated complete remains idempotent (store semantics)
 *  9. missing server configuration fails closed (routes + client)
 * 10. secret never present in response bodies or logs
 * 11. caller-supplied ownership fields are rejected (fail closed)
 * 12. Mainnet client <-> Testnet routes end-to-end integration
 */
import express from "express";

import { RoomNetworkHandoffStore } from "../network/RoomNetworkHandoffStore.js";
import {
    registerRoomNetworkHandoffRoutes,
    resolveRoomNetworkHandoffSecret
} from "../network/registerRoomNetworkHandoffRoutes.js";
import {
    RoomNetworkHandoffClient,
    resolveRoomNetworkHandoffClientConfig
} from "../network/RoomNetworkHandoffClient.js";
import {
    NETWORK_HANDOFF_ENDPOINTS,
    ROOM_NETWORK_HANDOFF_SECRET_HEADER
} from "../network/roomNetworkHandoffProtocol.js";

const SECRET = "r21-test-shared-secret-do-not-use-in-production";
const OWNER_TELEGRAM_USER_ID = "900001";
const WRONG_TELEGRAM_USER_ID = "900002";

function assert(condition, message) {

    if (!condition) {

        throw new Error(message);

    }

}

function assertEqual(actual, expected, message) {

    assert(
        actual === expected,
        `${message} (expected ${JSON.stringify(expected)},`
            + ` got ${JSON.stringify(actual)})`
    );

}

function buildRecordingLogger() {

    const messages = [];

    return {
        messages,
        info(message) {

            messages.push(String(message));

        },
        warn(message) {

            messages.push(String(message));

        },
        error(message) {

            messages.push(String(message));

        },
        startupLine() {}
    };

}

async function startHandoffServer(
    { secret = SECRET, store = null } = {}
) {

    const app = express();

    app.use(express.json({ limit: "32kb" }));

    const handoffStore = store ?? new RoomNetworkHandoffStore();

    const logger = buildRecordingLogger();

    registerRoomNetworkHandoffRoutes(app, {
        handoffStore,
        logger,
        secret
    });

    const server = app.listen(0, "127.0.0.1");

    await new Promise((resolve) => server.once("listening", resolve));

    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    return {
        server,
        baseUrl,
        handoffStore,
        logger,

        async close() {

            await new Promise((resolve) => server.close(resolve));

        }
    };

}

const capturedResponseBodyTexts = [];

async function postJson(url, path, body, headers = {}) {

    const response = await fetch(`${url}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...headers
        },
        body: typeof body === "string"
            ? body
            : JSON.stringify(body ?? {})
    });

    const responseText = await response.text();

    let json = null;

    try {

        json = JSON.parse(responseText);

    } catch {

        json = null;

    }

    capturedResponseBodyTexts.push(responseText);

    return {
        status: response.status,
        body: json
    };

}

function claimHeaders(secret = SECRET) {

    return secret === null
        ? {}
        : { [ROOM_NETWORK_HANDOFF_SECRET_HEADER]: secret };

}

async function testGroupA() {

    // Test 1 — claim: valid secret + matching Telegram identity -> success.
    {
        const runtime = await startHandoffServer();

        try {

            const { handoffId } = runtime.handoffStore.create({
                roomId: "ROOM-R21-A1",
                ownerPlayerId: "player-r21-1",
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            const response = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
                },
                claimHeaders()
            );

            assertEqual(response.status, 200, "claim must succeed");
            assertEqual(response.body?.ok, true, "claim body ok");
            assertEqual(response.body?.state, "claimed", "claim state");
            assertEqual(
                response.body?.mainnetRoomId,
                null,
                "claim has no mainnet room yet"
            );
            assert(
                response.body?.ownerPlayerId === undefined
                    && response.body?.roomId === undefined,
                "claim response must not expose internal record fields"
            );

            console.log("  Test 1 (claim valid secret + owner identity) passed");

        } finally {

            await runtime.close();

        }
    }

    // Test 2 — claim: valid secret + wrong Telegram identity -> rejected.
    {
        const runtime = await startHandoffServer();

        try {

            const { handoffId } = runtime.handoffStore.create({
                roomId: "ROOM-R21-A2",
                ownerPlayerId: "player-r21-2",
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            const response = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                {
                    handoffId,
                    ownerTelegramUserId: WRONG_TELEGRAM_USER_ID
                },
                claimHeaders()
            );

            assertEqual(response.status, 403, "wrong owner must be forbidden");
            assertEqual(
                response.body?.reason,
                "OWNER_MISMATCH",
                "wrong owner reason"
            );

            console.log("  Test 2 (claim wrong identity rejected) passed");

        } finally {

            await runtime.close();

        }
    }

    // Test 3 — claim: wrong / missing secret -> rejected.
    {
        const runtime = await startHandoffServer();

        try {

            const { handoffId } = runtime.handoffStore.create({
                roomId: "ROOM-R21-A3",
                ownerPlayerId: "player-r21-3",
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            const wrongSecret = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
                },
                claimHeaders("definitely-not-the-secret")
            );

            assertEqual(
                wrongSecret.status,
                401,
                "wrong secret must be unauthorized"
            );
            assertEqual(
                wrongSecret.body?.reason,
                "UNAUTHORIZED",
                "wrong secret reason"
            );

            const missingSecret = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
                },
                claimHeaders(null)
            );

            assertEqual(
                missingSecret.status,
                401,
                "missing secret must be unauthorized"
            );

            const unchanged = runtime.handoffStore.claim({
                handoffId,
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            assertEqual(
                unchanged.state,
                "claimed",
                "unauthenticated attempts must not consume the claim lease"
            );

            console.log("  Test 3 (claim wrong/missing secret rejected) passed");

        } finally {

            await runtime.close();

        }
    }

    // Test 4 — claim: expired / nonexistent handoff -> rejected.
    {
        let clock = 1_000_000;

        const store = new RoomNetworkHandoffStore({ now: () => clock });

        const runtime = await startHandoffServer({ store });

        try {

            const missing = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                {
                    handoffId: "does-not-exist",
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
                },
                claimHeaders()
            );

            assertEqual(missing.status, 404, "missing handoff must be not found");
            assertEqual(
                missing.body?.reason,
                "NOT_FOUND_OR_EXPIRED",
                "missing handoff reason"
            );

            const { handoffId } = store.create({
                roomId: "ROOM-R21-A4",
                ownerPlayerId: "player-r21-4",
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            clock += 2 * 60 * 1000 + 1;

            const expired = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
                },
                claimHeaders()
            );

            assertEqual(expired.status, 404, "expired handoff must be not found");
            assertEqual(
                expired.body?.reason,
                "NOT_FOUND_OR_EXPIRED",
                "expired handoff reason"
            );

            console.log("  Test 4 (claim expired/nonexistent rejected) passed");

        } finally {

            await runtime.close();

        }
    }

    // Test 5 — complete: valid secret + active claim -> success.
    {
        const runtime = await startHandoffServer();

        try {

            const { handoffId } = runtime.handoffStore.create({
                roomId: "ROOM-R21-A5",
                ownerPlayerId: "player-r21-5",
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            const claim = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
                },
                claimHeaders()
            );

            assertEqual(claim.status, 200, "claim before complete must succeed");

            const complete = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.COMPLETE,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID,
                    mainnetRoomId: "MN-ROOM-R21-5"
                },
                claimHeaders()
            );

            assertEqual(complete.status, 200, "complete must succeed");
            assertEqual(complete.body?.ok, true, "complete body ok");
            assertEqual(complete.body?.state, "completed", "complete state");
            assertEqual(
                complete.body?.mainnetRoomId,
                "MN-ROOM-R21-5",
                "complete mainnet room id"
            );

            console.log("  Test 5 (complete with active claim) passed");

        } finally {

            await runtime.close();

        }
    }

    // Test 6 — complete without claim -> rejected.
    {
        const runtime = await startHandoffServer();

        try {

            const { handoffId } = runtime.handoffStore.create({
                roomId: "ROOM-R21-A6",
                ownerPlayerId: "player-r21-6",
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            const response = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.COMPLETE,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID,
                    mainnetRoomId: "MN-ROOM-R21-6"
                },
                claimHeaders()
            );

            assertEqual(
                response.status,
                409,
                "complete without claim must conflict"
            );
            assertEqual(
                response.body?.reason,
                "CLAIM_REQUIRED",
                "complete without claim reason"
            );

            console.log("  Test 6 (complete without claim rejected) passed");

        } finally {

            await runtime.close();

        }
    }

}

async function testGroupB() {

    // Test 7 — complete with wrong Telegram identity -> rejected.
    {
        const runtime = await startHandoffServer();

        try {

            const { handoffId } = runtime.handoffStore.create({
                roomId: "ROOM-R21-B7",
                ownerPlayerId: "player-r21-7",
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            runtime.handoffStore.claim({
                handoffId,
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            const response = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.COMPLETE,
                {
                    handoffId,
                    ownerTelegramUserId: WRONG_TELEGRAM_USER_ID,
                    mainnetRoomId: "MN-ROOM-R21-7"
                },
                claimHeaders()
            );

            assertEqual(
                response.status,
                403,
                "wrong owner complete must be forbidden"
            );
            assertEqual(
                response.body?.reason,
                "OWNER_MISMATCH",
                "wrong owner complete reason"
            );

            console.log("  Test 7 (complete wrong identity rejected) passed");

        } finally {

            await runtime.close();

        }
    }

    // Test 8 — repeated complete remains idempotent per store semantics.
    {
        const runtime = await startHandoffServer();

        try {

            const { handoffId } = runtime.handoffStore.create({
                roomId: "ROOM-R21-B8",
                ownerPlayerId: "player-r21-8",
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            runtime.handoffStore.claim({
                handoffId,
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            const first = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.COMPLETE,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID,
                    mainnetRoomId: "MN-ROOM-R21-8-FIRST"
                },
                claimHeaders()
            );

            assertEqual(first.status, 200, "first complete must succeed");

            const repeatSame = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.COMPLETE,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID,
                    mainnetRoomId: "MN-ROOM-R21-8-FIRST"
                },
                claimHeaders()
            );

            assertEqual(repeatSame.status, 200, "repeat complete must stay 200");
            assertEqual(
                repeatSame.body?.mainnetRoomId,
                "MN-ROOM-R21-8-FIRST",
                "repeat complete keeps the authoritative room id"
            );

            const repeatDifferent = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.COMPLETE,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID,
                    mainnetRoomId: "MN-ROOM-R21-8-OTHER"
                },
                claimHeaders()
            );

            assertEqual(
                repeatDifferent.status,
                200,
                "different-room repeat must stay idempotent (no rewrite)"
            );
            assertEqual(
                repeatDifferent.body?.mainnetRoomId,
                "MN-ROOM-R21-8-FIRST",
                "authoritative room id is never overwritten"
            );

            console.log("  Test 8 (repeated complete idempotent) passed");

        } finally {

            await runtime.close();

        }
    }

    // Test 9 — missing server configuration fails closed.
    {
        const runtime = await startHandoffServer({ secret: null });

        try {

            const claim = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                {
                    handoffId: "any",
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
                },
                claimHeaders()
            );

            assertEqual(claim.status, 503, "unconfigured claim must be rejected");
            assertEqual(
                claim.body?.reason,
                "HANDOFF_NOT_CONFIGURED",
                "unconfigured claim reason"
            );

            const complete = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.COMPLETE,
                {
                    handoffId: "any",
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID,
                    mainnetRoomId: "MN-ROOM-R21-9"
                },
                claimHeaders()
            );

            assertEqual(
                complete.status,
                503,
                "unconfigured complete must be rejected"
            );
            assertEqual(
                complete.body?.reason,
                "HANDOFF_NOT_CONFIGURED",
                "unconfigured complete reason"
            );

            console.log("  Test 9a (routes fail closed without secret) passed");

        } finally {

            await runtime.close();

        }
    }

    {
        assertEqual(
            resolveRoomNetworkHandoffSecret({}),
            null,
            "empty env must resolve to null secret"
        );
        assertEqual(
            resolveRoomNetworkHandoffSecret({ ROOM_NETWORK_HANDOFF_SECRET: "   " }),
            null,
            "whitespace-only secret must resolve to null"
        );
        assertEqual(
            resolveRoomNetworkHandoffSecret(
                { ROOM_NETWORK_HANDOFF_SECRET: "  s3cret  " }
            ),
            "s3cret",
            "secret must be trimmed"
        );

        const unconfiguredClient = new RoomNetworkHandoffClient({
            baseUrl: null,
            secret: null,
            fetchImpl: () => {

                throw new Error(
                    "fetch must never be called when unconfigured"
                );

            }
        });

        assertEqual(
            unconfiguredClient.isConfigured(),
            false,
            "client without config must report unconfigured"
        );

        const claim = await unconfiguredClient.claim({
            handoffId: "any",
            ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
        });

        assertEqual(claim.ok, false, "unconfigured claim must fail closed");
        assertEqual(
            claim.reason,
            "HANDOFF_CLIENT_NOT_CONFIGURED",
            "unconfigured claim reason"
        );

        const complete = await unconfiguredClient.complete({
            handoffId: "any",
            ownerTelegramUserId: OWNER_TELEGRAM_USER_ID,
            mainnetRoomId: "MN-ROOM-R21-9"
        });

        assertEqual(complete.ok, false, "unconfigured complete must fail closed");

        assertEqual(
            resolveRoomNetworkHandoffClientConfig({
                ROOM_NETWORK_HANDOFF_TESTNET_URL: "https://testnet.example///",
                ROOM_NETWORK_HANDOFF_SECRET: "s"
            }).baseUrl,
            "https://testnet.example",
            "trailing slashes must be stripped from base URL"
        );

        console.log("  Test 9b (client + env resolution fail closed) passed");

    }

}

async function testGroupC() {

    // Test 10 — secret never present in response bodies or normal logs.
    {
        const runtime = await startHandoffServer();

        try {

            const { handoffId } = runtime.handoffStore.create({
                roomId: "ROOM-R21-C10",
                ownerPlayerId: "player-r21-10",
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
                },
                claimHeaders()
            );

            await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.COMPLETE,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID,
                    mainnetRoomId: "MN-ROOM-R21-10"
                },
                claimHeaders()
            );

            // Unauthenticated attempts must also leak nothing.
            await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                { handoffId, ownerTelegramUserId: OWNER_TELEGRAM_USER_ID },
                claimHeaders("wrong-secret-probe")
            );

            const leakedInResponses = capturedResponseBodyTexts
                .filter((text) => text.includes(SECRET));

            assertEqual(
                leakedInResponses.length,
                0,
                "secret must never appear in any response body"
            );

            const leakedInLogs = runtime.logger.messages
                .filter((message) => message.includes(SECRET));

            assertEqual(
                leakedInLogs.length,
                0,
                "secret must never appear in log output"
            );

            assert(
                runtime.logger.messages.some((message) =>
                    message.includes("ROOM_NETWORK_HANDOFF")),
                "handoff security events must be observable (without secrets)"
            );

            console.log("  Test 10 (secret never in responses/logs) passed");

        } finally {

            await runtime.close();

        }
    }

    // Test 11 — caller-supplied ownership fields are rejected.
    {
        const runtime = await startHandoffServer();

        try {

            const { handoffId } = runtime.handoffStore.create({
                roomId: "ROOM-R21-C11",
                ownerPlayerId: "player-r21-11",
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            const forgedOwner = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID,
                    ownerPlayerId: "player-r21-11"
                },
                claimHeaders()
            );

            assertEqual(
                forgedOwner.status,
                400,
                "caller-supplied ownerPlayerId must be rejected"
            );
            assertEqual(
                forgedOwner.body?.reason,
                "FORBIDDEN_FIELD",
                "forged ownerPlayerId reason"
            );

            const forgedRoom = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID,
                    roomId: "ROOM-R21-C11"
                },
                claimHeaders()
            );

            assertEqual(
                forgedRoom.status,
                400,
                "caller-supplied roomId must be rejected"
            );

            const forgedNetwork = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID,
                    network: "mainnet"
                },
                claimHeaders()
            );

            assertEqual(
                forgedNetwork.status,
                400,
                "caller-supplied network must be rejected"
            );

            const forgedCompleteRoom = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.COMPLETE,
                {
                    handoffId,
                    ownerTelegramUserId: OWNER_TELEGRAM_USER_ID,
                    mainnetRoomId: "MN-ROOM-R21-11",
                    roomId: "ROOM-R21-C11"
                },
                claimHeaders()
            );

            assertEqual(
                forgedCompleteRoom.status,
                400,
                "complete with caller-supplied Testnet roomId must be rejected"
            );

            const missingIdentity = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                { handoffId },
                claimHeaders()
            );

            assertEqual(
                missingIdentity.status,
                400,
                "claim without ownerTelegramUserId must be rejected"
            );

            const nonObjectBody = await postJson(
                runtime.baseUrl,
                NETWORK_HANDOFF_ENDPOINTS.CLAIM,
                [],
                claimHeaders()
            );

            assertEqual(
                nonObjectBody.status,
                400,
                "non-object body must be rejected"
            );
            assertEqual(
                nonObjectBody.body?.reason,
                "INVALID_REQUEST",
                "non-object body reason"
            );

            // None of the rejected requests may burn the one-time handoff.
            const stillClaimable = runtime.handoffStore.claim({
                handoffId,
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            assertEqual(
                stillClaimable.state,
                "claimed",
                "rejected requests must not corrupt handoff state"
            );

            console.log("  Test 11 (forged ownership fields rejected) passed");

        } finally {

            await runtime.close();

        }
    }

    // Test 12 — Mainnet client <-> Testnet routes end-to-end integration.
    {
        const runtime = await startHandoffServer();

        try {

            const { handoffId } = runtime.handoffStore.create({
                roomId: "ROOM-R21-D12",
                ownerPlayerId: "player-r21-12",
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            const client = new RoomNetworkHandoffClient({
                baseUrl: `${runtime.baseUrl}/`,
                secret: SECRET
            });

            assert(client.isConfigured(), "client with config must be configured");

            const claimed = await client.claim({
                handoffId,
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            assertEqual(claimed.ok, true, "client claim must succeed");
            assertEqual(claimed.state, "claimed", "client claim state");
            assertEqual(
                claimed.mainnetRoomId,
                null,
                "client claim has no mainnet room yet"
            );

            const wrongOwner = await client.claim({
                handoffId,
                ownerTelegramUserId: WRONG_TELEGRAM_USER_ID
            });

            assertEqual(wrongOwner.ok, false, "client wrong-owner claim must fail");
            assertEqual(
                wrongOwner.reason,
                "OWNER_MISMATCH",
                "client wrong-owner reason"
            );

            const completed = await client.complete({
                handoffId,
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID,
                mainnetRoomId: "MN-ROOM-R21-12"
            });

            assertEqual(completed.ok, true, "client complete must succeed");
            assertEqual(completed.state, "completed", "client complete state");
            assertEqual(
                completed.mainnetRoomId,
                "MN-ROOM-R21-12",
                "client complete room id"
            );

            const unauthorized = new RoomNetworkHandoffClient({
                baseUrl: runtime.baseUrl,
                secret: "not-the-secret"
            });

            const rejected = await unauthorized.claim({
                handoffId,
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            assertEqual(rejected.ok, false, "wrong-secret client must fail");
            assertEqual(
                rejected.reason,
                "UNAUTHORIZED",
                "wrong-secret client reason"
            );

            const unreachable = new RoomNetworkHandoffClient({
                baseUrl: "http://127.0.0.1:1",
                secret: SECRET,
                timeoutMs: 1500
            });

            const networkFailure = await unreachable.claim({
                handoffId,
                ownerTelegramUserId: OWNER_TELEGRAM_USER_ID
            });

            assertEqual(
                networkFailure.ok,
                false,
                "unreachable Testnet must fail closed"
            );
            assertEqual(
                networkFailure.reason,
                "NETWORK_ERROR",
                "unreachable Testnet reason"
            );

            const leakedInLogs = runtime.logger.messages
                .filter((message) => message.includes(SECRET));

            assertEqual(
                leakedInLogs.length,
                0,
                "client integration must not leak the secret into logs"
            );

            console.log("  Test 12 (client <-> routes integration) passed");

        } finally {

            await runtime.close();

        }
    }

}

async function main() {

    try {

        await testGroupA();
        await testGroupB();
        await testGroupC();

        console.log("roomNetworkHandoff.r21.test.js: all assertions passed");

    } catch (error) {

        console.error(error);

        process.exit(1);

    }

}

main();







