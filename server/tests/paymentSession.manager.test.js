/**
 * T2.7 — PaymentSessionManager lifecycle tests.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../models/PaymentSession.js";
import {
    DuplicatePaymentError,
    PaymentSessionAlreadyExistsError,
    PaymentSessionManager,
    PaymentValidationError
} from "../gameplay/PaymentSessionManager.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";

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

function createLogger() {

    return {
        info() {},
        error() {},
        warn() {},
        debug() {}
    };

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function createHarness({
    durationMs = 60_000,
    dataDir = null,
    withContract = false,
    withWalletManager = false
} = {}) {

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const wallet = friendlyAddress("player-wallet");

    const identities = new Map([
        ["p1", { baseStake: 10, sectorCount: 1 }],
        ["p2", { baseStake: 10, sectorCount: 2 }],
        ["p3", { baseStake: 10, sectorCount: 1 }]
    ]);

    const contractAddress = friendlyAddress("game-contract");

    const persistence = dataDir
        ? (() => {

            const store = new TonFinancialPersistence({ dataDir });

            store.initialize();

            return store;

        })()
        : null;

    const blockchainMonitor = {
        watches: [],
        watchPayment(payload) {

            this.watches.push(payload);

        },
        unwatchPayment() {},
        stopRoom() {

            this.watches = [];

        }
    };

    const gameContractManager = withContract
        ? {
            getContract(roomId) {

                if (roomId !== "room-1") {

                    return null;

                }

                return {
                    contractId: "contract-1",
                    roomId,
                    gameId: "game-1",
                    status: GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS,
                    contractAddress,
                    tonNetwork: "testnet",
                    gameStartedAt: null
                };

            },
            getContractById(contractId) {

                return contractId === "contract-1"
                    ? this.getContract("room-1")
                    : null;

            },
            markPaymentsCompleted(roomId) {

                this.lastCompletedRoom = roomId;

            },
            lastCompletedRoom: null
        }
        : null;

    const walletManager = withWalletManager
        ? {
            getWalletByPlayer(playerId, roomId) {

                if (roomId !== "room-1") {

                    return null;

                }

                return {
                    walletSessionId: `ws_${playerId}`,
                    playerId,
                    roomId,
                    walletAddress: wallet,
                    status: "VERIFIED",
                    network: "testnet"
                };

            }
        }
        : null;

    const manager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager: {
            getIdentity(playerId) {

                return identities.get(playerId) ?? null;

            }
        },
        roomManager: {
            getRoom(roomId) {

                if (roomId !== "room-1") {

                    return null;

                }

                return { players: ["p1", "p2", "p3"] };

            }
        },
        roomConfig: { paymentSessionDurationMs: durationMs },
        gameplayContextResolver: {
            resolveGameIdByRoomId(roomId) {

                return roomId === "room-1" ? "game-1" : null;

            }
        },
        sessionWalletStore: {
            getWallet() {

                return wallet;

            }
        },
        walletManager,
        gameContractManager,
        blockchainMonitor,
        financialPersistence: persistence,
        tonNetwork: "testnet",
        devMode: false
    });

    manager.initialize();

    return {
        eventBus,
        manager,
        blockchainMonitor,
        gameContractManager,
        persistence,
        wallet,
        contractAddress
    };

}

async function main() {

    // --- legacy lobby flow ---

    {
        const { eventBus, manager } = createHarness();

        const created = [];

        const requests = [];

        eventBus.subscribe(EVENT_TYPES.PAYMENT_SESSION_CREATED, (envelope) => {

            created.push(envelope.payload);

        });

        eventBus.subscribe(EVENT_TYPES.PAYMENT_REQUEST, (envelope) => {

            requests.push(envelope.payload);

        });

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PAYMENT_CONNECTION_READY,
            payload: { roomId: "room-1" }
        });

        assert.equal(created.length, 1);

        assert.equal(requests.length, 0);

        const session = manager.getSession("room-1");

        assert.ok(session);

        manager.issueDeployedPaymentRequests("room-1", {
            contractAddress: friendlyAddress("deployed"),
            paymentDeadline: Date.now() + 60_000
        });

        assert.equal(requests.length, 3);

        manager.submitPlayerConfirmation("room-1", "p1");

        manager.confirmBlockchainPayment("room-1", "p1", { txHash: "tx1" });

        assert.equal(
            session.findParticipant("p1").status,
            PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
        );

        manager.submitPlayerConfirmation("room-1", "p2");

        manager.confirmBlockchainPayment("room-1", "p2", { txHash: "tx2" });

        manager.submitPlayerConfirmation("room-1", "p3");

        manager.confirmBlockchainPayment("room-1", "p3", { txHash: "tx3" });

        assert.equal(session.status, PAYMENT_SESSION_STATUS.COMPLETED);

        manager.destroySession("room-1");

        manager.shutdown();

        eventBus.shutdown();

        console.log("  legacy lobby flow: OK");
    }

    // --- create payment session with contract + wallet validation ---

    {
        const { manager, blockchainMonitor } = createHarness({
            withContract: true,
            withWalletManager: true
        });

        const session = manager.createPaymentSession("room-1", {
            contractAddress: friendlyAddress("deployed")
        });

        assert.equal(session.status, PAYMENT_SESSION_STATUS.WAITING_FOR_PAYMENTS);

        assert.equal(session.contractId, "contract-1");

        assert.equal(blockchainMonitor.watches.length, 3);

        console.log("  create payment session: OK");
    }

    // --- duplicate creation ---

    {
        const { manager } = createHarness({ withContract: true, withWalletManager: true });

        manager.createPaymentSession("room-1");

        assert.throws(
            () => manager.createPaymentSession("room-1"),
            (error) => error instanceof PaymentSessionAlreadyExistsError
        );

        console.log("  duplicate creation: OK");
    }

    // --- partial + full payment via blockchain events ---

    {
        const { eventBus, manager } = createHarness({
            withContract: true,
            withWalletManager: true
        });

        const completed = [];

        eventBus.subscribe(EVENT_TYPES.PAYMENT_SESSION_COMPLETED, (envelope) => {

            completed.push(envelope.payload);

        });

        manager.createPaymentSession("room-1", {
            contractAddress: friendlyAddress("deployed")
        });

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED,
            payload: {
                roomId: "room-1",
                playerId: "p1",
                transactionId: "tx-p1",
                amountGram: 10,
                sender: friendlyAddress("player-wallet")
            }
        });

        const session = manager.getSession("room-1");

        assert.equal(session.status, PAYMENT_SESSION_STATUS.PARTIALLY_PAID);

        for (const playerId of ["p2", "p3"]) {

            eventBus.emit({
                source: "test",
                type: EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED,
                payload: {
                    roomId: "room-1",
                    playerId,
                    transactionId: `tx-${playerId}`,
                    amountGram: playerId === "p2" ? 25 : 10,
                    sender: friendlyAddress("player-wallet")
                }
            });

        }

        assert.equal(session.status, PAYMENT_SESSION_STATUS.COMPLETED);

        assert.equal(completed.length, 1);

        console.log("  partial + full payment via events: OK");
    }

    // --- wrong wallet rejection ---

    {
        const { eventBus, manager } = createHarness({
            withContract: true,
            withWalletManager: true
        });

        const rejected = [];

        eventBus.subscribe(EVENT_TYPES.PAYMENT_REJECTED, (envelope) => {

            rejected.push(envelope.payload);

        });

        manager.createPaymentSession("room-1", {
            contractAddress: friendlyAddress("deployed")
        });

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED,
            payload: {
                roomId: "room-1",
                playerId: "p1",
                transactionId: "tx-bad-wallet",
                amountGram: 10,
                sender: friendlyAddress("wrong-wallet")
            }
        });

        assert.equal(rejected.length, 1);

        assert.equal(
            manager.getSession("room-1").findParticipant("p1").status,
            PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
        );

        console.log("  wrong wallet rejection: OK");
    }

    // --- wrong amount rejection ---

    {
        const { eventBus, manager } = createHarness({
            withContract: true,
            withWalletManager: true
        });

        const rejected = [];

        eventBus.subscribe(EVENT_TYPES.PAYMENT_REJECTED, (envelope) => {

            rejected.push(envelope.payload);

        });

        manager.createPaymentSession("room-1", {
            contractAddress: friendlyAddress("deployed")
        });

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED,
            payload: {
                roomId: "room-1",
                playerId: "p1",
                transactionId: "tx-bad-amount",
                amountGram: 1,
                sender: friendlyAddress("player-wallet")
            }
        });

        assert.equal(rejected.length, 1);

        console.log("  wrong amount rejection: OK");
    }

    // --- duplicate payment ---

    {
        const { manager } = createHarness({
            withContract: true,
            withWalletManager: true
        });

        manager.createPaymentSession("room-1", {
            contractAddress: friendlyAddress("deployed")
        });

        manager.confirmBlockchainPayment("room-1", "p1", { txHash: "tx-dup" });

        assert.throws(
            () => manager.confirmBlockchainPayment("room-1", "p1", { txHash: "tx-dup" }),
            (error) => error instanceof DuplicatePaymentError
        );

        console.log("  duplicate payment: OK");
    }

    // --- timeout ---

    {
        const { eventBus, manager } = createHarness({
            durationMs: 20,
            withContract: true,
            withWalletManager: true
        });

        const timedOut = [];

        eventBus.subscribe(EVENT_TYPES.PAYMENT_TIMEOUT, (envelope) => {

            timedOut.push(envelope.payload);

        });

        manager.createPaymentSession("room-1", {
            contractAddress: friendlyAddress("deployed")
        });

        await wait(40);

        assert.equal(timedOut.length, 1);

        assert.equal(
            manager.getSession("room-1").status,
            PAYMENT_SESSION_STATUS.PAYMENT_TIMEOUT
        );

        console.log("  timeout: OK");
    }

    // --- persistence + restore ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-payment-"));

        const first = createHarness({
            dataDir,
            withContract: true,
            withWalletManager: true
        });

        const session = first.manager.createPaymentSession("room-1", {
            contractAddress: friendlyAddress("deployed")
        });

        first.manager.confirmBlockchainPayment("room-1", "p1", { txHash: "tx-restore" });

        first.persistence.shutdown();

        const second = createHarness({
            dataDir,
            withContract: true,
            withWalletManager: true
        });

        const summary = second.manager.restorePaymentSessions();

        assert.equal(summary.restored, 1);

        const restored = second.manager.getSession("room-1");

        assert.equal(restored.paymentSessionId, session.paymentSessionId);

        assert.equal(restored.confirmedCount(), 1);

        assert.ok(second.blockchainMonitor.watches.length >= 2);

        TonFinancialPersistence.destroyStorage(dataDir);

        console.log("  persistence + restore: OK");
    }

    // --- GameContractManager notification via completion event ---

    {
        const { eventBus, manager, gameContractManager } = createHarness({
            withContract: true,
            withWalletManager: true
        });

        eventBus.subscribe(EVENT_TYPES.PAYMENT_SESSION_COMPLETED, (envelope) => {

            gameContractManager.markPaymentsCompleted(envelope.payload.roomId);

        });

        manager.createPaymentSession("room-1", {
            contractAddress: friendlyAddress("deployed")
        });

        for (const playerId of ["p1", "p2", "p3"]) {

            manager.confirmBlockchainPayment(
                "room-1",
                playerId,
                { txHash: `tx-${playerId}-notify` }
            );

        }

        assert.equal(gameContractManager.lastCompletedRoom, "room-1");

        console.log("  GameContractManager notification: OK");
    }

    // --- health + dashboard ---

    {
        const { manager } = createHarness({
            withContract: true,
            withWalletManager: true
        });

        manager.createPaymentSession("room-1", {
            contractAddress: friendlyAddress("deployed")
        });

        const health = manager.health();

        assert.equal(health.activeSessions, 1);

        assert.equal(health.pendingPayments, 3);

        const dashboard = manager.getDashboardSnapshot("room-1");

        assert.equal(dashboard.sessions.length, 1);

        assert.equal(dashboard.sessions[0].participantCount, 3);

        console.log("  health + dashboard: OK");
    }

    // --- wallet validation without wallet manager falls back to store ---

    {
        const { manager } = createHarness({ withContract: true });

        const session = manager.createPaymentSession("room-1");

        assert.ok(session);

        console.log("  wallet store fallback: OK");
    }

    // --- strict wallet validation failure ---

    {
        const { manager } = createHarness({
            withContract: true,
            withWalletManager: true
        });

        manager._walletManager = {
            getWalletByPlayer() {

                return {
                    walletSessionId: "ws-unverified",
                    walletAddress: friendlyAddress("player-wallet"),
                    status: "CONNECTED"
                };

            }
        };

        assert.throws(
            () => manager.createPaymentSession("room-1"),
            (error) => error instanceof PaymentValidationError
        );

        console.log("  wallet validation failure: OK");
    }

    console.log("paymentSession.manager.test.js: all assertions passed");

}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
