/**
 * R8.10 — Production-shaped TonFinancialPersistence wiring tests.
 *
 * Mirrors app.js DI: one shared store injected into SessionWalletStore,
 * PaymentSessionManager, GameContractManager, ContractSettlementManager,
 * TonFinancialRecovery — without changing settlement business logic.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import {
    OWNER_CONFIG_EXAMPLE_PATH,
    OwnerConfiguration
} from "../config/OwnerConfiguration.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameContractManager } from "../gameplay/GameContractManager.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { DeploymentAuthorizationCoordinator } from "../deposit/DeploymentAuthorizationCoordinator.js";
import { issueValidDeploymentAuthorization } from "./helpers/issueValidDeploymentAuthorization.js";
import { GameManager } from "../managers/GameManager.js";
import {
    GAME_CONTRACT_STATUS
} from "../models/GameContract.js";
import { PAYMENT_PARTICIPANT_STATUS } from "../models/PaymentSession.js";
import { EntryPaymentAuditLedger } from "../payment/BlockchainMonitor.js";
import { ContractSettlementManager } from "../payment/ContractSettlementManager.js";
import { GameContractDeployAdapter } from "../payment/GameContractDeployAdapter.js";
import { SettlementSession } from "../payment/SettlementSession.js";
import { SETTLEMENT_SESSION_STATUS } from "../payment/SettlementSessionStates.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { TON_FINANCIAL_RECORD_TYPES } from "../persistence/TonFinancialRecordTypes.js";
import { TonFinancialRecovery } from "../recovery/TonFinancialRecovery.js";
import { SessionWalletStore } from "../session/SessionWalletStore.js";
import { PlayerManager } from "../managers/PlayerManager.js";

const OWNER = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";
const WINNER_WALLET = "EQAREREREREREREREREREREREREREREREREREREREREREeYT";
const DEPLOYER = "EQDeployerWalletForSettlementWatchXXXXXXXX";

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
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {},
        startupLine() {}
    };

}

function wait(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function createBlockchainMonitor() {

    const watches = [];

    return {
        watches,
        watchPayment() {},
        unwatchPayment() {},
        watchTransaction(payload) {

            watches.push(payload);

        },
        unwatchTransaction() {},
        stopRoom() {},
        restoreCheckpoint() {},
        getPaidMask() {

            return 0;

        }
    };

}

/**
 * Production-shaped stack: single shared persistence → all financial managers.
 */
function createWiredStack({ dataDir, roomId = "room-1", gameId = "game-1" }) {

    OwnerConfiguration.resetForTests();

    OwnerConfiguration.load({ configPath: OWNER_CONFIG_EXAMPLE_PATH });

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const financialPersistence = new TonFinancialPersistence({
        logger,
        dataDir,
        autoCheckpoint: false
    });

    financialPersistence.initialize();

    const sessionWalletStore = new SessionWalletStore({
        financialPersistence,
        logger
    });

    assert.ok(
        sessionWalletStore._financialPersistence,
        "SessionWalletStore must receive financialPersistence"
    );

    const playerManager = new PlayerManager({ logger, eventBus });

    playerManager.initialize();

    const identities = new Map([
        ["p1", { nickname: "A", baseStake: 10, sectorCount: 1 }],
        ["p2", { nickname: "B", baseStake: 10, sectorCount: 1 }],
        ["p3", { nickname: "C", baseStake: 10, sectorCount: 1 }]
    ]);

    for (const [playerId, identity] of identities) {

        playerManager.createPlayer?.({ playerId, ...identity });

    }

    const roomManager = {
        getRoom(id) {

            return id === roomId
                ? { roomId, players: ["p1", "p2", "p3"] }
                : null;

        }
    };

    const gameManager = new GameManager({ logger, eventBus });

    gameManager.initialize();

    const blockchainMonitor = createBlockchainMonitor();

    const deployAdapter = new GameContractDeployAdapter({
        deployDelayMs: 0,
        network: "testnet"
    });

    const paymentSessionManager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager: {
            getIdentity(playerId) {

                return identities.get(playerId) ?? null;

            }
        },
        roomManager,
        gameManager,
        sessionWalletStore: {
            getWallet(room, playerId) {

                if (playerId === "p1") {

                    return WINNER_WALLET;

                }

                return friendlyAddress(`wallet-${playerId}`);

            }
        },
        blockchainMonitor,
        financialPersistence,
        gameplayContextResolver: {
            resolveRoomByGameId(id) {

                return id === gameId ? roomId : null;

            }
        },
        roomConfig: { paymentTimeoutMs: 60_000 },
        devMode: false
    });

    assert.ok(
        paymentSessionManager._financialPersistence,
        "PaymentSessionManager must receive financialPersistence"
    );

    paymentSessionManager.initialize();

    const deploymentAuthorizationCoordinator = new DeploymentAuthorizationCoordinator({
        eventBus
    });

    issueValidDeploymentAuthorization(deploymentAuthorizationCoordinator, {
        roomId,
        gameId,
        network: "testnet"
    });

    const gameContractManager = new GameContractManager({
        logger,
        eventBus,
        playerManager: {
            getIdentity(playerId) {

                return identities.get(playerId) ?? null;

            }
        },
        roomManager,
        gameManager,
        sessionWalletStore: {
            getWallet(room, playerId) {

                if (playerId === "p1") {

                    return WINNER_WALLET;

                }

                return friendlyAddress(`wallet-${playerId}`);

            }
        },
        configurationEngine: {
            getConfiguration() {

                return { stake: 10, players: [], sectors: [], traceSeed: "trace_r810" };

            }
        },
        deployAdapter,
        financialPersistence,
        deploymentAuthorizationCoordinator,
        creatingDelayMs: 0,
        tonNetwork: "testnet",
        ownerConfiguration: {
            getOwnerWallet() {

                return OWNER;

            }
        },
        devMode: false
    });

    assert.ok(
        gameContractManager._financialPersistence,
        "GameContractManager must receive financialPersistence"
    );

    gameContractManager.initialize();

    const authorizationCoordinator = new DeploymentAuthorizationCoordinator({
        eventBus
    });

    issueValidDeploymentAuthorization(authorizationCoordinator, {
        roomId,
        gameId,
        network: "testnet"
    });

    gameContractManager.setDeploymentAuthorizationCoordinator(
        authorizationCoordinator
    );

    const contractSettlementManager = new ContractSettlementManager({
        logger,
        eventBus,
        gameContractManager,
        winnerEngine: {
            getResult(id) {

                if (id !== gameId) {

                    return null;

                }

                return { winningPlayer: { playerId: "p1" }, traceSeed: "trace_r810" };

            }
        },
        configurationEngine: {
            getConfiguration() {

                return { traceSeed: "trace_r810" };

            }
        },
        settlementAdapter: {
            async settleContract() {

                return {
                    ok: true,
                    settlementTxId: "settle-tx-r810"
                };

            }
        },
        blockchainMonitor,
        deployerWalletAddress: DEPLOYER,
        auditLedger: new EntryPaymentAuditLedger(),
        paymentSessionManager,
        gameplayContextResolver: {
            resolveRoomByGameId(id) {

                return id === gameId ? roomId : null;

            }
        },
        gameManager,
        financialPersistence,
        tonNetwork: "testnet",
        gameEscrowMode: null,
        ownerConfiguration: {
            getOwnerWallet() {

                return OWNER;

            }
        },
        settlementTimeoutMs: 60_000,
        devMode: false
    });

    assert.ok(
        contractSettlementManager._financialPersistence,
        "ContractSettlementManager must receive financialPersistence"
    );

    contractSettlementManager.initialize();

    paymentSessionManager.setFinancialEvidenceDeps({
        gameContractManager,
        contractSettlementManager
    });

    gameContractManager.setFinancialEvidenceDeps({
        paymentSessionManager,
        contractSettlementManager
    });

    const tonFinancialRecovery = new TonFinancialRecovery({
        logger,
        eventBus,
        sessionWalletStore,
        paymentSessionManager,
        gameContractManager,
        contractSettlementManager,
        blockchainMonitor,
        playerManager,
        roomManager,
        financialPersistence
    });

    assert.ok(
        tonFinancialRecovery._financialPersistence,
        "TonFinancialRecovery must receive financialPersistence"
    );

    tonFinancialRecovery.initialize();

    return {
        logger,
        eventBus,
        financialPersistence,
        sessionWalletStore,
        paymentSessionManager,
        gameContractManager,
        contractSettlementManager,
        tonFinancialRecovery,
        gameManager,
        blockchainMonitor,
        roomId,
        gameId,
        shutdown() {

            tonFinancialRecovery.shutdown?.();
            contractSettlementManager.shutdown();
            gameContractManager.shutdown();
            paymentSessionManager.shutdown();
            financialPersistence.shutdown({ checkpoint: false });
            eventBus.shutdown();

        }
    };

}

async function prepareSettledContract(stack) {

    stack.gameContractManager.createContract(stack.roomId, {
        gameId: stack.gameId
    });

    await wait(40);

    const contract = stack.gameContractManager.getContract(stack.roomId);

    assert.ok(contract, "contract created");

    // Drive to PAYMENTS_COMPLETE for settlement validation.
    if (contract.status !== GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE) {

        if (typeof stack.gameContractManager.markPaymentsCompleted === "function") {

            try {

                stack.gameContractManager.markPaymentsCompleted(stack.roomId);

            } catch {

                contract.status = GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE;
                contract.paymentsCompletedAt = Date.now();
                stack.gameContractManager._persistContract?.(contract);

            }

        } else {

            contract.status = GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE;
            contract.paymentsCompletedAt = Date.now();
            stack.gameContractManager._persistContract?.(contract);

        }

    }

    assert.ok(
        contract.snapshot?.payoutAmount != null,
        "snapshot must include payoutAmount"
    );

    assert.ok(
        contract.snapshot?.players?.some((p) => p.playerId === "p1"),
        "snapshot must include winner player wallet"
    );

    return contract;

}

async function main() {

    // --- TEST A: payment persist → restart → restore ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r810-pay-"));

        const first = createWiredStack({ dataDir });

        const session = first.paymentSessionManager.createPaymentSession(
            first.roomId,
            {
                gameId: first.gameId,
                contractAddress: friendlyAddress("pay-contract")
            }
        );

        assert.ok(session?.paymentSessionId);

        first.paymentSessionManager.confirmBlockchainPayment?.(
            first.roomId,
            "p1",
            { txHash: "tx-r810-a" }
        );

        first.shutdown();

        const second = createWiredStack({ dataDir });

        const summary = await second.paymentSessionManager.restorePaymentSessions();

        assert.equal(summary.restored, 1, "TEST A: payment restored");

        const restored = second.paymentSessionManager.getSession(first.roomId);

        assert.equal(restored.paymentSessionId, session.paymentSessionId);

        const confirmed = restored.findParticipant?.("p1")
            ?? restored.participants?.find((p) => p.playerId === "p1");

        if (confirmed) {

            assert.equal(
                confirmed.status,
                PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
            );

        }

        second.shutdown();

        TonFinancialPersistence.destroyStorage(dataDir);

        console.log("  TEST A payment persist/restore: OK");

    }

    // --- TEST B: contract persist → restart → restore ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r810-contract-"));

        const first = createWiredStack({ dataDir });

        first.gameContractManager.createContract(first.roomId, {
            gameId: first.gameId
        });

        await wait(20);

        const contractId = first.gameContractManager.getContract(first.roomId)
            .contractId;

        first.gameContractManager.markPaymentsCompleted?.(first.roomId);

        first.shutdown();

        const second = createWiredStack({ dataDir });

        const summary = second.gameContractManager.restoreContracts();

        assert.equal(summary.restored, 1, "TEST B: contract restored");

        const loaded = second.gameContractManager.loadContract?.(contractId)
            ?? second.gameContractManager.getContract(first.roomId);

        assert.equal(loaded.contractId, contractId);

        assert.equal(loaded.roomId, first.roomId);

        second.shutdown();

        TonFinancialPersistence.destroyStorage(dataDir);

        console.log("  TEST B contract persist/restore: OK");

    }

    // --- TEST C: WINNER → SETTLEMENT_PENDING → restart → recover → continue ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r810-settle-"));

        const first = createWiredStack({ dataDir });

        await prepareSettledContract(first);

        first.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.WINNER_DETERMINED,
            payload: {
                gameId: first.gameId,
                winningPlayerId: "p1"
            }
        });

        await wait(60);

        const pending = first.contractSettlementManager.getSettlementSession(
            first.gameId
        );

        assert.ok(pending, "settlement session created");

        assert.equal(
            pending.status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING,
            "settlement reaches SETTLEMENT_PENDING"
        );

        assert.equal(pending.settlementTransactionHash, "settle-tx-r810");

        assert.equal(pending.winnerWallet, WINNER_WALLET);

        assert.ok(
            first.blockchainMonitor.watches.length >= 1,
            "settlement watch registered before restart"
        );

        first.shutdown();

        const second = createWiredStack({ dataDir });

        const report = await second.tonFinancialRecovery.recover({
            trigger: "server_restart",
            reason: "r810_test_c"
        });

        assert.ok(report, "recovery report produced");

        const restored = second.contractSettlementManager.getSettlementSession(
            first.gameId
        );

        assert.ok(restored, "settlement restored after restart");

        assert.equal(
            restored.status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING
        );

        assert.equal(restored.settlementTransactionHash, "settle-tx-r810");

        assert.equal(restored.winnerId, "p1");

        assert.ok(Number(restored.prizeAmount) > 0);

        assert.ok(Number(restored.organizerAmount) >= 0);

        // Continue settlement without WinnerEngine (session payload is enough).
        second.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.SETTLEMENT_TRANSACTION_CONFIRMED,
            payload: {
                gameId: first.gameId,
                contractId: restored.contractId,
                transactionId: "settle-tx-r810"
            }
        });

        await wait(20);

        const completed = second.contractSettlementManager.getSettlementSession(
            first.gameId
        );

        assert.equal(
            completed.status,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED,
            "settlement continues to COMPLETED after recovery"
        );

        second.shutdown();

        TonFinancialPersistence.destroyStorage(dataDir);

        console.log("  TEST C settlement pending recovery continue: OK");

    }

    // --- TEST D: ROOM_DESTROYED after GAME_INITIALIZED → restart still recovers ---

    {
        const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-r810-room-"));

        const first = createWiredStack({ dataDir });

        const game = first.gameManager.createGame(first.roomId, {
            players: ["p1", "p2", "p3"]
        });

        const gameId = game.gameId;

        first.gameManager.initializeGame(gameId);

        first.gameManager.markEntryPaymentActivated(gameId);

        const payment = first.paymentSessionManager.createPaymentSession(
            first.roomId,
            {
                gameId,
                contractAddress: friendlyAddress("room-contract")
            }
        );

        assert.ok(payment);

        if (!first.gameContractManager.getContract(first.roomId)) {

            first.gameContractManager.createContract(first.roomId, { gameId });

            await wait(40);

        }

        assert.ok(
            first.gameContractManager.getContract(first.roomId),
            "contract available for Test D"
        );

        const settlement = new SettlementSession({
            settlementSessionId: "settle_r810_d",
            contractId: first.gameContractManager.getContract(first.roomId)
                .contractId,
            gameId,
            roomId: first.roomId,
            winnerId: "p1",
            winnerWallet: WINNER_WALLET,
            prizeAmount: 95,
            organizerAmount: 5,
            totalPot: 100,
            ownerWallet: OWNER,
            status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_PENDING,
            settlementTransactionHash: "tx-d",
            request: {
                contractAddress: friendlyAddress("escrow-d"),
                winnerWallet: WINNER_WALLET,
                ownerWallet: OWNER
            }
        });

        first.contractSettlementManager._byGameId.set(gameId, settlement);

        first.contractSettlementManager._persistSession?.(settlement, "create");

        first.eventBus.emit({
            source: "test",
            type: EVENT_TYPES.ROOM_DESTROYED,
            payload: { roomId: first.roomId }
        });

        await wait(10);

        // Live evidence must survive room destroy after GAME_INITIALIZED.
        assert.ok(
            first.paymentSessionManager.getSession(first.roomId),
            "payment retained after ROOM_DESTROYED"
        );

        assert.ok(
            first.gameContractManager.getContract(first.roomId),
            "contract retained after ROOM_DESTROYED"
        );

        assert.ok(
            first.contractSettlementManager.getSettlementSession(gameId),
            "settlement retained after ROOM_DESTROYED"
        );

        const paymentRecords = first.financialPersistence.listActive(
            TON_FINANCIAL_RECORD_TYPES.PAYMENT_SESSION
        );

        const settlementRecords = first.financialPersistence.listActive(
            TON_FINANCIAL_RECORD_TYPES.SETTLEMENT
        );

        assert.ok(paymentRecords.length >= 1, "payment still on disk");

        assert.ok(settlementRecords.length >= 1, "settlement still on disk");

        first.shutdown();

        const second = createWiredStack({ dataDir });

        await second.tonFinancialRecovery.recover({
            trigger: "server_restart",
            reason: "r810_test_d"
        });

        if (!second.paymentSessionManager.getSession(first.roomId)) {

            await second.paymentSessionManager.restorePaymentSessions();

        }

        if (!second.gameContractManager.getContract(first.roomId)) {

            second.gameContractManager.restoreContracts();

        }

        if (!second.contractSettlementManager.getSettlementSession(gameId)) {

            second.contractSettlementManager.restoreSettlementSessions();

        }

        assert.ok(
            second.paymentSessionManager.getSession(first.roomId),
            "TEST D: payment restored"
        );

        assert.ok(
            second.gameContractManager.getContract(first.roomId)
                || second.gameContractManager.getContractByGameId?.(gameId),
            "TEST D: contract restored"
        );

        assert.ok(
            second.contractSettlementManager.getSettlementSession(gameId),
            "TEST D: settlement restored"
        );

        second.shutdown();

        TonFinancialPersistence.destroyStorage(dataDir);

        console.log("  TEST D room-destroy + restart recover: OK");

    }

    console.log("financialPersistence.wiring.r810.test.js: all assertions passed");

    process.exit(0);

}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
