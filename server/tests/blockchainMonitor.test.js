/**
 * T2.5 — BlockchainMonitor tests.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    BLOCKCHAIN_MONITOR_STATE,
    BlockchainMonitor,
    EntryPaymentAuditLedger,
    MonitorNotStartedError,
    ObservationTimeoutError,
    amountsMatch,
    parseDepositCandidate
} from "../payment/BlockchainMonitor.js";
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

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function createMonitor({
    transport = null,
    pollIntervalMs = 50_000,
    transactionTimeoutMs = 120_000
} = {}) {

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const resolvedTransport = transport ?? new MockTonTransport();

    const audit = new EntryPaymentAuditLedger();

    const monitor = new BlockchainMonitor({
        logger,
        eventBus,
        transport: resolvedTransport,
        auditLedger: audit,
        pollIntervalMs,
        transactionTimeoutMs
    });

    monitor.initialize();

    return { logger, eventBus, transport: resolvedTransport, audit, monitor };

}

assert.equal(amountsMatch(10, 10), true);

assert.equal(amountsMatch(10, 9.99), false);

assert.equal(
    parseDepositCandidate({
        in_msg: {
            source: friendlyAddress("src"),
            destination: friendlyAddress("dst"),
            message: "ref_1",
            grmAmount: 10
        },
        transaction_id: { hash: "hash1" }
    }).amountGram,
    10
);

async function main() {

    // --- legacy payment watch + duplicate protection ---

    {
        const { eventBus, monitor, audit } = createMonitor();

        const confirmed = [];

        const rejected = [];

        const detected = [];

        eventBus.subscribe(EVENT_TYPES.PAYMENT_BLOCKCHAIN_CONFIRMED, (envelope) => {

            confirmed.push(envelope.payload);

        });

        eventBus.subscribe(EVENT_TYPES.PAYMENT_BLOCKCHAIN_REJECTED, (envelope) => {

            rejected.push(envelope.payload);

        });

        eventBus.subscribe(EVENT_TYPES.PAYMENT_TRANSACTION_DETECTED, (envelope) => {

            detected.push(envelope.payload);

        });

        const contractAddress = friendlyAddress("contract");

        const playerWallet = friendlyAddress("player");

        const wrongWallet = friendlyAddress("wrong");

        monitor.watchPayment({
            roomId: "room-1",
            gameId: "game-1",
            playerId: "p1",
            contractAddress,
            paymentReference: "payref_1",
            expectedGram: 10,
            expectedWallet: playerWallet
        });

        await monitor.ingestTransaction("room-1", {
            transaction_id: { hash: "tx_bad_sender" },
            in_msg: {
                source: wrongWallet,
                destination: contractAddress,
                message: "payref_1",
                grmAmount: 10
            }
        });

        assert.equal(rejected.length, 1);

        assert.equal(rejected[0].reason, "wrong_sender");

        assert.equal(confirmed.length, 0);

        assert.equal(detected.length, 1, "matching reference is detected before reject");

        await monitor.ingestTransaction("room-1", {
            transaction_id: { hash: "tx_ok" },
            in_msg: {
                source: playerWallet,
                destination: contractAddress,
                message: "payref_1",
                grmAmount: 10
            }
        });

        assert.equal(confirmed.length, 1);

        assert.equal(confirmed[0].txHash, "tx_ok");

        assert.equal(detected.length, 2);

        await monitor.ingestTransaction("room-1", {
            transaction_id: { hash: "tx_ok" },
            in_msg: {
                source: playerWallet,
                destination: contractAddress,
                message: "payref_1",
                grmAmount: 10
            }
        });

        const audits = audit.list("room-1");

        assert.ok(
            audits.some((entry) => entry.type === "DUPLICATE_PAYMENT"),
            "duplicate tx audited"
        );

        assert.equal(confirmed.length, 1, "duplicate does not re-confirm");

        monitor.shutdown();

        eventBus.shutdown();

        console.log("  payment observation + duplicate protection: OK");
    }

    // --- lifecycle start / stop / health ---

    {
        const { eventBus, monitor } = createMonitor();

        const connected = [];

        const disconnected = [];

        eventBus.subscribe(EVENT_TYPES.BLOCKCHAIN_CONNECTED, (envelope) => {

            connected.push(envelope.payload);

        });

        eventBus.subscribe(EVENT_TYPES.BLOCKCHAIN_DISCONNECTED, (envelope) => {

            disconnected.push(envelope.payload);

        });

        assert.equal(monitor.health().state, BLOCKCHAIN_MONITOR_STATE.STOPPED);

        await monitor.start();

        assert.equal(monitor.health().state, BLOCKCHAIN_MONITOR_STATE.RUNNING);

        assert.equal(monitor.health().connected, true);

        assert.equal(connected.length, 1);

        monitor.stop();

        assert.equal(monitor.health().state, BLOCKCHAIN_MONITOR_STATE.STOPPED);

        assert.equal(disconnected.length, 1);

        monitor.shutdown();

        eventBus.shutdown();

        console.log("  monitor start/stop/health: OK");
    }

    // --- contract registration + deployment confirmation ---

    {
        const transport = new MockTonTransport();

        const contractAddress = friendlyAddress("deploy-contract");

        transport.seedAddressInfo(contractAddress, {
            state: "active",
            balance: "1000"
        });

        const { eventBus, monitor } = createMonitor({
            transport,
            pollIntervalMs: 40
        });

        const deployConfirmed = [];

        eventBus.subscribe(EVENT_TYPES.CONTRACT_DEPLOYMENT_CONFIRMED, (envelope) => {

            deployConfirmed.push(envelope.payload);

        });

        await monitor.start();

        monitor.registerContract("contract-1", contractAddress, {
            roomId: "room-1",
            gameId: "game-1",
            correlationId: "corr-1",
            expectDeployment: true
        });

        assert.equal(monitor.listWatchedContracts().length, 1);

        await monitor.watchContract("contract-1");

        assert.equal(deployConfirmed.length, 1);

        assert.equal(deployConfirmed[0].contractId, "contract-1");

        assert.equal(deployConfirmed[0].correlationId, "corr-1");

        // Duplicate observation suppressed.
        await monitor.watchContract("contract-1");

        assert.equal(deployConfirmed.length, 1);

        monitor.unregisterContract("contract-1");

        assert.equal(monitor.listWatchedContracts().length, 0);

        monitor.shutdown();

        eventBus.shutdown();

        console.log("  contract registration + deploy confirm: OK");
    }

    // --- transaction wait / settlement confirmation ---

    {
        const transport = new MockTonTransport();

        const address = friendlyAddress("settle-contract");

        transport.seedTransactions(address, [
            {
                transaction_id: { hash: "settle-tx-1" },
                utime: 1
            }
        ]);

        const { eventBus, monitor } = createMonitor({ transport });

        const settlementConfirmed = [];

        eventBus.subscribe(EVENT_TYPES.SETTLEMENT_TRANSACTION_CONFIRMED, (envelope) => {

            settlementConfirmed.push(envelope.payload);

        });

        await monitor.start();

        const result = await monitor.waitForConfirmation({
            transactionId: "settle-tx-1",
            address,
            contractId: "contract-settle",
            kind: "SETTLEMENT",
            timeoutMs: 1000,
            pollIntervalMs: 20
        });

        assert.equal(result.status, "CONFIRMED");

        assert.equal(settlementConfirmed.length, 1);

        assert.equal(monitor.detectSuccess("settle-tx-1", "SETTLEMENT"), true);

        monitor.shutdown();

        eventBus.shutdown();

        console.log("  settlement confirmation: OK");
    }

    // --- observation timeout ---

    {
        const transport = new MockTonTransport();

        const address = friendlyAddress("timeout-contract");

        transport.seedTransactions(address, []);

        const { eventBus, monitor } = createMonitor({
            transport,
            transactionTimeoutMs: 80
        });

        await monitor.start();

        await assert.rejects(
            () => monitor.waitForConfirmation({
                transactionId: "missing-tx",
                address,
                timeoutMs: 80,
                pollIntervalMs: 20
            }),
            ObservationTimeoutError
        );

        monitor.shutdown();

        eventBus.shutdown();

        console.log("  observation timeout: OK");
    }

    // --- not started guard ---

    {
        const { eventBus, monitor } = createMonitor();

        assert.throws(
            () => monitor.watchContract("missing"),
            MonitorNotStartedError
        );

        monitor.shutdown();

        eventBus.shutdown();

        console.log("  not started guard: OK");
    }

    // --- recovery restart ---

    {
        const transport = new MockTonTransport();

        const address = friendlyAddress("recovery-contract");

        transport.seedAddressInfo(address, {
            state: "active",
            balance: "1"
        });

        const { eventBus, monitor } = createMonitor({ transport });

        await monitor.start();

        monitor.registerContract("contract-r", address, {
            expectDeployment: true,
            correlationId: "corr-r"
        });

        monitor.watchPayment({
            roomId: "room-r",
            gameId: "game-r",
            playerId: "p1",
            contractAddress: address,
            paymentReference: "ref-r",
            expectedGram: 5,
            expectedWallet: friendlyAddress("player-r")
        });

        await monitor.restart();

        assert.equal(monitor.health().state, BLOCKCHAIN_MONITOR_STATE.RUNNING);

        assert.equal(monitor.listWatchedContracts().length, 1);

        assert.equal(monitor.health().paymentWatches, 1);

        monitor.shutdown();

        eventBus.shutdown();

        console.log("  recovery restart: OK");
    }

    // --- connection loss → degraded ---

    {
        const transport = new MockTonTransport();

        transport.getTransactions = async () => {

            throw new Error("fetch failed");

        };

        const { eventBus, monitor } = createMonitor({
            transport,
            pollIntervalMs: 30
        });

        await monitor.start();

        monitor.watchPayment({
            roomId: "room-d",
            gameId: "game-d",
            playerId: "p1",
            contractAddress: friendlyAddress("degraded"),
            paymentReference: "ref-d",
            expectedGram: 1,
            expectedWallet: friendlyAddress("player-d")
        });

        await wait(80);

        assert.equal(monitor.health().state, BLOCKCHAIN_MONITOR_STATE.DEGRADED);

        assert.ok(monitor.health().lastFailure);

        monitor.shutdown();

        eventBus.shutdown();

        console.log("  connection loss / degraded: OK");
    }

    // --- invalid blockchain response ---

    {
        const { eventBus, monitor } = createMonitor();

        await monitor.start();

        assert.throws(
            () => monitor.registerContract(null, null),
            /registerContract requires/
        );

        monitor.shutdown();

        eventBus.shutdown();

        console.log("  invalid blockchain response: OK");
    }

    console.log("blockchainMonitor.test.js: all assertions passed");
}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
