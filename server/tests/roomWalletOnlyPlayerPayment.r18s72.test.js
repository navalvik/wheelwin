/**
 * R18-S72 — Room Wallet is the sole player-payment and settlement path
 * for GAME_ESCROW_MODE=game. Deterministic mocks only. No chain sends.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameContractManager } from "../gameplay/GameContractManager.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
import { RoomWalletSettlementRouter } from "../payment/RoomWalletSettlementRouter.js";
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import {
    composeRoomWalletSettlementRouter,
    isRoomWalletOnlyFinancialPath
} from "../payment/roomWallet/roomWalletConfig.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import {
    createDummyRoomWalletCatalog,
    createDummyRoomWalletEntry
} from "./helpers/dummyRoomWallet.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WALLET = createDummyRoomWalletEntry(1);

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

test("isRoomWalletOnlyFinancialPath stays authoritative without env flags", () => {
    // Room Wallet is the only player-finance path on Testnet and Mainnet.
    // GAME_ESCROW_MODE must not control whether Room Wallet finance is enabled.
    assert.equal(isRoomWalletOnlyFinancialPath({ env: {} }), true);
    assert.equal(
        isRoomWalletOnlyFinancialPath({ env: { GAME_ESCROW_MODE: "game" } }),
        true
    );
    assert.equal(
        isRoomWalletOnlyFinancialPath({ env: { GAME_ESCROW_MODE: "v4" } }),
        true
    );
    assert.equal(
        isRoomWalletOnlyFinancialPath({ env: { TON_NETWORK: "mainnet" } }),
        true
    );
});

test("Room-Wallet-only settlement router composes the Room Wallet adapter", async () => {
    const router = composeRoomWalletSettlementRouter({
        tonService: {},
        logger: createLogger(),
        env: {
            TON_NETWORK: "testnet",
            ROOM_WALLETS_JSON: JSON.stringify(createDummyRoomWalletCatalog())
        }
    });

    assert.equal(router instanceof RoomWalletSettlementRouter, true);
    assert.equal(router.isEnabled(), true);
    assert.equal(
        router.activeAdapter instanceof RoomWalletSettlementAdapter,
        true
    );
});

test("GameContractManager skipBlockchainDeploy never starts Oracle deploy", async () => {
    const deployCalls = [];
    const eventBus = new EventBus({
        logger: createLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const manager = new GameContractManager({
        logger: createLogger(),
        eventBus,
        skipBlockchainDeploy: true,
        deployAdapter: {
            async deploy() {
                deployCalls.push("deploy");
                return { contractAddress: "EQEscrow" };
            }
        }
    });

    manager.initialize();
    await manager._beginDeploy("room-1");
    assert.equal(deployCalls.length, 0);
    assert.match(
        readFileSync(join(HERE, "../gameplay/GameContractManager.js"), "utf8"),
        /_skipBlockchainDeploy/
    );

    manager.shutdown();
    eventBus.shutdown();
});

test("PaymentSessionManager Room Wallet dest does not register Game Escrow watches", () => {
    const watches = [];
    const eventBus = new EventBus({
        logger: createLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const manager = new PaymentSessionManager({
        logger: createLogger(),
        eventBus,
        playerManager: {
            getIdentity() {
                return { baseStake: 1, sectorCount: 1 };
            }
        },
        roomManager: {
            getRoom() {
                return {
                    roomId: "room-1",
                    roomNumber: 1,
                    players: ["p1", "p2", "p3"],
                    status: ROOM_STATUS.LOCKED
                };
            }
        },
        gameplayContextResolver: {
            resolveGameIdByRoomId() {
                return "game-1";
            }
        },
        sessionWalletStore: {
            getWallet(_roomId, playerId) {
                return `EQ${playerId}WalletXXXXXXXXXXXXXXXXXXXX`;
            }
        },
        blockchainMonitor: {
            watchPayment(args) {
                watches.push(args);
            }
        },
        roomWalletPaymentIntakeEnabled: true
    });

    manager.initialize();
    manager.setRoomWalletFinance({
        registry: new RoomWalletRegistry({
            entries: [{ roomNumber: 1, address: WALLET.address }]
        }),
        roomWalletPaymentIntakeEnabled: true
    });

    const session = manager.createPaymentSession("room-1", { gameId: "game-1" });

    assert.equal(session.roomWalletAddress, WALLET.address);
    assert.equal(session.participants[0].paymentDestination, WALLET.address);
    assert.equal(session.participants[0].contractAddress, null);
    assert.equal(watches.length, 0);

    manager.issueDeployedPaymentRequests("room-1", {
        contractAddress: "EQShouldNotOverwrite"
    });
    assert.equal(session.participants[0].paymentDestination, WALLET.address);
    assert.equal(session.participants[0].contractAddress, null);

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_ESCROW_STAKE_CONFIRMED,
        payload: {
            roomId: "room-1",
            playerId: "p1",
            address: "EQEscrow",
            amount: 1,
            txHash: "escrow-stake"
        }
    });
    assert.notEqual(
        session.findParticipant("p1").status,
        "PAYMENT_CONFIRMED"
    );

    manager.shutdown();
    eventBus.shutdown();
});

test("PaymentSessionManager uses runtime network when PAYMENT_CONNECTION_READY has no room network", () => {
    const eventBus = new EventBus({
        logger: createLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const manager = new PaymentSessionManager({
        logger: createLogger(),
        eventBus,
        playerManager: {
            getIdentity() {
                return { baseStake: 1, sectorCount: 1 };
            }
        },
        roomManager: {
            getRoom(roomId) {
                return roomId === "room-1"
                    ? {
                        roomId,
                        roomNumber: 1,
                        players: ["p1", "p2", "p3"],
                        status: ROOM_STATUS.LOCKED
                    }
                    : null;
            }
        },
        gameplayContextResolver: {
            resolveGameIdByRoomId() {
                return "game-1";
            }
        },
        sessionWalletStore: {
            getWallet(_roomId, playerId) {
                return `EQ${playerId}WalletXXXXXXXXXXXXXXXXXXXX`;
            }
        },
        tonNetwork: "testnet",
        roomWalletPaymentIntakeEnabled: true
    });

    manager.initialize();
    manager.setRoomWalletFinance({
        registry: new RoomWalletRegistry({
            entries: [{ roomNumber: 1, address: WALLET.address }]
        }),
        roomWalletPaymentIntakeEnabled: true
    });

    eventBus.emit({
        source: "test",
        type: EVENT_TYPES.PAYMENT_CONNECTION_READY,
        payload: {
            roomId: "room-1",
            network: null
        }
    });

    const session = manager.getSession("room-1");

    assert.ok(session);
    assert.equal(session.network, "testnet");
    assert.equal(session.roomWalletAddress, WALLET.address);

    manager.shutdown();
    eventBus.shutdown();
});


test("app.js wires Room Wallet finance without legacy GameEscrow readiness", () => {
    const appSource = readFileSync(join(HERE, "../app.js"), "utf8");
    const psm = readFileSync(join(HERE, "../gameplay/PaymentSessionManager.js"), "utf8");
    const csm = readFileSync(join(HERE, "../payment/ContractSettlementManager.js"), "utf8");

    assert.match(appSource, /isRoomWalletOnlyFinancialPath/);
    assert.match(appSource, /composeRoomWalletSettlementRouter\(\{/);
    assert.match(appSource, /settlementAdapter:\s*this\._roomWalletSettlementRouter/);
    assert.match(appSource, /roomWalletPaymentIntakeEnabled:\s*isRoomWalletOnlyFinancialPath/);
    assert.match(appSource, /createRoomWalletRegistryFromEnv\(process\.env\)/);
    assert.match(appSource, /setRoomWalletFinance/);
    assert.equal(/skipBlockchainDeploy/.test(appSource), false);
    assert.equal(/legacySettlementAdapter/.test(appSource), false);
    assert.match(psm, /Room Wallet address is required for player payment/);
    assert.match(csm, /_isRoomWalletSettlementActive/);
    assert.match(csm, /ROOM_WALLET_SETTLEMENT/);
});
