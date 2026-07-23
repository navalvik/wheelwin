/**
 * P6.6 — HTTP transport for TonCenter / compatible JSON-RPC.
 * All TON network I/O for deploy + monitor goes through this boundary.
 */
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

            throw new Error(`TonCenter HTTP ${response.status}`);

        }

        const body = await response.json();

        if (body.error) {

            throw new Error(
                body.error.message || `TonCenter error in ${method}`
            );

        }

        return body.result;

    }

    async getAddressInformation(address) {

        return this.call("getAddressInformation", { address });

    }

    async sendBoc(bocBase64) {

        return this.call("sendBoc", { boc: bocBase64 });

    }

    async getTransactions(address, { limit = 20, archival = true } = {}) {

        return this.call("getTransactions", {
            address,
            limit,
            archival
        });

    }

}
