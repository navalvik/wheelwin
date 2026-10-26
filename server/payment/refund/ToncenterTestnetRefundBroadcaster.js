/**
 * Testnet-only broadcast transport for an already signed external BOC.
 * Does not own keys, sign, retry, or claim transaction finality.
 */
export class ToncenterTestnetRefundBroadcaster {
    constructor({ fetchImpl = globalThis.fetch, apiKeyProvider = () => "",
        endpoint = "https://testnet.toncenter.com/api/v2/sendBoc" } = {}) {
        if (typeof fetchImpl !== "function" || typeof apiKeyProvider !== "function"
            || endpoint !== "https://testnet.toncenter.com/api/v2/sendBoc") {
            throw new Error("Testnet refund broadcaster configuration invalid");
        }
        this._fetch = fetchImpl;
        this._apiKeyProvider = apiKeyProvider;
        this._endpoint = endpoint;
    }

    async broadcast({ signedTransfer }) {
        const boc = typeof signedTransfer === "string"
            ? signedTransfer : signedTransfer?.boc;
        if (typeof boc !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(boc)
            || boc.length < 8 || boc.length % 4 !== 0) {
            return Object.freeze({ status: "REJECTED", reason: "SIGNED_BOC_INVALID" });
        }
        const key = this._apiKeyProvider();
        if (typeof key !== "string" || key.trim() === "") {
            return Object.freeze({ status: "REJECTED", reason: "TESTNET_API_KEY_UNAVAILABLE" });
        }
        let response;
        try {
            response = await this._fetch(this._endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-API-Key": key.trim() },
                body: JSON.stringify({ boc }),
                signal: AbortSignal.timeout(10000)
            });
        } catch {
            // Timeout or connection drop after transmit is ambiguous.
            return Object.freeze({ status: "UNKNOWN", reason: "BROADCAST_OUTCOME_AMBIGUOUS" });
        }
        if (response.status === 429 || response.status >= 500) {
            return Object.freeze({ status: "UNKNOWN", reason: "PROVIDER_NOT_DEFINITIVE" });
        }
        if (!response.ok) {
            return Object.freeze({ status: "REJECTED", reason: "PROVIDER_REJECTED" });
        }
        let body;
        try { body = await response.json(); } catch {
            return Object.freeze({ status: "UNKNOWN", reason: "PROVIDER_RESPONSE_INVALID" });
        }
        if (body?.ok !== true) {
            return Object.freeze({ status: "UNKNOWN", reason: "PROVIDER_RESPONSE_UNVERIFIED" });
        }
        // /sendBoc has no authoritative outgoing transaction identity.
        // Independent on-chain observation must reconcile the obligation.
        return Object.freeze({ status: "UNKNOWN", reason: "ACCEPTED_AWAITING_ONCHAIN_IDENTITY" });
    }
}
