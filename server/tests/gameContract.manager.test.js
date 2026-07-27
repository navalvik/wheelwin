/**
 * T2.4 — GameContractManager lifecycle tests.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    OWNER_CONFIG_EXAMPLE_PATH,
    OwnerConfiguration
} from "../config/OwnerConfiguration.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    ContractAlreadyExistsError,
    ContractNotFoundError,
    GameContractManager,
    InvalidContractStateTransitionError
} from "../gameplay/GameContractManager.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";
import { GameContractDeployAdapter } from "../payment/GameContractDeployAdapter.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";

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
    shouldFail = false,
    financialPersistence = null,
    tonNetwork = "testnet"
} = {}) {

    OwnerConfiguration.resetForTests();

    OwnerConfiguration.load({ configPath: OWNER_CONFIG_EXAMPLE_PATH });

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const identities = new Map([
        ["p1", { nickname: "A", baseStake: 10, sectorCount: 1 }],
        ["p2", { nickname: "B", baseStake: 10, sectorCount: 1 }],
        ["p3", { nickname: "C", baseStake: 10, sectorCount: 1 }]
    ]);

    const manager = new GameContractManager({
        logger,
        eventBus,
        playerManager: {
            getIdentity(playerId) {

                return identities.get(playerId) ?? null;

            }
        },
        roomManager: {
            getRoom(roomId) {

                return roomId === "room-1"
                    ? { players: ["p1", "p2", "p3"] }
                    : null;

            }
        },
        sessionWalletStore: {
            getWallet() {

                return "EQwallet";

            }
        },
        configurationEngine: {
            getConfiguration() {

                return { stake: 10, players: [], sectors: [] };

            }
        },
        deployAdapter: new GameContractDeployAdapter({
            deployDelayMs: 0,
            shouldFail
        }),
        financialPersistence,
        tonNetwork,
        creatingDelayMs: 0,
        devMode: false
    });

    manager.initialize();

    return { eventBus, manager };

}

function emitPaymentRequested(eventBus) {

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_SESSION_UPDATED,
        payload: {
            roomId: "room-1",
            gameId: "game-1",
            participants: [
                { playerId: "p1", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED },
                { playerId: "p2", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED },
                { playerId: "p3", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED }
            ]
        }
    });

}

async function main() {

    // --- existing payment-driven create + deploy + payments complete ---

    {
        const { eventBus, manager } = createHarness();

        const updates = [];

        const readyForPayments = [];

        const domainCreated = [];

        eventBus.subscribe(EVENT_TYPES.GAME_CONTRACT_UPDATED, (envelope) => {

            updates.push(envelope.payload);

        });

        eventBus.subscribe(EVENT_TYPES.GAME_CONTRACT_READY_FOR_PAYMENTS, (envelope) => {

            readyForPayments.push(envelope.payload);

        });

        eventBus.subscribe(EVENT_TYPES.CONTRACT_CREATED, (envelope) => {

            domainCreated.push(envelope.payload);

        });

        emitPaymentRequested(eventBus);

        await wait(10);

        const contract = manager.getContract("room-1");

        assert.ok(contract);

        assert.equal(
            contract.status,
            GAME_CONTRACT_STATUS.AWAITING_PLAYER_PAYMENTS
        );

        assert.ok(contract.contractAddress);

        assert.equal(contract.tonNetwork, "testnet");

        assert.ok(contract.snapshotHash);

        assert.ok(contract.correlationId);

        assert.equal(readyForPayments.length, 1);

        assert.equal(domainCreated.length, 1);

        assert.ok(
            updates.every((update) => update.snapshot === undefined),
            "clients never receive snapshot body"
        );

        eventBus.emit({
            source: "test",
            type: EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
            payload: { roomId: "room-1", gameId: "game-1" }
        });

        assert.equal(
            contract.status,
            GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE
        );

        manager.shutdown();

        eventBus.shutdown();

        console.log("  payment-driven create + deploy: OK");
    }

    // --- deployment failure ---

    {
        const { eventBus, manager } = createHarness({ shouldFail: true });

        const failed = [];

        const domainFailed = [];

        eventBus.subscribe(EVENT_TYPES.GAME_CONTRACT_DEPLOY_FAILED, (envelope) => {

            failed.push(envelope.payload);

        });

        eventBus.subscribe(EVENT_TYPES.CONTRACT_FAILED, (envelope) => {

            domainFailed.push(envelope.payload);

        });

        emitPaymentRequested(eventBus);

        await wait(10);

        assert.equal(failed.length, 1);

        assert.equal(domainFailed.length, 1);

        assert.equal(
            manager.getContract("room-1").status,
            GAME_CONTRACT_STATUS.DEPLOY_FAILED
        );

        manager.shutdown();

        eventBus.shutdown();

        console.log("  deployment failure: OK");
    }

    // --- createContract + duplicate rejection ---

    {
        const { eventBus, manager } = createHarness();

        const contract = manager.createContract("room-1", { gameId: "game-1" });

        assert.ok(contract);

        await wait(10);

        assert.throws(
            () => manager.createContract("room-1", { gameId: "game-1" }),
            ContractAlreadyExistsError
        );

        manager.shutdown();

        eventBus.shutdown();

        console.log("  duplicate creation rejection: OK");
    }

    // --- invalid state transitions ---

    {
        const { eventBus, manager } = createHarness();

        manager.createContract("room-1", { gameId: "game-1" });

        await wait(10);

        assert.throws(
            () => manager.updateContractState(
                "room-1",
                GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED
            ),
            InvalidContractStateTransitionError
        );

        assert.equal(manager.getContract("missing"), null);

        assert.throws(
            () => manager.markGameStarted("missing-room"),
            ContractNotFoundError
        );

        manager.shutdown();

        eventBus.shutdown();

        console.log("  invalid transitions: OK");
    }

    // --- markGameStarted / winner / settlement / complete / archive ---

    {
        const { eventBus, manager } = createHarness();

        const archivedEvents = [];

        eventBus.subscribe(EVENT_TYPES.CONTRACT_ARCHIVED, (envelope) => {

            archivedEvents.push(envelope.payload);

        });

        manager.createContract("room-1", { gameId: "game-1" });

        await wait(10);

        manager.markPaymentsCompleted("room-1");

        const started = manager.markGameStarted("room-1");

        assert.ok(started.gameStartedAt);

        manager.markWinnerPending("room-1");

        assert.equal(
            manager.getContract("room-1").status,
            GAME_CONTRACT_STATUS.SETTLEMENT_PREPARING
        );

        manager.markSettlementPending("room-1");

        assert.equal(
            manager.getContract("room-1").status,
            GAME_CONTRACT_STATUS.SETTLEMENT_PENDING
        );

        manager.updateContractState(
            "room-1",
            GAME_CONTRACT_STATUS.SETTLEMENT_CONFIRMED
        );

        manager.completeContract("room-1");

        assert.equal(
            manager.getContract("room-1").status,
            GAME_CONTRACT_STATUS.SETTLEMENT_COMPLETED
        );

        await manager.archiveContract("room-1");

        assert.equal(
            manager.getContract("room-1").status,
            GAME_CONTRACT_STATUS.ARCHIVED
        );

        assert.equal(archivedEvents.length, 1);

        await manager.archiveContract("room-1");

        assert.equal(archivedEvents.length, 1, "repeated archive is idempotent");

        manager.shutdown();

        eventBus.shutdown();

        console.log("  lifecycle to archive: OK");
    }

    // --- persistence write + restore after restart ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-gcm-"));

        const persistence = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence.initialize();

        const { eventBus, manager } = createHarness({
            financialPersistence: persistence,
            tonNetwork: "testnet"
        });

        manager.createContract("room-1", { gameId: "game-1" });

        await wait(10);

        const contractId = manager.getContract("room-1").contractId;

        manager.markPaymentsCompleted("room-1");

        manager.shutdown();

        eventBus.shutdown();

        const persistence2 = new TonFinancialPersistence({
            dataDir,
            autoCheckpoint: false
        });

        persistence2.initialize();

        const harness2 = createHarness({
            financialPersistence: persistence2,
            tonNetwork: "testnet"
        });

        const restored = harness2.manager.restoreContracts();

        assert.equal(restored.restored, 1);

        const loaded = harness2.manager.loadContract(contractId);

        assert.equal(loaded.contractId, contractId);

        assert.equal(loaded.status, GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE);

        assert.equal(loaded.roomId, "room-1");

        assert.equal(loaded.tonNetwork, "testnet");

        harness2.manager.shutdown();

        harness2.eventBus.shutdown();

        persistence2.shutdown({ checkpoint: false });

        TonFinancialPersistence.destroyStorage(dataDir);

        console.log("  persistence + restore: OK");
    }

    // --- failure handling ---

    {
        const { eventBus, manager } = createHarness();

        manager.createContract("room-1", { gameId: "game-1" });

        await wait(10);

        manager.markPaymentsCompleted("room-1");

        manager.markWinnerPending("room-1");

        await manager.failContract("room-1", "settlement_abort");

        assert.equal(
            manager.getContract("room-1").status,
            GAME_CONTRACT_STATUS.SETTLEMENT_FAILED
        );

        assert.equal(
            manager.getContract("room-1").failureReason,
            "settlement_abort"
        );

        manager.shutdown();

        eventBus.shutdown();

        console.log("  failure handling: OK");
    }

    // --- concurrent deploy lock ---

    {
        const { eventBus, manager } = createHarness();

        const slowAdapter = {
            async deploy() {

                await wait(40);

                return {
                    ok: true,
                    contractAddress: "EQslow",
                    deploymentTxId: "tx-slow",
                    deployedAt: Date.now()
                };

            }
        };

        manager._deployAdapter = slowAdapter;

        const contract = manager.createContractRequest("room-1", {
            gameId: "game-1"
        });

        // Force back to READY_FOR_BLOCKCHAIN for explicit redeploy race.
        contract.status = GAME_CONTRACT_STATUS.READY_FOR_BLOCKCHAIN;

        const first = manager.deployContract("room-1");

        await assert.rejects(
            () => manager.deployContract("room-1"),
            (error) => error.code === "CONTRACT_OPERATION_IN_PROGRESS"
        );

        await first;

        manager.shutdown();

        eventBus.shutdown();

        console.log("  concurrent operations: OK");
    }

    // --- dashboard snapshot ---

    {
        const { eventBus, manager } = createHarness();

        manager.createContract("room-1", { gameId: "game-1" });

        await wait(10);

        const dash = manager.getDashboardSnapshot("room-1");

        assert.equal(dash.gameId, "game-1");

        assert.ok(dash.address);

        assert.equal(dash.network, "testnet");

        assert.ok(dash.state);

        manager.shutdown();

        eventBus.shutdown();

        console.log("  dashboard snapshot: OK");
    }

    // --- event emission payload shape ---

    {
        const { eventBus, manager } = createHarness();

        const events = [];

        for (const type of [
            EVENT_TYPES.CONTRACT_CREATED,
            EVENT_TYPES.CONTRACT_DEPLOYING,
            EVENT_TYPES.CONTRACT_DEPLOYED,
            EVENT_TYPES.CONTRACT_STATE_CHANGED
        ]) {

            eventBus.subscribe(type, (envelope) => {

                events.push(envelope);

            });

        }

        manager.createContract("room-1", { gameId: "game-1" });

        await wait(10);

        assert.ok(events.some((entry) => entry.type === EVENT_TYPES.CONTRACT_CREATED));

        assert.ok(events.some((entry) => entry.type === EVENT_TYPES.CONTRACT_DEPLOYED));

        for (const entry of events) {

            assert.ok(entry.payload.contractId);

            assert.ok(entry.payload.gameId);

            assert.ok(entry.payload.roomId);

            assert.ok(entry.payload.state);

            assert.ok(entry.payload.timestamp);

            assert.ok(entry.payload.correlationId);

        }

        manager.shutdown();

        eventBus.shutdown();

        console.log("  event emission: OK");
    }

    console.log("gameContract.manager.test.js: all assertions passed");
}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
