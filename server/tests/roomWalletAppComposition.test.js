import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ContractSettlementManager } from "../payment/ContractSettlementManager.js";
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import { RoomWalletSettlementRouter } from "../payment/RoomWalletSettlementRouter.js";
import {
    composeRoomWalletSettlementRouter,
    isRoomWalletOnlyFinancialPath,
    isRoomWalletPaymentIntakeEnabled,
    isRoomWalletResidualSweepEnabled,
    isRoomWalletSettlementEnabled
} from "../payment/roomWallet/roomWalletConfig.js";
import {
    createDummyRoomWalletCatalog,
    createDummyRoomWalletEntry
} from "./helpers/dummyRoomWallet.js";

const WALLET = createDummyRoomWalletEntry(1);
const ADDRESS = WALLET.address;

function envWithWallets(extra = {}) {
    return {
        ROOM_WALLETS_JSON: JSON.stringify([WALLET]),
        ...extra
    };
}

function envWithFullCatalog(extra = {}) {
    return {
        TON_NETWORK: "testnet",
        ROOM_WALLETS_JSON: JSON.stringify(createDummyRoomWalletCatalog()),
        ...extra
    };
}

function capturingAdapter(name) {
    const calls = [];
    return {
        name,
        calls,
        async settleContract(request) {
            calls.push(request);
            return { ok: true, adapter: name, request };
        },
        async getSettlementState(address) {
            return { adapter: name, address };
        }
    };
}

function createLogger() {
    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        startupLine() {}
    };
}

const SETTLEMENT_REQUEST = Object.freeze({
    gameId: "game_fa881639-dc5c-42c1-90b9-5205f5475c5a",
    roomId: "csU9",
    roomNumber: 1,
    contractId: "contract_bbf5520e-f3ed-4fae-add1-abb64cd3c011",
    contractAddress: "EQContractAddressForPassthroughXXXXXXXXXX",
    winnerId: "player-winner",
    winnerWallet: "EQAREREREREREREREREREREREREREREREREREREREREREeYT",
    ownerWallet: ADDRESS,
    winnerAmount: 9.5,
    prizeAmount: 9.5,
    prizeAmountNano: 9_500_000_000n,
    organizerAmount: 0.15,
    organizerAmountNano: 150_000_000n,
    totalPot: 10,
    settlementId: "settle_passthrough_1"
});

test("ROOM_WALLET_PAYMENT_INTAKE_MODE is independent of settlement mode", () => {
    assert.equal(isRoomWalletPaymentIntakeEnabled({}), false);
    assert.equal(isRoomWalletPaymentIntakeEnabled({ ROOM_WALLET_SETTLEMENT_MODE: "ROOM_WALLET" }), false);
    assert.equal(isRoomWalletPaymentIntakeEnabled({ ROOM_WALLET_PAYMENT_INTAKE_MODE: "true" }), false);
    assert.equal(isRoomWalletPaymentIntakeEnabled({ ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET" }), true);
    assert.equal(isRoomWalletPaymentIntakeEnabled({ ROOM_WALLET_PAYMENT_INTAKE_MODE: " room_wallet " }), true);
});

test("ROOM_WALLET_RESIDUAL_SWEEP_ENABLED is off by default and independent of intake", () => {
    assert.equal(isRoomWalletResidualSweepEnabled({}), false);
    assert.equal(isRoomWalletResidualSweepEnabled({ ROOM_WALLET_PAYMENT_INTAKE_MODE: "ROOM_WALLET" }), false);
    assert.equal(isRoomWalletResidualSweepEnabled({ ROOM_WALLET_SETTLEMENT_MODE: "ROOM_WALLET" }), false);
    assert.equal(isRoomWalletResidualSweepEnabled({ ROOM_WALLET_RESIDUAL_SWEEP_ENABLED: "true" }), true);
});

test("ROOM_WALLET_SETTLEMENT_MODE is off unless it is exactly ROOM_WALLET", () => {
    assert.equal(isRoomWalletSettlementEnabled({}), false);
    assert.equal(isRoomWalletSettlementEnabled({ ROOM_WALLET_SETTLEMENT_MODE: "" }), false);
    assert.equal(isRoomWalletSettlementEnabled({ ROOM_WALLET_SETTLEMENT_MODE: "legacy" }), false);
    assert.equal(isRoomWalletSettlementEnabled({ ROOM_WALLET_SETTLEMENT_MODE: "true" }), false);
    assert.equal(isRoomWalletSettlementEnabled({ ROOM_WALLET_SETTLEMENT_MODE: "ROOM_WALLET" }), true);
    assert.equal(isRoomWalletSettlementEnabled({ ROOM_WALLET_SETTLEMENT_MODE: " room_wallet " }), true);
});

test("Room Wallet settlement is enabled without a settlement env flag", () => {
    const router = composeRoomWalletSettlementRouter({
        tonService: {},
        logger: createLogger(),
        env: envWithFullCatalog()
    });

    assert.equal(isRoomWalletOnlyFinancialPath({}), true);
    assert.equal(router.isEnabled(), true);
    assert.equal(router.activeAdapter instanceof RoomWalletSettlementAdapter, true);
});

test("A. absent ROOM_WALLET_SETTLEMENT_MODE keeps Room Wallet settlement enabled", () => {
    const router = composeRoomWalletSettlementRouter({
        tonService: {},
        env: envWithFullCatalog()
    });

    assert.equal(router instanceof RoomWalletSettlementRouter, true);
    assert.equal(router.isEnabled(), true);
    assert.equal(router.activeAdapter instanceof RoomWalletSettlementAdapter, true);
});

test("A. invalid ROOM_WALLET_SETTLEMENT_MODE does not disable Room Wallet settlement", () => {
    const router = composeRoomWalletSettlementRouter({
        tonService: {},
        env: envWithFullCatalog({ ROOM_WALLET_SETTLEMENT_MODE: "enabled" })
    });

    assert.equal(router.isEnabled(), true);
});

test("B. valid runtime configuration uses Room Wallet settlement", () => {
    const router = composeRoomWalletSettlementRouter({
        tonService: {},
        logger: createLogger(),
        env: envWithFullCatalog({ ROOM_WALLET_SETTLEMENT_MODE: "ROOM_WALLET" })
    });

    assert.equal(router.isEnabled(), true);
    assert.equal(router.activeAdapter instanceof RoomWalletSettlementAdapter, true);
});

test("C. Room Wallet settlement fails closed when runtime wallet configuration is missing", () => {
    assert.throws(
        () => composeRoomWalletSettlementRouter({
            tonService: {},
            env: { TON_NETWORK: "testnet", ROOM_WALLET_SETTLEMENT_MODE: "ROOM_WALLET" }
        }),
        /ROOM_WALLETS_TESTNET_JSON/
    );
});

test("C. Room Wallet settlement fails closed when tonService is unavailable", () => {
    assert.throws(
        () => composeRoomWalletSettlementRouter({
            tonService: null,
            env: envWithFullCatalog({ ROOM_WALLET_SETTLEMENT_MODE: "ROOM_WALLET" })
        }),
        /tonService is not available/
    );
});

test("C. Room Wallet settlement fails closed when ROOM_WALLETS_JSON is invalid", () => {
    assert.throws(
        () => composeRoomWalletSettlementRouter({
            tonService: {},
            env: {
                TON_NETWORK: "testnet",
                ROOM_WALLET_SETTLEMENT_MODE: "ROOM_WALLET",
                ROOM_WALLETS_JSON: "{not-json"
            }
        }),
        /not valid JSON/
    );
});

test("D. ContractSettlementManager receives the composed Room Wallet router", () => {
    const router = composeRoomWalletSettlementRouter({
        tonService: {},
        env: envWithFullCatalog()
    });
    const manager = new ContractSettlementManager({
        logger: createLogger(),
        eventBus: { subscribe() {}, publish() {} },
        gameContractManager: {},
        winnerEngine: {},
        settlementAdapter: router
    });

    assert.equal(manager._settlementAdapter, router);
    assert.equal(manager._settlementAdapter instanceof RoomWalletSettlementRouter, true);
    assert.equal(manager._settlementAdapter.isEnabled(), true);
});

test("E. settlement request fields pass through unchanged", async () => {
    const roomWallet = capturingAdapter("room-wallet");
    const router = new RoomWalletSettlementRouter({
        roomWalletSettlementAdapter: roomWallet,
        enabled: true
    });

    const roomWalletResult = await router.settleContract(SETTLEMENT_REQUEST);

    assert.equal(roomWalletResult.request, SETTLEMENT_REQUEST);
    assert.deepEqual(roomWallet.calls[0], SETTLEMENT_REQUEST);
    assert.equal(roomWallet.calls[0].winnerWallet, SETTLEMENT_REQUEST.winnerWallet);
    assert.equal(roomWallet.calls[0].winnerAmount, SETTLEMENT_REQUEST.winnerAmount);
    assert.equal(roomWallet.calls[0].ownerWallet, SETTLEMENT_REQUEST.ownerWallet);
    assert.equal(roomWallet.calls[0].organizerAmount, SETTLEMENT_REQUEST.organizerAmount);
    assert.equal(roomWallet.calls[0].gameId, SETTLEMENT_REQUEST.gameId);
    assert.equal(roomWallet.calls[0].roomId, SETTLEMENT_REQUEST.roomId);
    assert.equal(roomWallet.calls[0].totalPot, SETTLEMENT_REQUEST.totalPot);
    assert.equal(roomWallet.calls[0].settlementId, SETTLEMENT_REQUEST.settlementId);
    assert.equal(roomWallet.calls[0].prizeAmountNano, SETTLEMENT_REQUEST.prizeAmountNano);
    assert.equal(roomWallet.calls[0].organizerAmountNano, SETTLEMENT_REQUEST.organizerAmountNano);
});

test("app.js wires the Room Wallet router into ContractSettlementManager", () => {
    const source = readFileSync(fileURLToPath(new URL("../app.js", import.meta.url)), "utf8");

    assert.match(source, /composeRoomWalletSettlementRouter/);
    assert.match(source, /settlementAdapter:\s*this\._roomWalletSettlementRouter/);
    assert.equal(/settlementAdapter:\s*deployAdapter/.test(source), false);
    assert.match(source, /new ContractSettlementManager\(\{[\s\S]*?roomManager:\s*this\._managers\.roomManager/);
    assert.match(source, /new RoomWalletIncomingObserver\(\{[\s\S]*?roomManager:\s*this\._managers\.roomManager/);
    assert.match(source, /isRoomWalletOnlyFinancialPath/);
    assert.match(source, /RoomWalletLedgerRegistry/);
    assert.match(source, /ledgerRegistry:\s*this\._roomWalletLedgerRegistry/);
    assert.match(source, /roomWalletPaymentIntakeEnabled:\s*isRoomWalletOnlyFinancialPath/);
    assert.match(source, /tonNetwork:\s*this\._tonConfig\?\.network \?\? null/);
    assert.match(source, /createRoomWalletRegistryFromEnv\(process\.env\)/);
    assert.match(source, /RoomWalletResidualSweepWorker/);
    assert.match(source, /new RoomWalletResidualSweepRepository/);
});
