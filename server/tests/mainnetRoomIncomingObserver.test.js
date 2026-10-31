import test from "node:test";
import assert from "node:assert/strict";
import { Address } from "@ton/core";
import { ToncenterTransactionsClient } from "../payment/toncenter/ToncenterTransactionsClient.js";
import { mapToncenterTransactionsResponse } from "../payment/toncenter/ToncenterTransactionsMapper.js";
import { MAINNET_TONCENTER_URL } from "../mainnet/MainnetReadOnlyPreflight.js";
import { MainnetRoomIncomingObserver } from "../mainnet/MainnetRoomIncomingObserver.js";

const wallet = "0:" + "a".repeat(64);
const payer = "0:" + "b".repeat(64);
const roomId = "mainnet-active-room-1";
const reference = "WW-ROOM-1-TEST";
const unixSec = Math.floor(Date.now() / 1000);
const env = Object.freeze({ TON_NETWORK: "mainnet", ROOM_WALLET_PAYMENTS_ENABLED: "false" });
const reservation = Object.freeze({roomNumber: 2, address: wallet, reservedByRoomId: roomId});
function transfer() {
    return {
        hash: "mainnet-synthetic-tx-hash",
        account: wallet,
        now: unixSec,
        emulated: false,
        block_ref: { workchain: 0, shard: "8000000000000000", seqno: 55000 },
        mc_block_seqno: 96000,
        description: { aborted: false, compute_ph: { success: true }, action: { success: true } },
        in_msg: {
            source: payer, destination: wallet, value: "1000000000",
            message_content: { decoded: { type: "text_comment", comment: "WW1:" + reference } }
        }
    };
}
function fixture({ globalId = -239, seqno = 96100, rows = [transfer()] } = {}) {
    const calls = [];
    const client = new ToncenterTransactionsClient({
        baseUrl: MAINNET_TONCENTER_URL,
        apiKeyProvider: () => "MOCK-MAINNET-NOT-REAL",
        fetchImpl: async (input, init) => {
            const u = new URL(input);
            calls.push({ method: init.method, path: u.pathname, account: u.searchParams.get("account") });
            const response = u.pathname === "/api/v3/masterchainInfo"
                ? { last: { global_id: globalId, seqno } }
                : { transactions: rows, address_book: {} };
            return new Response(JSON.stringify(response), { status: 200 });
        }
    });
    return { client, calls };
}
function observer(f = fixture(), resolveActiveRoomWallet = () => reservation, overrides = {}) {
    return new MainnetRoomIncomingObserver({
        env, client: f.client, resolveActiveRoomWallet, ...overrides
    });
}
const query = {
    roomId, walletAddress: wallet,
    floorMs: unixSec * 1000 - 10000,
    ceilingMs: unixSec * 1000 + 10000,
    limit: 10
};

test("on-demand Mainnet query reads global-ID -239 before only one active wallet", async () => {
    const f = fixture();
    const o = observer(f);
    assert.equal(f.calls.length, 0, "no polling on construct");
    const result = await o.observeRoom(query);
    assert.deepEqual(f.calls.map(c => c.path), [
        "/api/v3/masterchainInfo", "/api/v3/transactions"
    ]);
    assert.ok(f.calls.every(c => c.method === "GET"), "strictly GET requests");
    assert.equal(f.calls[1].account, wallet, "only reserved wallet queried");
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].network, "mainnet");
    assert.equal(result.records[0].sourceAddress, payer);
    assert.equal(result.records[0].amountAtomic, "1000000000");
    assert.equal(result.records[0].comment, reference);
    assert.equal(result.records[0].indexedTransaction.emulated, false);
    assert.equal(result.resultWindowComplete, true);
    assert.equal(o.sendTransfer, undefined);
    assert.equal(o.settlePayment, undefined);
    assert.equal(o.broadcastTransaction, undefined);
});

test("Testnet global ID -3 fails before transaction reads", async () => {
    const f = fixture({ globalId: -3 });
    await assert.rejects(observer(f).observeRoom(query),
        /MAINNET_INCOMING_CHAIN_IDENTITY_INVALID/);
    assert.deepEqual(f.calls.map(c => c.path), ["/api/v3/masterchainInfo"]);
});

test("missing masterchain block fails without transaction reads", async () => {
    const f = fixture({ globalId: -239, seqno: null });
    await assert.rejects(observer(f).observeRoom(query),
        /MAINNET_INCOMING_CHAIN_IDENTITY_INVALID/);
    assert.equal(f.calls.length, 1);
});

test("unreserved and foreign wallet accounts never cause RPC", async () => {
    const f = fixture();
    await assert.rejects(observer(f, () => null).observeRoom(query),
        /MAINNET_INCOMING_WALLET_NOT_ACTIVE/);
    await assert.rejects(observer(f).observeRoom({
        ...query, roomId: "other-room"
    }), /MAINNET_INCOMING_WALLET_NOT_ACTIVE/);
    await assert.rejects(observer(f).observeRoom({
        ...query, walletAddress: payer
    }), /MAINNET_INCOMING_WALLET_NOT_ACTIVE/);
    assert.equal(f.calls.length, 0);
});

test("test-only wallet display tag never enters Mainnet RPC", async () => {
    const f = fixture();
    const display = Address.parse(wallet).toString({ testOnly: true });
    await assert.rejects(observer(f).observeRoom({
        ...query, walletAddress: display
    }), /MAINNET_INCOMING_ROOM_QUERY_INVALID/);
    assert.equal(f.calls.length, 0);
});

test("Testnet runtime and premature payments remain excluded", () => {
    const f = fixture();
    assert.throws(() => observer(f, () => reservation, {
        env: { TON_NETWORK: "testnet" }
    }), /MAINNET_INCOMING_NETWORK_MISMATCH/);
    assert.throws(() => observer(f, () => reservation, {
        env: { TON_NETWORK: "mainnet", ROOM_WALLET_PAYMENTS_ENABLED: "true" }
    }), /MAINNET_INCOMING_PAYMENTS_NOT_ALLOWED/);
});

test("Testnet Toncenter endpoint is rejected before any request", () => {
    const f = fixture();
    const wrong = new ToncenterTransactionsClient({
        baseUrl: "https://testnet.toncenter.com",
        apiKeyProvider: () => "MOCK",
        fetchImpl: async () => { throw new Error("SHOULD_NOT_CALL"); }
    });
    assert.throws(() => observer(f, () => reservation, { client: wrong }),
        /MAINNET_INCOMING_RPC_ENDPOINT_MISMATCH/);
    assert.equal(f.calls.length, 0);
});

test("malformed provider rows fail closed and do not settle payments", async () => {
    const bad = transfer(); bad.in_msg.value = "1.01";
    const f = fixture({ rows: [bad] });
    await assert.rejects(observer(f).observeRoom(query),
        /MAINNET_INCOMING_TRANSACTION_READ_FAILED/);
    assert.equal(f.calls.length, 2);
});

test("shared mapper default retains Testnet network on legacy calls", () => {
    const result = mapToncenterTransactionsResponse({
        transactions: [transfer()], address_book: {}
    }, {
        walletAddress: wallet, floorMs: query.floorMs,
        ceilingMs: query.ceilingMs, limit: 10
    });
    assert.equal(result.records[0].network, "testnet");
    assert.throws(() => mapToncenterTransactionsResponse({
        transactions: [], address_book: {}
    }, {
        walletAddress: wallet, floorMs: query.floorMs,
        ceilingMs: query.ceilingMs, limit: 10, network: "unknown"
    }), /Toncenter mapper network scope is invalid/);
});
