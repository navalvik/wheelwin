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
import {
    composeRoomWalletSettlementRouter,
    isRoomWalletOnlyFinancialPath
} from "../payment/roomWallet/roomWalletConfig.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import { createDummyRoomWalletEntry } from "./helpers/dummyRoomWallet.js";

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

test("isRoomWalletOnlyFinancialPath follows game mode without env flags", () => {
    assert.equal(isRoomWalletOnlyFinancialPath({ env: {}, gameEscrowMode: "game" }), true);
    assert.equal(isRoomWalletOnlyFinancialPath({ env: {}, gameEscrowMode: "v4" }), false);
    assert.equal(isRoomWalletOnlyFinancialPath({ env: {} }), false);
});

test("game-mode settlement router does not invoke Game Escrow adapter", async () => {
    const escrowCalls = [];
    const legacy = {
        async settleContract(request) {
            escrowCalls.push(request);
            return { ok: true, adapter: "escrow" };
        }
    };
    const router = composeRoomWalletSettlementRouter({
        legacySettlementAdapter: legacy,
        tonService: {},
        logger: createLogger(),
        env: { ROOM_WALLETS_JSON: JSON.stringify([WALLET]) },
        gameEscrowMode: "game"
    });

    assert.equal(router instanceof RoomWalletSettlementRouter, true);
    assert.equal(router.isEnabled(), true);
    assert.notEqual(router.activeAdapter, legacy);
    assert.equal(escrowCalls.length, 0);
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
    assert.equal(session.participants[0].contractAddress, WALLET.address);
    assert.equal(watches.length, 0);

    manager.issueDeployedPaymentRequests("room-1", {
        contractAddress: "EQShouldNotOverwrite"
    });
    assert.equal(session.participants[0].contractAddress, WALLET.address);

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

test("app.js wires Room Wallet finance for game mode", () => {
    const appSource = readFileSync(join(HERE, "../app.js"), "utf8");
    const psm = readFileSync(join(HERE, "../gameplay/PaymentSessionManager.js"), "utf8");
    const csm = readFileSync(join(HERE, "../payment/ContractSettlementManager.js"), "utf8");

    assert.match(appSource, /isRoomWalletOnlyFinancialPath/);
    assert.match(appSource, /skipBlockchainDeploy:\s*isRoomWalletOnlyFinancialPath/);
    assert.match(appSource, /gameEscrowMode:\s*this\._tonConfig\?\.gameEscrowMode/);
    assert.match(appSource, /setRoomWalletFinance/);
    assert.match(psm, /Room Wallet address is required for player payment/);
    assert.match(csm, /_isRoomWalletSettlementActive/);
    assert.match(csm, /ROOM_WALLET_SETTLEMENT/);
});
