/**
 * Independent TON Center Testnet identity check for fee estimation.
 * It uses the existing read-only masterchain endpoint and refuses to label
 * estimates as Testnet unless the provider reports global_id -3.
 */
import { ToncenterRequestError, ToncenterResponseError } from "../toncenter/ToncenterErrors.js";

export class ToncenterTestnetNetworkIdentityProvider {
    constructor({ transactionsClient } = {}) {
        if (typeof transactionsClient?.getMasterchainInfo !== "function") {
            throw new ToncenterRequestError("Toncenter masterchain-info client is required");
        }
        this._client = transactionsClient;
    }

    async getNetworkIdentity() {
        const result = await this._client.getMasterchainInfo();
        if (!result || !Number.isSafeInteger(result.global_id)) {
            throw new ToncenterResponseError("Toncenter masterchain identity response has no valid global_id");
        }
        if (result.global_id !== -3) {
            throw new ToncenterRequestError("Configured TON Center endpoint is not on Testnet", {
                globalId: result.global_id
            });
        }
        return Object.freeze({ networkName: "TESTNET", globalId: -3 });
    }
}
