import {
    NETWORK_HANDOFF_ENDPOINTS,
    ROOM_NETWORK_HANDOFF_SECRET_ENV,
    ROOM_NETWORK_HANDOFF_SECRET_HEADER,
    ROOM_NETWORK_HANDOFF_TESTNET_URL_ENV
} from "./roomNetworkHandoffProtocol.js";

/**
 * R21 — Mainnet-side HTTP client for the Testnet room-network handoff
 * contract (server-to-server; this service runs on the MAINNET runtime).
 *
 * Behavior:
 * - Reads the Testnet base URL from ROOM_NETWORK_HANDOFF_TESTNET_URL and the
 *   shared secret from ROOM_NETWORK_HANDOFF_SECRET (never hard-coded, never
 *   localhost assumptions, no URL in source).
 * - Sends the dedicated secret header; never logs the secret; never returns
 *   the secret to its caller.
 * - Fails closed: without complete configuration every call returns
 *   { ok: false, reason: "HANDOFF_CLIENT_NOT_CONFIGURED" } without any
 *   network activity.
 * - Normalized machine-readable results; request timeout is enforced.
 */

const DEFAULT_TIMEOUT_MS = 10 * 1000;

export function resolveRoomNetworkHandoffClientConfig(env = process.env) {

    const rawBaseUrl =
        String(env?.[ROOM_NETWORK_HANDOFF_TESTNET_URL_ENV] ?? "").trim();

    const baseUrl = rawBaseUrl.replace(/\/+$/, "");

    const rawSecret = String(env?.[ROOM_NETWORK_HANDOFF_SECRET_ENV] ?? "").trim();

    return {
        baseUrl: baseUrl.length > 0 ? baseUrl : null,
        secret: rawSecret.length > 0 ? rawSecret : null
    };

}

export class RoomNetworkHandoffClient {

    constructor(
        {
            baseUrl = null,
            secret = null,
            timeoutMs = DEFAULT_TIMEOUT_MS,
            fetchImpl = null
        } = {}
    ) {

        const envConfig = resolveRoomNetworkHandoffClientConfig();

        this._baseUrl =
            String(baseUrl ?? envConfig.baseUrl ?? "")
                .trim()
                .replace(/\/+$/, "") || null;
        this._secret = (secret ?? envConfig.secret) || null;
        this._timeoutMs =
            Number.isFinite(timeoutMs) && timeoutMs > 0
                ? timeoutMs
                : DEFAULT_TIMEOUT_MS;
        this._fetch = fetchImpl ?? globalThis.fetch?.bind(globalThis) ?? null;

    }

    isConfigured() {

        return Boolean(this._baseUrl && this._secret && this._fetch);

    }

    /**
     * Claim the handoff on Testnet with the Mainnet-authenticated Telegram
     * user id. Returns a normalized result; never throws for remote failures.
     */
    async claim({ handoffId, ownerTelegramUserId }) {

        return this._call(NETWORK_HANDOFF_ENDPOINTS.CLAIM, {
            handoffId,
            ownerTelegramUserId
        });

    }

    /**
     * Complete the handoff after the Mainnet room was created.
     * Returns a normalized result; never throws for remote failures.
     */
    async complete({ handoffId, ownerTelegramUserId, mainnetRoomId }) {

        return this._call(NETWORK_HANDOFF_ENDPOINTS.COMPLETE, {
            handoffId,
            ownerTelegramUserId,
            mainnetRoomId
        });

    }

    async _call(path, payload) {

        if (!this.isConfigured()) {

            return { ok: false, reason: "HANDOFF_CLIENT_NOT_CONFIGURED" };

        }

        const controller = new AbortController();

        const timer = setTimeout(
            () => controller.abort(),
            this._timeoutMs
        );

        try {

            const response = await this._fetch(`${this._baseUrl}${path}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    [ROOM_NETWORK_HANDOFF_SECRET_HEADER]: this._secret
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            let body = null;

            try {

                body = await response.json();

            } catch {

                body = null;

            }

            if (!response.ok) {

                return {
                    ok: false,
                    reason: body?.reason ?? `HTTP_${response.status}`,
                    httpStatus: response.status
                };

            }

            if (!body?.ok) {

                return {
                    ok: false,
                    reason: body?.reason ?? "UNEXPECTED_RESPONSE",
                    httpStatus: response.status
                };

            }

            return {
                ok: true,
                state: body.state ?? null,
                mainnetRoomId: body.mainnetRoomId ?? null
            };

        } catch (error) {

            const aborted = error?.name === "AbortError";

            return {
                ok: false,
                reason: aborted ? "TIMEOUT" : "NETWORK_ERROR"
            };

        } finally {

            clearTimeout(timer);

        }

    }

}
