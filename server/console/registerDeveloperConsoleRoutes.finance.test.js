import assert from "node:assert/strict";
import test from "node:test";
import { Address } from "@ton/core";
import { registerDeveloperConsoleRoutes } from "./registerDeveloperConsoleRoutes.js";

const ownerAddress = new Address(0, Buffer.alloc(32, 0x52)).toRawString();

function fixture(env) {
    const routes = new Map();
    const fetchCalls = [];
    const app = {
        use() {},
        get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
        post() {}, put() {}
    };
    registerDeveloperConsoleRoutes(app, {}, {
        env,
        fetchImpl: async (url, options) => {
            fetchCalls.push({ url: String(url), options });
            return { ok: true, async json() {
                return { ok: true, result: { balance: "9876543210", state: "active" } };
            } };
        }
    });
    return { handler: routes.get("GET /console/wallets/balances")[0], fetchCalls };
}

async function request(handler, network, developer = { role: "Administrator" }) {
    let statusCode = 200;
    let body = null;
    const response = {
        status(code) { statusCode = code; return this; },
        setHeader() {},
        json(value) { body = value; return this; }
    };
    await handler({ query: { network }, developer }, response);
    return { statusCode, body };
}

test("Finance Mainnet uses only MAINNET_TONCENTER_API_KEY and the Mainnet endpoint", async () => {
    const f = fixture({ TON_NETWORK: "mainnet", OWNER_WALLET_MAINNET: ownerAddress,
        MAINNET_TONCENTER_API_KEY: "mainnet-current-key",
        TONCENTER_MAINNET_API_KEY: "legacy-wrong-key", TON_API_KEY: "generic-wrong-key" });
    const result = await request(f.handler, "mainnet");
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.network, "mainnet");
    assert.equal(result.body.balanceNano, "9876543210");
    assert.equal(f.fetchCalls.length, 1);
    assert.equal(f.fetchCalls[0].url,
        `https://toncenter.com/api/v2/getAddressInformation?address=${encodeURIComponent(ownerAddress)}`);
    assert.equal(f.fetchCalls[0].options.headers["X-API-Key"], "mainnet-current-key");
});

test("Finance Testnet keeps its Testnet endpoint and existing API-key source", async () => {
    const f = fixture({ TON_NETWORK: "testnet", OWNER_WALLET_TESTNET: ownerAddress,
        TONCENTER_TESTNET_API_KEY: "testnet-existing-key",
        MAINNET_TONCENTER_API_KEY: "mainnet-key-must-not-leak" });
    const result = await request(f.handler, "testnet");
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.network, "testnet");
    assert.equal(f.fetchCalls.length, 1);
    assert.match(f.fetchCalls[0].url, /^https:\/\/testnet\.toncenter\.com\//);
    assert.equal(f.fetchCalls[0].options.headers["X-API-Key"], "testnet-existing-key");
});

test("Finance balance lookup still rejects non-Administrator access", async () => {
    const f = fixture({ TON_NETWORK: "mainnet", OWNER_WALLET_MAINNET: ownerAddress,
        MAINNET_TONCENTER_API_KEY: "mock-key" });
    const result = await request(f.handler, "mainnet", { role: "Viewer" });
    assert.equal(result.statusCode, 403);
    assert.equal(f.fetchCalls.length, 0);
});
