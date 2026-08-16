/**
 * P6.6 — HTTP transport for TonCenter / compatible JSON-RPC.
 * All TON network I/O for deploy + monitor goes through this boundary.
 * R7.52 — sendBoc diagnostics capture real HTTP rejection body (no secrets).
 */

import { createHash } from "node:crypto";

import { pushTonDeployDebugStage } from "../../diagnostics/DeployPipelineForensics.js";

function headersToObject(headers) {

    const out = {};

    if (!headers) {

        return out;

    }

    if (typeof headers.forEach === "function") {

        headers.forEach((value, key) => {

            out[String(key)] = String(value);

        });

        return out;

    }

    return { ...headers };

}

function truncateBody(body, max = 4000) {

    if (body == null) {

        return null;

    }

    const text = typeof body === "string" ? body : JSON.stringify(body);

    if (text.length <= max) {

        return text;

    }

    return `${text.slice(0, max)}…[truncated]`;

}

export class TonCenterTransport {

    constructor({
        endpoint,
        apiKey = null,
        fetchImpl = globalThis.fetch.bind(globalThis)
    }) {

        this._endpoint = endpoint;

        this._apiKey = apiKey;

        this._fetch = fetchImpl;

    }

    async call(method, params = {}) {

        const headers = {
            "Content-Type": "application/json"
        };

        if (this._apiKey) {

            headers["X-API-Key"] = this._apiKey;

        }

        const response = await this._fetch(this._endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({
                id: 1,
                jsonrpc: "2.0",
                method,
                params
            })
        });

        if (!response.ok) {

            let responseBody = null;

            try {

                responseBody = await response.text();

            } catch {

                responseBody = null;

            }

            const error = new Error(`TonCenter HTTP ${response.status}`);

            error.status = response.status;
            error.statusText = response.statusText ?? null;
            error.responseBody = truncateBody(responseBody);
            error.responseHeaders = headersToObject(response.headers);
            error.endpoint = this._endpoint;
            error.method = method;

            throw error;

        }

        const body = await response.json();

        if (body.error) {

            const error = new Error(
                body.error.message || `TonCenter error in ${method}`
            );

            error.status = response.status;
            error.statusText = response.statusText ?? null;
            error.responseBody = truncateBody(body.error);
            error.responseHeaders = headersToObject(response.headers);
            error.endpoint = this._endpoint;
            error.method = method;

            throw error;

        }

        return body.result;

    }

    async getAddressInformation(address) {

        return this.call("getAddressInformation", { address });

    }

    async sendBoc(bocBase64) {

        const boc = typeof bocBase64 === "string" ? bocBase64 : "";
        const bocSize = boc.length;
        const bocHash = createHash("sha256").update(boc).digest("hex");

        console.log(
            "[R7.52 TON_SEND_BOC_REQUEST]",
            {
                timestamp: Date.now(),
                endpoint: this._endpoint,
                method: "sendBoc",
                bocSize,
                bocHash,
                stage: "BOC_SEND_START"
            }
        );

        pushTonDeployDebugStage(null, {
            tonCenterEndpoint: this._endpoint
        });

        try {

            const result = await this.call("sendBoc", { boc });

            console.log(
                "[R7.52 TON_SEND_BOC_SUCCESS]",
                {
                    status: 200,
                    responseBody: truncateBody(result),
                    stage: "BOC_SEND_SUCCESS"
                }
            );

            return result;

        } catch (error) {

            const status = error?.status ?? null;
            const responseBody = error?.responseBody ?? null;

            console.error(
                "[R7.52 TONCENTER ERROR]",
                {
                    status,
                    statusText: error?.statusText ?? null,
                    body: responseBody,
                    responseHeaders: error?.responseHeaders ?? null,
                    message: error?.message ?? String(error),
                    endpoint: error?.endpoint ?? this._endpoint
                }
            );

            pushTonDeployDebugStage(null, {
                tonCenterStatus: status,
                tonCenterResponse: responseBody,
                tonCenterEndpoint: error?.endpoint ?? this._endpoint,
                errorName: error?.name ?? "Error",
                errorMessage: error?.message ?? String(error)
            });

            throw error;

        }

    }

    async getTransactions(address, {
        limit = 20,
        archival = true,
        lt = null,
        hash = null
    } = {}) {

        const params = {
            address,
            limit,
            archival
        };

        if (lt != null && String(lt).trim()) {

            params.lt = String(lt).trim();

        }

        if (hash != null && String(hash).trim()) {

            params.hash = String(hash).trim();

        }

        return this.call("getTransactions", params);

    }

}
