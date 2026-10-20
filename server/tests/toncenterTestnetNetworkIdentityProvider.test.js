import test from "node:test";
import assert from "node:assert/strict";
import { ToncenterTestnetNetworkIdentityProvider } from "../payment/fees/ToncenterTestnetNetworkIdentityProvider.js";
import { ToncenterRequestError, ToncenterResponseError } from "../payment/toncenter/ToncenterErrors.js";

test("returns Testnet identity only when masterchain reports global_id -3", async () => {
    const provider = new ToncenterTestnetNetworkIdentityProvider({
        transactionsClient: { async getMasterchainInfo() { return { global_id: -3, last: { seqno: 42 } }; } }
    });
    assert.deepEqual(await provider.getNetworkIdentity(), { networkName: "TESTNET", globalId: -3 });
});

test("rejects Mainnet identity", async () => {
    const provider = new ToncenterTestnetNetworkIdentityProvider({
        transactionsClient: { async getMasterchainInfo() { return { global_id: -239 }; } }
    });
    await assert.rejects(() => provider.getNetworkIdentity(), ToncenterRequestError);
});

test("rejects missing or malformed identity", async () => {
    const provider = new ToncenterTestnetNetworkIdentityProvider({
        transactionsClient: { async getMasterchainInfo() { return { last: { seqno: 42 } }; } }
    });
    await assert.rejects(() => provider.getNetworkIdentity(), ToncenterResponseError);
});
