import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ContractSettlementManager } from "../payment/ContractSettlementManager.js";
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import { RoomWalletSettlementRouter } from "../payment/RoomWalletSettlementRouter.js";
import {
    composeRoomWalletSettlementRouter,
    isRoomWalletPaymentIntakeEnabled,
    isRoomWalletSettlementEnabled
} from "../payment/roomWallet/roomWalletConfig.js";

const PUBLIC_KEY = "11".repeat(32);
const SECRET_KEY = "22".repeat(64);
const ADDRESS = "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c";

function envWithWallets(extra = {}) {
    return {
        ROOM_WALLETS_JSON: JSON.stringify([{
            roomNumber: 1,
            address: ADDRESS,
            publicKey: PUBLIC_KEY,
            secretKey: SECRET_KEY,
            workchain: 0,
            network: "testnet"
        }]),
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

test("ROOM_WALLET_SETTLEMENT_MODE is off unless it is exactly ROOM_WALLET", () => {
    assert.equal(isRoomWalletSettlementEnabled({}), false);
    assert.equal(isRoomWalletSettlementEnabled({ ROOM_WALLET_SETTLEMENT_MODE: "" }), false);
    assert.equal(isRoomWalletSettlementEnabled({ ROOM_WALLET_SETTLEMENT_MODE: "legacy" }), false);
    assert.equal(isRoomWalletSettlementEnabled({ ROOM_WALLET_SETTLEMENT_MODE: "true" }), false);
    assert.equal(isRoomWalletSettlementEnabled({ ROOM_WALLET_SETTLEMENT_MODE: "ROOM_WALLET" }), true);
    assert.equal(isRoomWalletSettlementEnabled({ ROOM_WALLET_SETTLEMENT_MODE: " room_wallet " }), true);
});

test("A. absent ROOM_WALLET_SETTLEMENT_MODE keeps legacy settlement", async () => {
    const legacy = capturingAdapter("legacy");
    const router = composeRoomWalletSettlementRouter({
        legacySettlementAdapter: legacy,
        tonService: {},
        env: {}
    });

    const result = await router.settleContract(SETTLEMENT_REQUEST);

    assert.equal(router instanceof RoomWalletSettlementRouter, true);
    assert.equal(router.isEnabled(), false);
    assert.equal(result.adapter, "legacy");
    assert.equal(legacy.calls.length, 1);
    assert.equal(legacy.calls[0], SETTLEMENT_REQUEST);
});

test("A. invalid ROOM_WALLET_SETTLEMENT_MODE keeps legacy settlement even when wallets exist", async () => {
    const legacy = capturingAdapter("legacy");
    const router = composeRoomWalletSettlementRouter({
        legacySettlementAdapter: legacy,
        tonService: {},
        env: envWithWallets({ ROOM_WALLET_SETTLEMENT_MODE: "enabled" })
    });

    const result = await router.settleContract({ gameId: "g-invalid-mode" });

    assert.equal(router.isEnabled(), false);
    assert.equal(result.adapter, "legacy");
});

test("B. ROOM_WALLET mode with valid runtime configuration uses Room Wallet settlement", async () => {
    const legacy = capturingAdapter("legacy");
    const router = composeRoomWalletSettlementRouter({
        legacySettlementAdapter: legacy,
        tonService: {},
        logger: createLogger(),
        env: envWithWallets({ ROOM_WALLET_SETTLEMENT_MODE: "ROOM_WALLET" })
    });

    assert.equal(router.isEnabled(), true);
    assert.equal(router.activeAdapter instanceof RoomWalletSettlementAdapter, true);
    assert.equal(legacy.calls.length, 0);
});

test("C. ROOM_WALLET mode fails closed when runtime wallet configuration is missing", () => {
    const legacy = capturingAdapter("legacy");

    assert.throws(
        () => composeRoomWalletSettlementRouter({
            legacySettlementAdapter: legacy,
            tonService: {},
            env: { ROOM_WALLET_SETTLEMENT_MODE: "ROOM_WALLET" }
        }),
        /runtime configuration is not available/
    );
});

test("C. ROOM_WALLET mode fails closed when tonService is unavailable", () => {
    const legacy = capturingAdapter("legacy");

    assert.throws(
        () => composeRoomWalletSettlementRouter({
            legacySettlementAdapter: legacy,
            tonService: null,
            env: envWithWallets({ ROOM_WALLET_SETTLEMENT_MODE: "ROOM_WALLET" })
        }),
        /tonService is not available/
    );
});

test("C. ROOM_WALLET mode fails closed when ROOM_WALLETS_JSON is invalid", () => {
    const legacy = capturingAdapter("legacy");

    assert.throws(
        () => composeRoomWalletSettlementRouter({
            legacySettlementAdapter: legacy,
            tonService: {},
            env: {
                ROOM_WALLET_SETTLEMENT_MODE: "ROOM_WALLET",
                ROOM_WALLETS_JSON: "{not-json"
            }
        }),
        /not valid JSON/
    );
});

test("D. ContractSettlementManager receives the composed Room Wallet router", () => {
    const legacy = capturingAdapter("legacy");
    const router = composeRoomWalletSettlementRouter({
        legacySettlementAdapter: legacy,
        env: {}
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
    assert.equal(manager._settlementAdapter.isEnabled(), false);
});

test("E. settlement request fields pass through unchanged on both paths", async () => {
    const legacy = capturingAdapter("legacy");
    const roomWallet = capturingAdapter("room-wallet");

    const legacyRouter = composeRoomWalletSettlementRouter({
        legacySettlementAdapter: legacy,
        env: {}
    });
    const enabledRouter = new RoomWalletSettlementRouter({
        legacySettlementAdapter: legacy,
        roomWalletSettlementAdapter: roomWallet,
        enabled: true
    });

    const legacyResult = await legacyRouter.settleContract(SETTLEMENT_REQUEST);
    const roomWalletResult = await enabledRouter.settleContract(SETTLEMENT_REQUEST);

    assert.equal(legacyResult.request, SETTLEMENT_REQUEST);
    assert.equal(roomWalletResult.request, SETTLEMENT_REQUEST);
    assert.deepEqual(legacy.calls[0], SETTLEMENT_REQUEST);
    assert.deepEqual(roomWallet.calls[0], SETTLEMENT_REQUEST);
    assert.equal(legacy.calls[0].winnerWallet, SETTLEMENT_REQUEST.winnerWallet);
    assert.equal(legacy.calls[0].winnerAmount, SETTLEMENT_REQUEST.winnerAmount);
    assert.equal(legacy.calls[0].ownerWallet, SETTLEMENT_REQUEST.ownerWallet);
    assert.equal(legacy.calls[0].organizerAmount, SETTLEMENT_REQUEST.organizerAmount);
    assert.equal(legacy.calls[0].gameId, SETTLEMENT_REQUEST.gameId);
    assert.equal(legacy.calls[0].roomId, SETTLEMENT_REQUEST.roomId);
    assert.equal(legacy.calls[0].totalPot, SETTLEMENT_REQUEST.totalPot);
    assert.equal(legacy.calls[0].settlementId, SETTLEMENT_REQUEST.settlementId);
    assert.equal(roomWallet.calls[0].winnerWallet, SETTLEMENT_REQUEST.winnerWallet);
    assert.equal(roomWallet.calls[0].prizeAmountNano, SETTLEMENT_REQUEST.prizeAmountNano);
    assert.equal(roomWallet.calls[0].organizerAmountNano, SETTLEMENT_REQUEST.organizerAmountNano);
});

test("app.js wires the Room Wallet router into ContractSettlementManager", () => {
    const source = readFileSync(fileURLToPath(new URL("../app.js", import.meta.url)), "utf8");

    assert.match(source, /composeRoomWalletSettlementRouter/);
    assert.match(source, /legacySettlementAdapter:\s*deployAdapter/);
    assert.match(source, /settlementAdapter:\s*this\._roomWalletSettlementRouter/);
    assert.equal(/settlementAdapter:\s*deployAdapter/.test(source), false);
    assert.match(source, /new ContractSettlementManager\(\{[\s\S]*?roomManager:\s*this\._managers\.roomManager/);
    assert.match(source, /new RoomWalletIncomingObserver\(\{[\s\S]*?roomManager:\s*this\._managers\.roomManager/);
    assert.match(source, /isRoomWalletPaymentIntakeEnabled/);
    assert.match(source, /RoomWalletLedgerRegistry/);
    assert.match(source, /ledgerRegistry:\s*this\._roomWalletLedgerRegistry/);
    assert.match(source, /roomWalletPaymentIntakeEnabled:\s*isRoomWalletPaymentIntakeEnabled/);
});
