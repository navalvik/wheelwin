import test from "node:test";
import assert from "node:assert/strict";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";
import {
    inspectMainnetConfiguration,
    probeMainnetReadOnly,
    MAINNET_GLOBAL_ID,
    MAINNET_TONCENTER_URL
} from "../mainnet/MainnetReadOnlyPreflight.js";

function wallets() {
    return Array.from({ length: 64 }, (_, i) => {
        const keys = keyPairFromSeed(Buffer.alloc(32, i + 1));
        return {
            roomNumber: i + 1,
            network: "mainnet",
            workchain: 0,
            address: WalletContractV4.create({
                workchain: 0,
                publicKey: keys.publicKey
            }).address.toString({ testOnly: false }),
            publicKey: keys.publicKey.toString("hex"),
            secretKey: keys.secretKey.toString("hex")
        };
    });
}

const entries = wallets();
const env = {
    TON_NETWORK: "mainnet",
    OWNER_WALLET: entries[0].address,
    ROOM_WALLETS_MAINNET_JSON: JSON.stringify(entries),
    TON_API_KEY: "OFFLINE-MOCK-KEY-NOT-REAL",
    TON_FINANCIAL_DATA_DIR: "/tmp/wheelwin-mainnet-durable",
    ROOM_WALLET_PAYMENTS_ENABLED: "false"
};

test("64 Mainnet WalletV4 identities validate without exposing secrets", () => {
    const snapshot = inspectMainnetConfiguration(env);
    assert.equal(snapshot.walletCount, 64);
    assert.equal(snapshot.network, "mainnet");
    assert.equal(snapshot.livePaymentsEnabled, false);
    assert.equal(snapshot.mode, "READ_ONLY");
    const output = JSON.stringify(snapshot);
    assert.ok(!output.includes("secretKey"));
    assert.ok(!output.includes("publicKey"));
    assert.ok(!output.includes("OFFLINE-MOCK"));
    assert.ok(!output.includes(entries[0].address));
});

test("wrong network cannot reuse Testnet catalog as Mainnet", () => {
    assert.throws(
        () => inspectMainnetConfiguration({ ...env, TON_NETWORK: "testnet" }),
        /MAINNET_PREFLIGHT_NETWORK_MISMATCH/
    );
    assert.throws(
        () => inspectMainnetConfiguration({
            ...env,
            ROOM_WALLETS_MAINNET_JSON: "",
            ROOM_WALLETS_JSON: env.ROOM_WALLETS_MAINNET_JSON
        }),
        /MAINNET_PREFLIGHT_CATALOG_REQUIRED/
    );
    assert.throws(
        () => inspectMainnetConfiguration({
            ...env,
            ROOM_WALLETS_MAINNET_JSON: JSON.stringify(
                entries.map((record, i) => i === 2
                    ? { ...record, network: "testnet" }
                    : record)
            )
        }),
        /MAINNET_PREFLIGHT_WALLET_NETWORK_MISMATCH/
    );
});

test("wrong keys, incomplete catalog and test-only owner fail closed", () => {
    assert.throws(
        () => inspectMainnetConfiguration({
            ...env,
            ROOM_WALLETS_MAINNET_JSON: JSON.stringify(entries.slice(1))
        }),
        /MAINNET_PREFLIGHT_WALLET_COUNT_INVALID/
    );
    assert.throws(
        () => inspectMainnetConfiguration({
            ...env,
            ROOM_WALLETS_MAINNET_JSON: JSON.stringify(entries.map((r, i) =>
                i === 1 ? { ...r, secretKey: entries[3].secretKey } : r
            ))
        }),
        /MAINNET_PREFLIGHT_CATALOG_IDENTITY_INVALID/
    );
    assert.throws(
        () => inspectMainnetConfiguration({
            ...env,
            OWNER_WALLET: WalletContractV4.create({
                workchain: 0,
                publicKey: keyPairFromSeed(Buffer.alloc(32, 1)).publicKey
            }).address.toString({ testOnly: true })
        }),
        /MAINNET_PREFLIGHT_OWNER_ADDRESS_INVALID/
    );
});

test("Mainnet readiness cannot enable live payments", () => {
    assert.throws(
        () => inspectMainnetConfiguration({
            ...env,
            ROOM_WALLET_PAYMENTS_ENABLED: "true"
        }),
        /MAINNET_PREFLIGHT_LIVE_PAYMENTS_MUST_REMAIN_DISABLED/
    );
});

test("read-only chain identity requires global ID -239 and verified head", async () => {
    let rpcCalls = 0;
    const client = {
        baseUrl: MAINNET_TONCENTER_URL,
        async getMasterchainInfo() {
            rpcCalls += 1;
            return { last: { global_id: MAINNET_GLOBAL_ID, seqno: 75000000 } };
        }
    };
    const snapshot = await probeMainnetReadOnly({ env, client });
    assert.equal(snapshot.chainGlobalId, -239);
    assert.equal(snapshot.chainIdentityVerified, true);
    assert.equal(snapshot.livePaymentsEnabled, false);
    assert.equal(rpcCalls, 1);
});

test("wrong RPC, Testnet chain identity, missing head and failures reject", async () => {
    const makeClient = (global_id, seqno = 10) => ({
        baseUrl: MAINNET_TONCENTER_URL,
        async getMasterchainInfo() {
            return { last: { global_id, seqno } };
        }
    });
    await assert.rejects(
        probeMainnetReadOnly({ env, client: makeClient(-3) }),
        /MAINNET_PREFLIGHT_CHAIN_IDENTITY_INVALID/
    );
    await assert.rejects(
        probeMainnetReadOnly({ env, client: makeClient(-239, null) }),
        /MAINNET_PREFLIGHT_CHAIN_IDENTITY_INVALID/
    );
    await assert.rejects(
        probeMainnetReadOnly({
            env, client: { ...makeClient(-239), baseUrl: "https://testnet.toncenter.com" }
        }),
        /MAINNET_PREFLIGHT_RPC_ENDPOINT_MISMATCH/
    );
    await assert.rejects(
        probeMainnetReadOnly({
            env,
            client: {
                baseUrl: MAINNET_TONCENTER_URL,
                async getMasterchainInfo() { throw new Error("TOKEN-DO-NOT-LEAK"); }
            }
        }),
        /MAINNET_PREFLIGHT_RPC_UNAVAILABLE/
    );
});
