/**
 * T2.2 — TonService tests.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { TonService } from "../services/TonService.js";
import {
    NetworkUnavailableError,
    TimeoutError,
    TonServiceNotConnectedError,
    UnsupportedNetworkError
} from "../services/ton/TonServiceErrors.js";
import { MockTonTransport } from "../payment/ton/MockTonTransport.js";

function createLogger() {

    return {
        info() {},
        error() {},
        warn() {},
        debug() {}
    };

}

function friendlyAddress(seedLabel) {

    const seed = createHash("sha256").update(seedLabel).digest();

    const keyPair = keyPairFromSeed(seed);

    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({
        bounceable: true,
        urlSafe: true
    });

}

function createTonConfig(overrides = {}) {

    return {
        network: "testnet",
        endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC",
        apiKey: null,
        deployMode: "stub",
        pollIntervalMs: 2000,
        deployerMnemonic: null,
        grmJettonMaster: null,
        ...overrides
    };

}

function createMockClient({
    masterchainInfo = { last: { seqno: 1 } },
    balance = 1_000_000_000n,
    runMethodResult = { stack: [{ value: 7 }] },
    failCount = 0
} = {}) {

    let calls = 0;

    return {
        calls: () => calls,
        async getMasterchainInfo() {

            calls += 1;

            if (calls <= failCount) {

                throw new Error("fetch failed");

            }

            return masterchainInfo;

        },
        async getBalance() {

            return balance;

        },
        async runMethod() {

            return runMethodResult;

        }
    };

}

function createService({
    transport = null,
    client = null,
    retryPolicy = null,
    tonConfig = null
} = {}) {

    const service = new TonService({
        logger: createLogger(),
        tonConfig: tonConfig ?? createTonConfig(),
        transport: transport ?? new MockTonTransport(),
        client: client ?? createMockClient(),
        retryPolicy
    });

    return service;

}

async function main() {

    // --- initialization ---

    {
        const service = createService();

        service.initialize();

        assert.equal(service.isConnected(), true);

        assert.equal(service.getActiveNetwork(), "testnet");

        await service.shutdown();

        assert.equal(service.isConnected(), false);

        console.log("  initialization + shutdown: OK");
    }

    // --- connect probe ---

    {
        const service = createService();

        await service.connect();

        const health = service.health();

        assert.equal(health.connected, true);

        assert.equal(health.network, "testnet");

        assert.ok(health.lastSuccessfulRPC != null);

        assert.equal(health.clientVersion, "ton-client@16");

        await service.shutdown();

        console.log("  connect probe: OK");
    }

    // --- reconnect ---

    {
        const service = createService();

        await service.connect();

        await service.disconnect();

        assert.equal(service.isConnected(), false);

        await service.reconnect();

        assert.equal(service.isConnected(), true);

        await service.shutdown();

        console.log("  reconnect: OK");
    }

    // --- network switch ---

    {
        const service = createService();

        await service.connect();

        const network = await service.switchNetwork({
            network: "mainnet",
            endpoint: "https://toncenter.com/api/v2/jsonRPC"
        });

        assert.equal(network, "mainnet");

        assert.equal(service.getActiveNetwork(), "mainnet");

        assert.equal(
            service.getConfig().endpoint,
            "https://toncenter.com/api/v2/jsonRPC"
        );

        await service.shutdown();

        console.log("  network switch: OK");
    }

    // --- unsupported network ---

    {
        const service = createService();

        await service.connect();

        await assert.rejects(
            () => service.switchNetwork({ network: "customnet" }),
            UnsupportedNetworkError
        );

        await service.shutdown();

        console.log("  unsupported network: OK");
    }

    // --- RPC request ---

    {
        const transport = new MockTonTransport();

        transport.seedAddressInfo("EQtest", {
            state: "active",
            balance: "1000000000"
        });

        const service = createService({ transport });

        await service.connect();

        const account = await service.getAccount("EQtest");

        assert.equal(account.balance, "1000000000");

        const broadcast = await service.broadcastTransaction("Ym9j");

        assert.ok(broadcast);

        assert.equal(transport.sentBocs.length, 1);

        await service.shutdown();

        console.log("  RPC request + broadcast: OK");
    }

    // --- retry ---

    {
        const client = createMockClient({ failCount: 2 });

        const service = createService({
            client,
            retryPolicy: {
                maxAttempts: 3,
                initialDelayMs: 1,
                maxDelayMs: 5,
                multiplier: 1,
                timeoutMs: 1000
            }
        });

        await service.connect();

        const balance = await service.getBalance(friendlyAddress("balance-test"));

        assert.equal(balance, 1_000_000_000n);

        assert.ok(client.calls() >= 3);

        await service.shutdown();

        console.log("  retry: OK");
    }

    // --- timeout ---

    {
        const client = {
            async getMasterchainInfo() {

                return { last: { seqno: 1 } };

            },
            async getBalance() {

                return new Promise(() => {});

            },
            async runMethod() {

                return { stack: [] };

            }
        };

        const service = createService({
            client,
            retryPolicy: {
                maxAttempts: 1,
                timeoutMs: 50
            }
        });

        await service.connect();

        await assert.rejects(
            () => service.getBalance(friendlyAddress("timeout-test")),
            TimeoutError
        );

        const health = service.health();

        assert.ok(health.lastFailure != null);

        await service.shutdown();

        console.log("  timeout: OK");
    }

    // --- health ---

    {
        const service = createService();

        await service.connect();

        const health = service.health();

        assert.equal(typeof health.uptime, "number");

        assert.equal(typeof health.latency, "number");

        assert.equal(health.endpoint, createTonConfig().endpoint);

        await service.shutdown();

        console.log("  health: OK");
    }

    // --- multiple sequential requests ---

    {
        const transport = new MockTonTransport();

        const service = createService({ transport });

        await service.connect();

        await service.broadcastTransaction("boc-1");

        await service.broadcastTransaction("boc-2");

        await service.getAccount("EQabc");

        assert.equal(transport.sentBocs.length, 2);

        await service.shutdown();

        console.log("  multiple sequential requests: OK");
    }

    // --- connection loss + recovery ---

    {
        let shouldFail = true;

        const transport = Object.assign(new MockTonTransport(), {
            async call(method) {

                if (shouldFail) {

                    throw new Error("fetch failed");

                }

                return {
                    "@type": "ok",
                    method
                };

            }
        });

        const service = createService({
            transport,
            retryPolicy: {
                maxAttempts: 1,
                timeoutMs: 1000
            }
        });

        await service.connect();

        shouldFail = true;

        await assert.rejects(
            () => service.rpcCall("getMasterchainInfo"),
            NetworkUnavailableError
        );

        shouldFail = false;

        await service.reconnect();

        const info = await service.rpcCall("getMasterchainInfo");

        assert.ok(info);

        assert.equal(service.isConnected(), true);

        await service.shutdown();

        console.log("  connection loss + recovery: OK");
    }

    // --- waitForTransaction ---

    {
        const transport = new MockTonTransport();

        transport.seedTransactions("EQwait", [
            {
                transaction_id: { hash: "abc123" },
                utime: 1
            }
        ]);

        const service = createService({ transport });

        await service.connect();

        const tx = await service.waitForTransaction({
            address: "EQwait",
            hash: "abc123",
            timeoutMs: 1000,
            pollIntervalMs: 50
        });

        assert.equal(tx.transaction_id.hash, "abc123");

        await service.shutdown();

        console.log("  waitForTransaction: OK");
    }

    // --- getSeqno ---

    {
        const service = createService({
            client: createMockClient({
                runMethodResult: { stack: [{ value: 12 }] }
            })
        });

        await service.connect();

        const seqno = await service.getSeqno(friendlyAddress("seqno-test"));

        assert.equal(seqno, 12);

        await service.shutdown();

        console.log("  getSeqno: OK");
    }

    // --- not connected guard ---

    {
        const service = createService();

        await service.connect();

        await service.disconnect();

        assert.throws(
            () => service.getClient(),
            TonServiceNotConnectedError
        );

        console.log("  not connected guard: OK");
    }

    console.log("tonService tests passed");
}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
