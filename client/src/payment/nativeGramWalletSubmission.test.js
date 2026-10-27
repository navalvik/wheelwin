import assert from "node:assert/strict";
import { test } from "node:test";
import { submitNativeGramToConnectedWallet } from "./nativeGramWalletSubmission.js";
const sender = "0:" + "1".repeat(64);
const DEADLINE = (Math.floor(Date.now() / 1000) + 240) * 1000;
const payment = {
    enabled: true, network: "testnet", asset: "TON",
    destination: "0:" + "2".repeat(64), expectedSender: sender,
    amountAtomic: "1000000000", reference: "room-3-player-1", expiresAt: DEADLINE
};
test("only connected owner on Testnet may submit one native transfer", async () => {
    const submitted = [];
    let refreshes = 0;
    const walletAdapter = {
        account: { address: sender, chain: "-3" },
        sendTransaction: async tx => { submitted.push(tx); }
    };
    const result = await submitNativeGramToConnectedWallet({
        payment, walletAdapter, onSubmitted: () => { refreshes++; }
    });
    assert.deepEqual(result, { walletSubmitted: true, serverVerified: false, credited: false });
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].messages.length, 1);
    assert.equal(submitted[0].validUntil, Math.floor(DEADLINE / 1000));
    assert.equal(submitted[0].messages[0].amount, "1000000000");
    assert.equal(refreshes, 1);
});
test("submission rejects Mainnet, wrong payer, disabled intake and expired request", async () => {
    let sends = 0;
    const adapter = { account: { address: sender, chain: "-3" },
        sendTransaction: async () => { sends++; } };
    const cases = [
        { walletAdapter: { ...adapter, account: { address: sender, chain: "-239" } } },
        { walletAdapter: { ...adapter, account: { address: payment.destination, chain: "-3" } } },
        { payment: { ...payment, enabled: false } },
        { payment: { ...payment, expiresAt: 1000 } },
        { walletAdapter: null }
    ];
    for (const change of cases) {
        await assert.rejects(submitNativeGramToConnectedWallet({
            payment, walletAdapter: adapter, ...change
        }));
    }
    assert.equal(sends, 0);
});
test("wallet rejection never reports submission or settlement", async () => {
    let refreshes = 0;
    await assert.rejects(submitNativeGramToConnectedWallet({
        payment,
        walletAdapter: { account: { address: sender, chain: "-3" },
            sendTransaction: async () => { throw new Error("user rejected"); } },
        onSubmitted: () => { refreshes++; }
    }), /user rejected/);
    assert.equal(refreshes, 0);
});
