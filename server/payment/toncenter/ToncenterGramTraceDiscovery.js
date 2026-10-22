/**
 * Read-only indexed trace discovery for a GRAM transfer.
 *
 * Toncenter v3 /traces is an INDEX, not a verified message-chain proof.
 * Even a matching trace never authorizes a payment or makes a finalized claim.
 */
import { TONCENTER_TESTNET_BASE_URL } from "./ToncenterConstants.js";
import { defaultApiKeyProvider } from "./ToncenterTransactionsClient.js";

export class ToncenterGramTraceDiscovery {
    #fetch;
    #key;
    #timeoutMs;

    constructor({ fetchImpl = globalThis.fetch,
        apiKeyProvider = defaultApiKeyProvider, timeoutMs = 15000 } = {}) {
        if (typeof fetchImpl !== "function" || typeof apiKeyProvider !== "function"
            || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
            throw new Error("Invalid Testnet GRAM trace discovery configuration");
        }
        this.#fetch = fetchImpl;
        this.#key = apiKeyProvider;
        this.#timeoutMs = timeoutMs;
    }

    /** Single bounded Testnet request. Never treats empty results as no-payment. */
    async readTrace(traceId) {
        if (typeof traceId !== "string" || !/^[a-f0-9]{64}$/.test(traceId)) {
            throw new Error("Invalid authoritative GRAM trace identifier");
        }
        const key = this.#key();
        if (typeof key !== "string" || !key.trim()) {
            throw new Error("TON_API_KEY is required for trace discovery");
        }
        const url = new URL(TONCENTER_TESTNET_BASE_URL + "/api/v3/traces");
        url.searchParams.set("trace_id", traceId);
        url.searchParams.set("include_actions", "false");
        url.searchParams.set("limit", "2");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
        let result;
        try {
            result = await this.#fetch(url.toString(), {
                method: "GET",
                headers: { "X-API-Key": key.trim() },
                signal: controller.signal
            });
        } catch {
            throw new Error("Toncenter Testnet GRAM trace discovery failed");
        } finally {
            clearTimeout(timer);
        }
        if (result?.status !== 200) {
            throw new Error(`Toncenter GRAM trace discovery rejected HTTP ${result?.status}`);
        }
        let body;
        try {
            body = await result.json();
        } catch {
            throw new Error("Toncenter returned invalid trace JSON");
        }
        if (!body || !Array.isArray(body.traces) || body.traces.length > 2) {
            throw new Error("Toncenter returned invalid or oversized traces envelope");
        }
        const matches = body.traces.filter(trace =>
            trace && typeof trace === "object"
            && !Array.isArray(trace) && trace.trace_id === traceId);
        if (matches.length !== body.traces.length || matches.length > 1) {
            throw new Error("Toncenter returned mismatched or ambiguous GRAM trace records");
        }
        return Object.freeze({
            traceId,
            traces: Object.freeze([...matches]),
            complete: body.traces.length < 2,
            indexerOnly: true,
            chainMessageLinkVerified: false,
            gramTransferVerified: false,
            paymentCreditAuthorized: false
        });
    }
}
