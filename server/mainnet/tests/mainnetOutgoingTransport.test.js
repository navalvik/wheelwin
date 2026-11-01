import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { keyPairFromSeed } from "@ton/crypto";
import { Address } from "@ton/core";
import { WalletContractV4 } from "@ton/ton";
import { RoomWalletAdapter } from "../../payment/roomWallet/RoomWalletAdapter.js";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { MainnetNativeTonService, MAINNET_TONCENTER_RPC_ENDPOINT } from "../payment/MainnetNativeTonService.js";
import { MainnetRoomWalletAdapter } from "../payment/MainnetRoomWalletAdapter.js";
import { MainnetToncenterOutgoingTransferObserver } from "../payment/MainnetToncenterOutgoingTransferObserver.js";
import { mainnetAddressIdentity } from "../payment/MainnetAddress.js";
import { MainnetToncenterReadClient } from "../payment/MainnetToncenterReadClient.js";

function catalog() {
    return JSON.stringify(Array.from({ length: 64 }, (_, i) => ({
        walletId: `mw-${i + 1}`, roomNumber: i + 1,
        address: `0:${String(i + 10).padStart(64, "0")}`, network: "mainnet"
    })));
}

function harness(t, { seqno = 7, failBroadcast = false, failSeqno = false } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-outgoing-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const config = loadMainnetRuntimeConfig({
        TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-synthetic-key",
        MAINNET_ROOM_WALLET_DATA_DIR: dataDir,
        MAINNET_ROOM_WALLETS_JSON: catalog()
    });
    const keys = keyPairFromSeed(Buffer.alloc(32, 23));
    const address = WalletContractV4.create({ workchain: 0, publicKey: keys.publicKey }).address.toString();
    const state = { now: 1_800_000_000_000, seqno, failBroadcast, failSeqno, sent: [], events: [] };
    const tonService = {
        getSeqno: async () => {
            state.events.push(`seqno:${state.seqno}`);
            if (state.failSeqno) throw new Error("MOCK_RPC_TIMEOUT");
            return state.seqno;
        },
        broadcastTransaction: async (boc) => {
            state.events.push(`broadcast:${state.seqno}`);
            state.sent.push(boc);
            if (state.failBroadcast) throw new Error("MOCK_BROADCAST_REPLY_TIMEOUT");
            return { hash: `mock-hash-${state.sent.length}` };
        }
    };
    const walletResolver = async (roomNumber) => ({
        roomNumber, address, workchain: 0, network: "mainnet", globalId: -239, ...keys
    });
    const make = (overrides = {}) => new MainnetRoomWalletAdapter({
        config, tonService, walletResolver,
        now: () => state.now,
        sleep: async () => {},
        seqnoConfirmTimeoutMs: 1,
        seqnoConfirmPollMs: 0,
        ...overrides
    });
    const request = (idempotencyKey = null, amountNano = 2_850_000_000n) => ({
        roomNumber: 2,
        destination: `0:${"b".repeat(64)}`,
        amountNano,
        bounce: false,
        ...(idempotencyKey === null ? {} : { idempotencyKey })
    });
    return { config, state, keys, address, walletResolver, tonService, make, request };
}

test("Mainnet native Toncenter transport requires explicit Mainnet identity and uses Mainnet JSON-RPC", async (t) => {
    const h = harness(t);
    assert.throws(() => new MainnetNativeTonService({ config: {
        network: "testnet", globalId: -3, toncenterBaseUrl: "https://testnet.toncenter.com",
        apiKeyProvider: () => "synthetic"
    }, client: {} }), /MAINNET_NATIVE_TON_CONFIG_REQUIRED/);
    let account, method, sent;
    const service = new MainnetNativeTonService({ config: h.config, client: {
        getContractState: async (value) => { account = value; return { state: "active" }; },
        runMethod: async (_value, name) => { method = name; return { stack: { readNumber: () => 9 } }; },
        getBalance: async () => 77n,
        sendFile: async (boc) => { sent = boc; }
    } });
    assert.equal(MAINNET_TONCENTER_RPC_ENDPOINT, "https://toncenter.com/api/v2/jsonRPC");
    assert.equal(await service.getSeqno(h.address), 9);
    assert.equal(Address.isAddress(account), true);
    assert.equal(method, "seqno");
    assert.equal(await service.getBalance(h.address), 77n);
    assert.deepEqual(await service.broadcastTransaction(Buffer.from("boc").toString("base64")),
        { status: "SUBMITTED_UNCONFIRMED" });
    assert.deepEqual(sent, Buffer.from("boc"));
});

test("Mainnet raw outgoing-history pages use only fixed Toncenter GET and bounded query fields", async (t) => {
    const h = harness(t);
    const calls = [];
    const readClient = new MainnetToncenterReadClient({ config: h.config, fetchImpl: async (url, init) => {
        calls.push({ url: new URL(String(url)), init });
        return { status: 200, json: async () => ({ transactions: [{ hash: "synthetic" }] }) };
    } });
    const payload = await readClient.getTransactions({
        account: h.address, startUtime: 100, endUtime: 200, limit: 25, offset: 50
    });
    assert.equal(payload.transactions[0].hash, "synthetic");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.hostname, "toncenter.com");
    assert.equal(calls[0].url.pathname, "/api/v3/transactions");
    assert.equal(calls[0].url.searchParams.get("offset"), "50");
    assert.equal(calls[0].init.method, "GET");
    assert.equal(Object.keys(calls[0].init.headers).some((name) => /authorization/i.test(name)), false);
    await assert.rejects(readClient.getTransactions({ account: h.address, startUtime: 200, endUtime: 100 }),
        /MAINNET_TRANSACTION_QUERY_INVALID/);
});

test("seqno RPC timeout fails before signing or broadcast and a later retry can proceed", async (t) => {
    const h = harness(t, { failSeqno: true });
    const adapter = h.make();
    await assert.rejects(adapter.sendTransfer(h.request()), /MOCK_RPC_TIMEOUT/);
    assert.equal(h.state.sent.length, 0);
    h.state.failSeqno = false;
    const retry = await adapter.sendTransfer(h.request());
    assert.equal(retry.ok, true);
    assert.equal(h.state.sent.length, 1);
});

test("one outgoing transfer uses the authoritative WalletV4 seqno and preserves unconfirmed status", async (t) => {
    const h = harness(t);
    const result = await h.make().sendTransfer(h.request());
    assert.equal(result.ok, true);
    assert.equal(result.seqno, 7);
    assert.equal(result.code, "SENT");
    assert.deepEqual(h.state.events, ["seqno:7", "broadcast:7"]);
    assert.equal(h.state.sent.length, 1);
});

test("two sequential sends wait for each accepted seqno before creating the next transaction", async (t) => {
    const h = harness(t);
    h.tonService.broadcastTransaction = async (boc) => {
        h.state.sent.push(boc);
        h.state.events.push(`broadcast:${h.state.seqno}`);
        h.state.seqno += 1;
        return { status: "SUBMITTED_UNCONFIRMED" };
    };
    const adapter = h.make();
    const first = await adapter.sendTransfer(h.request());
    const second = await adapter.sendTransfer(h.request(null, 2_000_000_000n));
    assert.deepEqual([first.seqno, second.seqno], [7, 8]);
    assert.equal(h.state.sent.length, 2);
    assert.ok(h.state.events.indexOf("broadcast:7") < h.state.events.indexOf("seqno:8"));
});

test("concurrent requests for one wallet are serialized and use distinct seqnos", async (t) => {
    const h = harness(t);
    h.tonService.broadcastTransaction = async (boc) => {
        h.state.sent.push(boc);
        h.state.events.push(`broadcast:${h.state.seqno}`);
        h.state.seqno += 1;
        return { status: "SUBMITTED_UNCONFIRMED" };
    };
    const adapter = h.make();
    const [a, b] = await Promise.all([
        adapter.sendTransfer(h.request("parallel-a")),
        adapter.sendTransfer(h.request("parallel-b", 2_000_000_000n))
    ]);
    assert.deepEqual([a.seqno, b.seqno], [7, 8]);
    assert.equal(h.state.sent.length, 2);
    assert.ok(h.state.events.indexOf("broadcast:7") < h.state.events.indexOf("seqno:8"));
});

test("RPC timeout keeps the durable seqno hold and the same result is replayed without a second payment", async (t) => {
    const h = harness(t, { failBroadcast: true });
    const key = "block3a:room-2:winner";
    await assert.rejects(h.make().sendTransfer(h.request(key)), /MOCK_BROADCAST_REPLY_TIMEOUT/);
    h.state.failBroadcast = false;
    const retry = await h.make().sendTransfer(h.request(key));
    assert.equal(retry.code, "SUBMITTED_UNCONFIRMED");
    assert.equal(h.state.sent.length, 2);
    assert.equal(h.state.sent[0], h.state.sent[1]);
    h.state.seqno = 8;
    const confirmed = await h.make().sendTransfer(h.request(key));
    assert.deepEqual(confirmed, { ok: true, code: "ACCEPTED_AWAITING_CREDIT", seqno: 7, txHash: null });
    assert.equal(h.state.sent.length, 2);
});

test("restart before seqno confirmation replays the persisted identical signed BOC", async (t) => {
    const h = harness(t, { failBroadcast: true });
    const key = "block3a:restart-before-confirmation";
    await assert.rejects(h.make().sendTransfer(h.request(key)), /MOCK_BROADCAST_REPLY_TIMEOUT/);
    h.state.failBroadcast = false;
    const recovered = await h.make().sendTransfer(h.request(key));
    assert.equal(recovered.seqno, 7);
    assert.equal(h.state.sent.length, 2);
    assert.equal(h.state.sent[0], h.state.sent[1]);
});

test("restart after authoritative seqno advancement does not broadcast again", async (t) => {
    const h = harness(t);
    const key = "block3a:restart-after-confirmation";
    await h.make().sendTransfer(h.request(key));
    h.state.seqno = 8;
    const recovered = await h.make().sendTransfer(h.request(key));
    assert.deepEqual(recovered, { ok: true, code: "ACCEPTED_AWAITING_CREDIT", seqno: 7, txHash: null });
    assert.equal(h.state.sent.length, 1);
});

test("expired ambiguous message is renewed only with the same unused authoritative seqno", async (t) => {
    const h = harness(t, { failBroadcast: true });
    const key = "block3a:expired-same-seqno";
    await assert.rejects(h.make().sendTransfer(h.request(key)), /MOCK_BROADCAST_REPLY_TIMEOUT/);
    h.state.failBroadcast = false;
    h.state.now += 121_000;
    const renewed = await h.make().sendTransfer(h.request(key));
    assert.equal(renewed.seqno, 7);
    assert.equal(h.state.sent.length, 2);
    assert.notEqual(h.state.sent[0], h.state.sent[1]);
    h.state.seqno = 8;
    h.state.now += 121_000;
    const confirmed = await h.make().sendTransfer(h.request(key));
    assert.equal(confirmed.code, "ACCEPTED_AWAITING_CREDIT");
    assert.equal(h.state.sent.length, 2);
});

test("Mainnet adapter rejects Testnet-tagged wallet identities and mismatched retry payloads", async (t) => {
    const h = harness(t);
    const testnetResolver = async () => ({
        roomNumber: 2, address: h.address, workchain: 0, network: "testnet", globalId: -3,
        ...h.keys
    });
    await assert.rejects(new MainnetRoomWalletAdapter({ config: h.config,
        tonService: h.tonService, walletResolver: testnetResolver }).sendTransfer(h.request()),
    /MAINNET_WALLET_IDENTITY_INVALID/);
    const adapter = h.make();
    await adapter.sendTransfer(h.request("same-key"));
    await assert.rejects(adapter.sendTransfer(h.request("same-key", 1n)), /IDENTITY_MISMATCH/);
    assert.equal(h.state.sent.length, 1);
});

test("Mainnet send algorithm follows the Testnet adapter's seqno and durable retry behavior", async (t) => {
    const h = harness(t);
    const mainnetTrace = [];
    const testnetTrace = [];
    const mainnetTon = {
        getSeqno: async () => { mainnetTrace.push("seqno"); return 7; },
        broadcastTransaction: async (boc) => { mainnetTrace.push("broadcast"); return { status: "SUBMITTED_UNCONFIRMED" }; }
    };
    const testnetTon = {
        getSeqno: async () => { testnetTrace.push("seqno"); return 7; },
        broadcastTransaction: async (boc) => { testnetTrace.push("broadcast"); return { status: "SUBMITTED_UNCONFIRMED" }; }
    };
    const keyPair = h.keys;
    const mainnetResolver = async (roomNumber) => ({ roomNumber, address: h.address,
        workchain: 0, network: "mainnet", globalId: -239, ...keyPair });
    const testnetResolver = async (roomNumber) => ({ roomNumber, address: h.address,
        workchain: 0, network: "testnet", ...keyPair });
    const mn = new MainnetRoomWalletAdapter({ config: h.config, tonService: mainnetTon,
        walletResolver: mainnetResolver });
    const tn = new RoomWalletAdapter({ tonService: testnetTon, walletResolver: testnetResolver });
    const resultMn = await mn.sendTransfer(h.request());
    const resultTn = await tn.sendTransfer(h.request());
    assert.equal(resultMn.seqno, resultTn.seqno);
    assert.equal(resultMn.code, resultTn.code);
    assert.deepEqual(mainnetTrace, testnetTrace);
});

test("Mainnet outgoing confirmation correlates source and recipient histories and requires -239 indexed head", async (t) => {
    const h = harness(t);
    const destination = `0:${"c".repeat(64)}`;
    const messageHash = "message-hash-1";
    const sourceRow = { hash: "source-tx-1", account: h.address, now: 1_800_000_000,
        description: { aborted: false, action: { success: true } },
        mc_block_seqno: 100, block_ref: { workchain: 0, shard: "8000000000000000", seqno: 50 },
        emulated: false, finality: 2,
        out_msgs: [{ hash: messageHash, source: h.address, destination, value: "123456789", bounced: false,
        }] };
    const recipientRow = { hash: "recipient-tx-1", account: destination, now: 1_800_000_001,
        description: { aborted: false },
        mc_block_seqno: 101, block_ref: { workchain: 0, shard: "8000000000000000", seqno: 51 },
        emulated: false, finality: 2,
        in_msg: { hash: messageHash, source: h.address, destination, value: "123456789", bounced: false } };
    const client = {
        getTransactions: async ({ account }) => ({ transactions:
            mainnetAddressIdentity(account) === mainnetAddressIdentity(h.address) ? [sourceRow] : [recipientRow] }),
        getMasterchainInfo: async () => ({ last: { global_id: -239, seqno: 102 } })
    };
    const observer = new MainnetToncenterOutgoingTransferObserver({
        client, nowProvider: () => 1_800_000_010_000
    });
    const observed = await observer.observeRecipientCredit({
        sourceWalletAddress: h.address, destinationIdentity: destination,
        transactionId: "source-tx-1", amountAtomic: 123456789,
        minCreatedAtMs: 1_800_000_000_000
    });
    assert.equal(observed.status, "RECIPIENT_CREDIT_OBSERVED_UNFINALIZED");
    const finalized = await observer.verifyIndexedRecipientCredit({
        sourceWalletAddress: h.address, destinationIdentity: destination,
        transactionId: "source-tx-1", amountAtomic: 123456789,
        minCreatedAtMs: 1_800_000_000_000
    });
    assert.equal(finalized.status, "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED");
    assert.equal(finalized.globalId, -239);
    assert.equal(finalized.sourceTransactionId, "source-tx-1");
    assert.equal(finalized.recipientTransactionId, "recipient-tx-1");
});

test("Mainnet outgoing confirmation fails closed on Testnet head identity and incomplete history", async (t) => {
    const h = harness(t);
    const destination = `0:${"c".repeat(64)}`;
    const client = {
        getTransactions: async () => ({ transactions: [{ hash: "tx", account: h.address,
            description: { aborted: false, action: { success: true } }, out_msgs: [] }] }),
        getMasterchainInfo: async () => ({ last: { global_id: -3, seqno: 100 } })
    };
    const wrongNetwork = new MainnetToncenterOutgoingTransferObserver({
        client, nowProvider: () => 1_800_000_010_000
    });
    assert.equal(await wrongNetwork.verifyIndexedRecipientCredit({
        sourceWalletAddress: h.address, destinationIdentity: destination,
        transactionId: "tx", amountAtomic: 123, minCreatedAtMs: 1_800_000_000_000
    }), null);
    const incomplete = new MainnetToncenterOutgoingTransferObserver({
        client, nowProvider: () => 1_800_000_010_000, pageSize: 1, maxPages: 1
    });
    await assert.rejects(incomplete.getOutgoingTransfer({
        sourceWalletAddress: h.address, transactionId: "tx",
        minCreatedAtMs: 1_800_000_000_000
    }), /MAINNET_OUTGOING_HISTORY_INCOMPLETE/);
});
