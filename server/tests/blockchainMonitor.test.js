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
    isFailedTonTransaction,
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

    // --- R7.69B GameEscrow payment state + watch dedupe ---

    {
        const logger = createLogger();

        const eventBus = new EventBus({
            logger,
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const adapter = {
            async getPaidMask() {

                return 0b101;

            },
            async getTotalPaid() {

                return 30n;

            },
            async getRequiredTotal() {

                return 30n;

            },
            async getPlayerPayment(_address, index) {

                return {
                    index,
                    wallet: friendlyAddress(`seat-${index}`),
                    requiredStake: 10n,
                    paid: (0b101 & (1 << index)) !== 0
                };

            }
        };

        const monitor = new BlockchainMonitor({
            logger,
            eventBus,
            transport: new MockTonTransport(),
            contractAdapter: adapter,
            pollIntervalMs: 50_000
        });

        monitor.initialize();

        const state = await monitor.readGameEscrowPaymentState(
            friendlyAddress("escrow"),
            { playerCount: 3 }
        );

        assert.equal(state.paidMask, 0b101);

        assert.equal(state.totalPaid, 30n);

        assert.equal(state.players[0].paid, true);

        assert.equal(state.players[1].paid, false);

        assert.equal(state.players[2].paid, true);

        monitor.setContractAdapter(null);

        assert.equal(
            await monitor.readGameEscrowPaymentState(friendlyAddress("escrow")),
            null
        );

        monitor.setContractAdapter(adapter);

        const roomId = "room-dedupe";

        const stakeEvents = [];

        eventBus.subscribe(EVENT_TYPES.GAME_ESCROW_STAKE_CONFIRMED, (envelope) => {

            stakeEvents.push(envelope.payload);

        });

        monitor.watchPayment({
            roomId,
            gameId: "game-1",
            playerId: "p1",
            contractAddress: friendlyAddress("escrow"),
            paymentReference: "ref-1",
            expectedGram: 10,
            expectedWallet: friendlyAddress("seat-0"),
            playerIndex: 0
        });

        monitor.watchPayment({
            roomId,
            gameId: "game-1",
            playerId: "p1",
            contractAddress: friendlyAddress("escrow"),
            paymentReference: "ref-1",
            expectedGram: 10,
            expectedWallet: friendlyAddress("seat-0"),
            playerIndex: 0
        });

        assert.equal(
            monitor.exportCheckpoint().paymentWatches.length,
            1,
            "duplicate watchPayment must not create duplicate watchers"
        );

        assert.equal(stakeEvents.length, 0, "sync path must not emit stake confirmed");

        monitor.shutdown();

        eventBus.shutdown();

        console.log("  R7.69B GameEscrow getters + watch dedupe: OK");
    }

    // --- R7.69C GameEscrow cancel / refund observation ---

    {
        const logger = createLogger();

        const eventBus = new EventBus({
            logger,
            eventBusConfig: { logEvents: false, showDebugPanel: false }
        });

        eventBus.initialize();

        const playerWallet = friendlyAddress("refund-player-0");
        const escrow = friendlyAddress("refund-escrow");

        const adapter = {
            async getCancelStatus() {

                return {
                    cancelled: true,
                    cancelReason: 1,
                    refundMask: 0b001
                };

            },
            async getRefundMask() {

                return 0b001;

            },
            async getRefundedTotal() {

                return 10n;

            },
            async getPaidMask() {

                return 0b001;

            },
            async getPlayerPayment(_address, index) {

                return {
                    index,
                    wallet: index === 0 ? playerWallet : friendlyAddress(`seat-${index}`),
                    requiredStake: 10n,
                    paid: index === 0
                };

            }
        };

        const transport = new MockTonTransport();

        transport.seedTransactions(escrow, [
            {
                transaction_id: { hash: "cancel-tx-1" },
                out_msgs: [
                    {
                        destination: playerWallet,
                        value: String(10 * 1e9),
                        currency: "TON"
                    }
                ]
            }
        ]);

        const monitor = new BlockchainMonitor({
            logger,
            eventBus,
            transport,
            contractAdapter: adapter,
            pollIntervalMs: 50_000
        });

        monitor.initialize();

        await monitor.start();

        const cancelState = await monitor.readGameEscrowCancelState(escrow, {
            playerCount: 3
        });

        assert.equal(cancelState.cancelled, true);
        assert.equal(cancelState.refundMask, 0b001);
        assert.equal(cancelState.players[0].refunded, true);

        const refundEvents = [];

        eventBus.subscribe(EVENT_TYPES.GAME_ESCROW_REFUND_CONFIRMED, (envelope) => {

            refundEvents.push(envelope.payload);

        });

        const cancelEvents = [];

        eventBus.subscribe(EVENT_TYPES.GAME_ESCROW_CANCEL_CONFIRMED, (envelope) => {

            cancelEvents.push(envelope.payload);

        });

        const watch = monitor.watchGameEscrowRefunds({
            escrowAddress: escrow,
            cancelTxHash: "cancel-tx-1",
            refunds: [
                {
                    playerIndex: 0,
                    playerId: "p1",
                    wallet: playerWallet,
                    amount: 10
                }
            ],
            expectedRefundMask: 0b001,
            contractStatus: 9,
            roomId: "room-refund",
            gameId: "game-refund"
        });

        assert.equal(watch.status, "PENDING");

        // Duplicate register is idempotent.
        const again = monitor.watchGameEscrowRefunds({
            escrowAddress: escrow,
            cancelTxHash: "cancel-tx-1",
            refunds: [
                {
                    playerIndex: 0,
                    playerId: "p1",
                    wallet: playerWallet,
                    amount: 10
                }
            ],
            expectedRefundMask: 0b001,
            contractStatus: 9,
            roomId: "room-refund",
            gameId: "game-refund"
        });

        assert.equal(again.watchId, watch.watchId);

        await monitor._observeGameEscrowRefunds(
            monitor._gameEscrowRefunds.get(watch.watchId)
        );

        assert.equal(
            monitor._gameEscrowRefunds.get(watch.watchId).status,
            "CONFIRMED"
        );

        assert.equal(cancelEvents.length, 1);
        assert.equal(refundEvents.length, 1);
        assert.equal(refundEvents[0].playerIndex, 0);
        assert.equal(refundEvents[0].amount, 10);

        // No duplicate confirmation on re-observe.
        await monitor._observeGameEscrowRefunds(
            monitor._gameEscrowRefunds.get(watch.watchId)
        );

        assert.equal(refundEvents.length, 1);

        monitor.shutdown();
        eventBus.shutdown();

        console.log("  R7.69C GameEscrow refund confirm + dedupe: OK");
    }

    // --- R7.69D aborted tx + paidMask gate ---

    {
        assert.equal(
            isFailedTonTransaction({ aborted: true, in_msg: {} }),
            true
        );
        assert.equal(
            isFailedTonTransaction({ success: false, in_msg: {} }),
            true
        );
        assert.equal(
            isFailedTonTransaction({ description: "failed" }),
            true
        );
        assert.equal(isFailedTonTransaction({ in_msg: {} }), false);

        const { eventBus, monitor, audit } = createMonitor();

        await monitor.start();

        const confirmed = [];

        eventBus.subscribe(EVENT_TYPES.PAYMENT_BLOCKCHAIN_CONFIRMED, (envelope) => {

            confirmed.push(envelope.payload);

        });

        const contractAddress = friendlyAddress("r769d-escrow");
        const playerWallet = friendlyAddress("r769d-player");

        monitor.setContractAdapter({
            async getPaidMask() {

                return 0;

            }
        });

        monitor.watchPayment({
            roomId: "room-r769d",
            gameId: "game-r769d",
            playerId: "p1",
            contractAddress,
            paymentReference: "ref-r769d",
            expectedGram: 10,
            expectedWallet: playerWallet,
            playerIndex: 0
        });

        await monitor.ingestTransaction("room-r769d", {
            transaction_id: { hash: "tx_aborted" },
            aborted: true,
            in_msg: {
                source: playerWallet,
                destination: contractAddress,
                grmAmount: 10
            }
        });

        assert.equal(confirmed.length, 0, "aborted tx must not confirm");

        assert.ok(
            audit.list("room-r769d").some(
                (entry) => entry.reason === "aborted_or_failed_transaction"
            ),
            "aborted tx audited"
        );

        await monitor.ingestTransaction("room-r769d", {
            transaction_id: { hash: "tx_no_mask" },
            in_msg: {
                source: playerWallet,
                destination: contractAddress,
                grmAmount: 10
            }
        });

        assert.equal(confirmed.length, 0, "paidMask=0 must not confirm");

        assert.ok(
            audit.list("room-r769d").some(
                (entry) => entry.reason === "paid_mask_not_set"
            ),
            "missing paidMask audited"
        );

        monitor.setContractAdapter({
            async getPaidMask() {

                return 0b001;

            }
        });

        await monitor.ingestTransaction("room-r769d", {
            transaction_id: { hash: "tx_mask_ok" },
            in_msg: {
                source: playerWallet,
                destination: contractAddress,
                grmAmount: 10
            }
        });

        assert.equal(confirmed.length, 1, "paidMask bit confirms stake");

        monitor.shutdown();
        eventBus.shutdown();

        console.log("  R7.69D aborted + paidMask payment gate: OK");
    }

    // --- R7.70C13 paidMask gate confirms / rejects STAKE-shaped deposits ---

    {
        const { eventBus, monitor } = createMonitor();

        await monitor.start();

        const confirmed = [];

        const stakeConfirmed = [];

        const observationConfirmed = [];

        eventBus.subscribe(EVENT_TYPES.PAYMENT_BLOCKCHAIN_CONFIRMED, (envelope) => {

            confirmed.push(envelope.payload);

        });

        eventBus.subscribe(EVENT_TYPES.GAME_ESCROW_STAKE_CONFIRMED, (envelope) => {

            stakeConfirmed.push(envelope.payload);

        });

        eventBus.subscribe(EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED, (envelope) => {

            observationConfirmed.push(envelope.payload);

        });

        const contractAddress = friendlyAddress("r770c13-escrow");

        const playerWallet = friendlyAddress("r770c13-player");

        monitor.setContractAdapter({
            async getPaidMask() {

                return 0;

            }
        });

        monitor.watchPayment({
            roomId: "room-r770c13-neg",
            gameId: "game-r770c13-neg",
            playerId: "p0",
            contractAddress,
            paymentReference: "ref-r770c13-neg",
            expectedGram: 1,
            expectedWallet: playerWallet,
            playerIndex: 0
        });

        await monitor.ingestTransaction("room-r770c13-neg", {
            transaction_id: { hash: "tx_r770c13_mask0" },
            in_msg: {
                source: playerWallet,
                destination: contractAddress,
                value: "1000000000"
            }
        });

        assert.equal(confirmed.length, 0, "paidMask=0 must not confirm");

        assert.equal(stakeConfirmed.length, 0, "paidMask=0 must not emit stake confirmed");

        assert.equal(
            observationConfirmed.length,
            0,
            "paidMask=0 must not emit observation confirmed"
        );

        monitor.unwatchPayment("room-r770c13-neg", "p0");

        monitor.setContractAdapter({
            async getPaidMask() {

                return 1;

            }
        });

        monitor.watchPayment({
            roomId: "room-r770c13-ok",
            gameId: "game-r770c13-ok",
            playerId: "p0",
            contractAddress,
            paymentReference: "ref-r770c13-ok",
            expectedGram: 1,
            expectedWallet: playerWallet,
            playerIndex: 0
        });

        await monitor.ingestTransaction("room-r770c13-ok", {
            transaction_id: { hash: "tx_r770c13_mask1" },
            in_msg: {
                source: playerWallet,
                destination: contractAddress,
                value: "1000000000"
            }
        });

        assert.equal(confirmed.length, 1, "paidMask bit 0 set must confirm");

        assert.equal(stakeConfirmed.length, 1, "GAME_ESCROW_STAKE_CONFIRMED emitted");

        assert.equal(
            observationConfirmed.length,
            1,
            "PAYMENT_TRANSACTION_CONFIRMED emitted"
        );

        assert.equal(confirmed[0].playerId, "p0");

        assert.equal(stakeConfirmed[0].playerIndex, 0);

        monitor.shutdown();

        eventBus.shutdown();

        console.log("  R7.70C13 paidMask confirm + negative gate: OK");
    }

    console.log("blockchainMonitor.test.js: all assertions passed");
}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
