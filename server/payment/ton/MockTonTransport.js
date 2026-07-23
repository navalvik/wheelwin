/**
 * P6.6 — In-memory TON transport for unit / integration tests.
 */
export class MockTonTransport {

    constructor({
        transactionsByAddress = new Map(),
        addressInfoByAddress = new Map(),
        sendBocHandler = null
    } = {}) {

        this._transactionsByAddress = transactionsByAddress;

        this._addressInfoByAddress = addressInfoByAddress;

        this._sendBocHandler = sendBocHandler;

        this.sentBocs = [];

    }

    seedTransactions(address, transactions) {

        this._transactionsByAddress.set(address, transactions);

    }

    seedAddressInfo(address, info) {

        this._addressInfoByAddress.set(address, info);

    }

    async getAddressInformation(address) {

        return this._addressInfoByAddress.get(address) ?? {
            state: "uninitialized",
            balance: "0"
        };

    }

    async sendBoc(bocBase64) {

        this.sentBocs.push(bocBase64);

        if (this._sendBocHandler) {

            return this._sendBocHandler(bocBase64);

        }

        return { "@type": "ok" };

    }

    async getTransactions(address) {

        return this._transactionsByAddress.get(address) ?? [];

    }

}
