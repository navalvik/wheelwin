import { createHash, timingSafeEqual } from "node:crypto";

import {
    NETWORK_HANDOFF_ENDPOINTS,
    NETWORK_HANDOFF_REASONS,
    ROOM_NETWORK_HANDOFF_SECRET_HEADER,
    ROOM_NETWORK_HANDOFF_SECRET_ENV
} from "./roomNetworkHandoffProtocol.js";

/**
 * R21 — Cross-runtime room network handoff (Testnet → Mainnet).
 *
 * Narrowly scoped internal HTTP contract exposed by the TESTNET runtime and
 * consumed server-to-server by the MAINNET runtime:
 *
 *   POST /internal/network-handoff/claim
 *   POST /internal/network-handoff/complete
 *
 * Security model:
 * - Dedicated shared secret via ROOM_NETWORK_HANDOFF_SECRET; never console
 *   credentials, never the Telegram bot token, never a wallet secret.
 * - Requests must carry the secret in the dedicated header.
 * - Fail closed: with no secret configured every request is rejected (503);
 *   the endpoints never accept unauthenticated traffic.
 * - Constant-time secret comparison (hashed timingSafeEqual).
 * - The secret is never logged and never included in any response body.
 * - Identity: the caller may only supply the opaque handoffId and the
 *   Mainnet-authenticated Telegram user id. roomId / ownerPlayerId /
 *   network / mainnetRoomId supplied by the caller are rejected; the
 *   authoritative values come exclusively from the handoff record.
 */

const CLAIM_STATUS_BY_REASON = Object.freeze({
    NOT_FOUND_OR_EXPIRED: 404,
    OWNER_MISMATCH: 403
});

const COMPLETE_STATUS_BY_REASON = Object.freeze({
    NOT_FOUND_OR_EXPIRED: 404,
    OWNER_MISMATCH: 403,
    CLAIM_REQUIRED: 409,
    INVALID_MAINNET_ROOM_ID: 422
});

/**
 * Fields the internal caller must NEVER be able to provide. Ownership
 * identity lives only in the handoff record created by the Testnet runtime.
 * (`mainnetRoomId` is additionally forbidden on CLAIM — it is produced by the
 * Mainnet runtime AFTER the claim, never supplied at claim time.)
 */
const FORBIDDEN_IDENTITY_FIELDS = Object.freeze([
    "ownerPlayerId",
    "roomId",
    "network",
    "targetNetwork"
]);

const CLAIM_FORBIDDEN_FIELDS = Object.freeze([
    ...FORBIDDEN_IDENTITY_FIELDS,
    "mainnetRoomId"
]);

export function resolveRoomNetworkHandoffSecret(env = process.env) {

    const raw = String(env?.[ROOM_NETWORK_HANDOFF_SECRET_ENV] ?? "").trim();

    return raw.length > 0 ? raw : null;

}

function secretsMatch(receivedSecret, expectedSecret) {

    // Hash both sides first: equal digest lengths guarantee timingSafeEqual
    // never throws on differing input sizes and never early-exits on length.
    const received = createHash("sha256")
        .update(String(receivedSecret ?? ""), "utf8")
        .digest();

    const expected = createHash("sha256")
        .update(String(expectedSecret ?? ""), "utf8")
        .digest();

    return timingSafeEqual(received, expected);

}

function isNonEmptyTrimmedString(value) {

    return typeof value === "string" && value.trim().length > 0;

}

function validateHandoffRequestShape(body, requiredFields, forbiddenFields) {

    if (!body || typeof body !== "object" || Array.isArray(body)) {

        return NETWORK_HANDOFF_REASONS.INVALID_REQUEST;

    }

    for (const field of forbiddenFields) {

        if (body[field] !== undefined) {

            return NETWORK_HANDOFF_REASONS.FORBIDDEN_FIELD;

        }

    }

    for (const field of requiredFields) {

        if (!isNonEmptyTrimmedString(body[field])) {

            return NETWORK_HANDOFF_REASONS.INVALID_REQUEST;

        }

    }

    return null;

}

export function registerRoomNetworkHandoffRoutes(
    app,
    { handoffStore, logger = null, secret = resolveRoomNetworkHandoffSecret() } = {}
) {

    if (!app || !handoffStore) {

        return;

    }

    const logWarn = (message) => logger?.warn?.(message);
    const logInfo = (message) => logger?.info?.(message);

    if (!secret) {

        logWarn(
            "ROOM_NETWORK_HANDOFF | secret not configured;"
            + " internal handoff endpoints reject all requests (fail closed)"
        );

    } else {

        logInfo("ROOM_NETWORK_HANDOFF | internal endpoints registered (secret required)");

    }

    const authenticate = (req, res) => {

        if (!secret) {

            // Fail closed: endpoint enabled but secret unconfigured.
            res.status(503).json({
                ok: false,
                reason: NETWORK_HANDOFF_REASONS.HANDOFF_NOT_CONFIGURED
            });

            return false;

        }

        const receivedSecret =
            String(req.get?.(ROOM_NETWORK_HANDOFF_SECRET_HEADER) ?? "");

        if (!secretsMatch(receivedSecret, secret)) {

            logWarn("ROOM_NETWORK_HANDOFF | rejected unauthenticated internal request");

            res.status(401).json({
                ok: false,
                reason: NETWORK_HANDOFF_REASONS.UNAUTHORIZED
            });

            return false;

        }

        return true;

    };

    app.post(NETWORK_HANDOFF_ENDPOINTS.CLAIM, (req, res) => {

        if (!authenticate(req, res)) {

            return;

        }

        const shapeError = validateHandoffRequestShape(
            req.body,
            ["handoffId", "ownerTelegramUserId"],
            CLAIM_FORBIDDEN_FIELDS
        );

        if (shapeError) {

            res.status(400).json({ ok: false, reason: shapeError });

            return;

        }

        const result = handoffStore.claim({
            handoffId: req.body.handoffId,
            ownerTelegramUserId: req.body.ownerTelegramUserId
        });

        if (!result?.ok) {

            const status = CLAIM_STATUS_BY_REASON[result?.reason] ?? 422;

            res.status(status).json({
                ok: false,
                reason: result?.reason ?? "UNKNOWN"
            });

            return;

        }

        res.status(200).json({
            ok: true,
            state: result.state,
            mainnetRoomId: result.mainnetRoomId ?? null
        });

    });

    app.post(NETWORK_HANDOFF_ENDPOINTS.COMPLETE, (req, res) => {

        if (!authenticate(req, res)) {

            return;

        }

        const shapeError = validateHandoffRequestShape(
            req.body,
            ["handoffId", "ownerTelegramUserId", "mainnetRoomId"],
            FORBIDDEN_IDENTITY_FIELDS
        );

        if (shapeError) {

            res.status(400).json({ ok: false, reason: shapeError });

            return;

        }

        const result = handoffStore.complete({
            handoffId: req.body.handoffId,
            ownerTelegramUserId: req.body.ownerTelegramUserId,
            mainnetRoomId: req.body.mainnetRoomId
        });

        if (!result?.ok) {

            const status = COMPLETE_STATUS_BY_REASON[result?.reason] ?? 422;

            res.status(status).json({
                ok: false,
                reason: result?.reason ?? "UNKNOWN"
            });

            return;

        }

        // Idempotent per store semantics: an already completed handoff keeps
        // returning the authoritative mainnetRoomId of the first completion.
        res.status(200).json({
            ok: true,
            state: result.state,
            mainnetRoomId: result.mainnetRoomId ?? null
        });

    });

}

