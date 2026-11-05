import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";
import { createMainnetWalletV4Transport } from "../payment/MainnetWalletV4Transport.js";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { createMainnetBootstrap } from "../MainnetBootstrap.js";

function setup(t) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-shared-mainnet-wallet-v4-"));
    const testnetDataDir = mkdtempSync(join(tmpdir(), "wheelwin-testnet-wallet-v4-"));
    t.after(() => {
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(testnetDataDir, { recursive: true, force: true });
    });
    const keyPairs = Array.from({ length: 64 }, (_, index) =>
        keyPairFromSeed(Buffer.alloc(32, index + 1)));
    const addresses = keyPairs.map(keys => WalletContractV4.create({
        workchain: 0, publicKey: keys.publicKey
    }).address.toString({ bounceable: true, urlSafe: true }));
    const publicCatalog = JSON.stringify(addresses.map((address, index) => ({
        walletId: `synthetic-mainnet-${index + 1}`, roomNumber: index + 1,
        address, network: "mainnet"
    })));
    const signingCatalog = JSON.stringify(addresses.map((address, index) => ({
        roomNumber: index + 1, address, network: "mainnet", workchain: 0,
        publicKey: keyPairs[index].publicKey.toString("hex"),
        secretKey: keyPairs[index].secretKey.toString("hex")
    })));
    const env = {
        TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "mock-mainnet-toncenter-key",
        MAINNET_ROOM_WALLET_DATA_DIR: dataDir,
        MAINNET_ROOM_WALLETS_JSON: publicCatalog,
        ROOM_WALLETS_MAINNET_JSON: signingCatalog,
        ROOM_WALLET_DATA_DIR: testnetDataDir
    };
    const config = loadMainnetRuntimeConfig(env);
    const state = { seqno: 7, sentBocs: [], estimates: 0 };
    const client = {
        async getContractState() { return { state: "active" }; },
        async runMethod(_address, method) {
            assert.equal(method, "seqno");
            return { stack: { readNumber: () => state.seqno } };
        },
        async getBalance() { return 12_000_000_000n; },
        async estimateExternalMessageFee() {
            state.estimates += 1;
            return { source_fees: { in_fwd_fee: 1, storage_fee: 2, gas_fee: 3, fwd_fee: 4 } };
        },
        async sendFile(boc) {
            state.sentBocs.push(Buffer.from(boc));
            state.seqno += 1;
        }
    };
    return { env, config, dataDir, testnetDataDir, addresses, keyPairs, state, client };
}

test("Mainnet uses shared RoomWalletAdapter with Mainnet Toncenter, keys, and isolated durable seqno state", async t => {
    const h = setup(t);
    const transport = createMainnetWalletV4Transport({ config: h.config, env: h.env,
        client: h.client, now: () => 1_800_000_000_000, sleep: async () => {} });
    assert.equal(transport.supportsDurableTransferRetry(), true);
    assert.equal(await transport.getWalletAddress(1), h.addresses[0]);
    assert.equal(await transport.getSeqno(1), 7);

    const fee = await transport.estimateOutboundTransferFee({ roomNumber: 1,
        destination: h.addresses[1], amountNano: 2_000_000_000n, bounce: false });
    assert.equal(fee.ok, true);
    assert.equal(fee.totalNano, 10n);
    assert.equal(h.state.estimates, 1);

    const first = await transport.sendTransfer({ roomNumber: 1, destination: h.addresses[1],
        amountNano: 2_000_000_000n, bounce: false, idempotencyKey: "mock:mainnet:first" });
    const second = await transport.sendTransfer({ roomNumber: 1, destination: h.addresses[2],
        amountNano: 3_000_000_000n, bounce: false, idempotencyKey: "mock:mainnet:second" });
    assert.deepEqual([first.seqno, second.seqno], [7, 8]);
    assert.equal(first.code, "SUBMITTED_UNCONFIRMED");
    assert.equal(second.code, "SUBMITTED_UNCONFIRMED");
    assert.equal(h.state.sentBocs.length, 2);

    const replay = await transport.sendTransfer({ roomNumber: 1, destination: h.addresses[1],
        amountNano: 2_000_000_000n, bounce: false, idempotencyKey: "mock:mainnet:first" });
    assert.deepEqual(replay, { ok: true, code: "ACCEPTED_AWAITING_CREDIT", seqno: 7, txHash: null });
    assert.equal(h.state.sentBocs.length, 2, "idempotent replay must not broadcast a second independent transfer");
    assert.equal(readdirSync(join(h.dataDir, "outgoing-seqno", "transfers")).length, 2);
    assert.equal(readdirSync(h.testnetDataDir).length, 0, "Mainnet sequence state must not touch Testnet storage");

    const restartedTransport = createMainnetWalletV4Transport({ config: h.config,
        env: h.env, client: h.client, now: () => 1_800_000_000_000, sleep: async () => {} });
    const afterRestart = await restartedTransport.sendTransfer({ roomNumber: 1,
        destination: h.addresses[3], amountNano: 1_000_000_000n, bounce: false,
        idempotencyKey: "mock:mainnet:after-restart" });
    assert.equal(afterRestart.seqno, 9, "the restarted adapter observes the advanced chain seqno");
    assert.equal(readdirSync(join(h.dataDir, "outgoing-seqno", "transfers")).length, 3,
        "transfer operation history remains in the isolated Mainnet directory");
});

test("Mainnet signing resolver fails closed on Testnet fallback or wallet/address drift", t => {
    const h = setup(t);
    const noMainnetKeys = { ...h.env, ROOM_WALLETS_MAINNET_JSON: "", ROOM_WALLETS_TESTNET_JSON: "[]" };
    assert.throws(() => createMainnetWalletV4Transport({ config: h.config, env: noMainnetKeys,
        client: h.client }), /ROOM_WALLETS_MAINNET_JSON is required/);

    const unrelatedKeys = keyPairFromSeed(Buffer.alloc(32, 200));
    const unrelatedAddress = WalletContractV4.create({ workchain: 0,
        publicKey: unrelatedKeys.publicKey }).address.toString({ bounceable: true, urlSafe: true });
    const mismatchedCatalog = JSON.stringify(h.addresses.map((address, index) => ({
        walletId: `synthetic-mainnet-${index + 1}`, roomNumber: index + 1,
        address: index === 0 ? unrelatedAddress : address, network: "mainnet"
    })));
    const mismatchedConfig = loadMainnetRuntimeConfig({ ...h.env, MAINNET_ROOM_WALLETS_JSON: mismatchedCatalog });
    assert.throws(() => createMainnetWalletV4Transport({ config: mismatchedConfig,
        env: h.env, client: h.client }), /MAINNET_WALLET_V4_IDENTITY_MISMATCH/,
    "public Mainnet catalog and signing keys are checked before runtime activation");
    const failedBootstrap = createMainnetBootstrap({
        env: { ...h.env, ROOM_WALLET_PAYMENTS_ENABLED: "true",
            MAINNET_ROOM_WALLETS_JSON: mismatchedCatalog },
        walletV4Client: h.client,
        fetchImpl: async () => { throw new Error("no RPC expected"); }
    });
    assert.throws(() => failedBootstrap.initialize(), /MAINNET_WALLET_V4_IDENTITY_MISMATCH/);
    assert.equal(failedBootstrap.paymentRuntime, null,
        "a failed Wallet V4 identity check leaves no active payment runtime");
});

test("Mainnet bootstrap requires enabled intake before it constructs the signer transport", t => {
    const h = setup(t);
    const bootstrap = createMainnetBootstrap({
        env: { ...h.env, ROOM_WALLET_PAYMENTS_ENABLED: "true",
            ROOM_WALLET_PAYMENT_INTAKE_MODE: "DISABLED" },
        walletV4Client: h.client,
        fetchImpl: async () => { throw new Error("no RPC expected during initialization"); }
    });
    bootstrap.initialize();
    assert.equal(bootstrap.liveOperationsEnabled, false);
    assert.equal(bootstrap.paymentRuntime.network, "mainnet");
    assert.equal(bootstrap.walletV4Transport, null);
    assert.equal(bootstrap.paymentRuntime.getCapabilities().livePaymentAcceptanceEnabled, false);
});

test("Mainnet ambiguous broadcast retry reuses the same durable Wallet V4 message", async t => {
    const h = setup(t);
    let failFirstBroadcast = true;
    const client = { ...h.client, async sendFile(boc) {
        h.state.sentBocs.push(Buffer.from(boc));
        if (failFirstBroadcast) {
            failFirstBroadcast = false;
            throw new Error("MOCK_BROADCAST_REPLY_TIMEOUT");
        }
        h.state.seqno += 1;
    } };
    const transport = createMainnetWalletV4Transport({ config: h.config, env: h.env,
        client, now: () => 1_800_000_000_000, sleep: async () => {} });
    const request = { roomNumber: 1, destination: h.addresses[1], amountNano: 2_000_000_000n,
        bounce: false, idempotencyKey: "mock:mainnet:ambiguous" };
    await assert.rejects(transport.sendTransfer(request), /MOCK_BROADCAST_REPLY_TIMEOUT/);
    const retry = await transport.sendTransfer(request);
    assert.equal(retry.code, "SUBMITTED_UNCONFIRMED");
    assert.equal(h.state.sentBocs.length, 2);
    assert.deepEqual(h.state.sentBocs[0], h.state.sentBocs[1]);
});
