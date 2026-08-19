/**
 * R17.9L.20 — Deposit player wallet binding hardening.
 * Validates that reserved/system wallets are rejected at binding time.
 * No real TON. No mnemonics. No Page4.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Address } from "@ton/core";

import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { InvalidDepositBindingError } from "../deposit/DepositSessionErrors.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import { DepositMonitor } from "../deposit/DepositMonitor.js";
import { FakeDepositBlockchainSource } from "../deposit/FakeDepositBlockchainSource.js";
import {
    assertPlayerBindings,
    resolveReservedDepositWallets
} from "../deposit/depositValidation.js";
import { canonicalizeTonWalletAddress } from "../models/TonWalletAddress.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

const PLAYER_WALLET_0 = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const PLAYER_WALLET_1 = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";
const PLAYER_WALLET_2 = "EQADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA8id";

const ZERO_ADDRESS = new Address(0, Buffer.alloc(32)).toString({
    bounceable: true,
    urlSafe: true
});

const ZERO_ADDRESS_NON_BOUNCEABLE = new Address(0, Buffer.alloc(32)).toString({
    bounceable: false,
    urlSafe: true
});

const ORACLE_FIXTURE = "EQAREREREREREREREREREREREREREREREREREREREREREeYT";
const PRODUCTION_DEPLOY_WALLET = "EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ";
const TESTNET_DEPOSIT_DEPLOYER = "0QBSm-tvehArk8g8VybQEUpI83rI1IZozP3KUK8WdvMSjaIl";

function testEnv() {

    return {
        TON_DEPLOYER_WALLET: PRODUCTION_DEPLOY_WALLET,
        TON_TESTNET_DEPOSIT_DEPLOYER_ADDRESS: TESTNET_DEPOSIT_DEPLOYER,
        TON_TESTNET_ORACLE_ADDRESS: ORACLE_FIXTURE
    };

}

function createCoordinator(env = testEnv()) {

    const eventBus = new EventBus({
        logger: { info() {}, warn() {}, error() {}, debug() {}, decisionTrace() {} },
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    return new DepositSessionCoordinator({
        eventBus,
        env,
        reservedWallets: resolveReservedDepositWallets(env)
    });

}

function validPlayers() {

    return [
        { playerId: "p0", wallet: PLAYER_WALLET_0, expectedAmount: 10 },
        { playerId: "p1", wallet: PLAYER_WALLET_1, expectedAmount: 10 },
        { playerId: "p2", wallet: PLAYER_WALLET_2, expectedAmount: 10 }
    ];

}

function bindWithWallet(coordinator, wallet) {

    const session = coordinator.createSession({
        roomId: `room-${Date.now()}-${Math.random()}`,
        gameId: `game-${Date.now()}-${Math.random()}`
    });

    coordinator.bindPlayers(session.depositId, [
        { playerId: "p0", wallet, expectedAmount: 10 },
        { playerId: "p1", wallet: PLAYER_WALLET_1, expectedAmount: 10 },
        { playerId: "p2", wallet: PLAYER_WALLET_2, expectedAmount: 10 }
    ]);

}

// ─── 1. ZERO rejected ───

test("R17.9L.20 Test1: ZERO address rejected at binding", () => {

    const coordinator = createCoordinator();

    assert.throws(
        () => bindWithWallet(coordinator, ZERO_ADDRESS),
        (err) => {

            assert.ok(err instanceof InvalidDepositBindingError);
            assert.ok(err.message.includes("ZERO_ADDRESS"));

            return true;

        }
    );

});

test("R17.9L.20 Test1b: ZERO non-bounceable also rejected", () => {

    const coordinator = createCoordinator();

    assert.throws(
        () => bindWithWallet(coordinator, ZERO_ADDRESS_NON_BOUNCEABLE),
        (err) => {

            assert.ok(err instanceof InvalidDepositBindingError);
            assert.ok(err.message.includes("ZERO_ADDRESS"));

            return true;

        }
    );

});

// ─── 2. Production Deploy Wallet rejected ───

test("R17.9L.20 Test2: production Deploy Wallet rejected at binding", () => {

    const coordinator = createCoordinator();

    assert.throws(
        () => bindWithWallet(coordinator, PRODUCTION_DEPLOY_WALLET),
        (err) => {

            assert.ok(err instanceof InvalidDepositBindingError);
            assert.ok(err.message.includes("PRODUCTION_DEPLOY_WALLET"));

            return true;

        }
    );

});

// ─── 3. TESTNET Deposit Deployer rejected ───

test("R17.9L.20 Test3: TESTNET Deposit Deployer rejected at binding", () => {

    const coordinator = createCoordinator();

    assert.throws(
        () => bindWithWallet(coordinator, TESTNET_DEPOSIT_DEPLOYER),
        (err) => {

            assert.ok(err instanceof InvalidDepositBindingError);
            assert.ok(err.message.includes("TESTNET_DEPOSIT_DEPLOYER"));

            return true;

        }
    );

});

// ─── 4. releaseAuthority rejected ───

test("R17.9L.20 Test4: releaseAuthority / oracle rejected at binding", () => {

    const coordinator = createCoordinator();

    assert.throws(
        () => bindWithWallet(coordinator, ORACLE_FIXTURE),
        (err) => {

            assert.ok(err instanceof InvalidDepositBindingError);
            assert.ok(err.message.includes("RELEASE_AUTHORITY"));

            return true;

        }
    );

});

// ─── 5. Duplicate player rejected ───

test("R17.9L.20 Test5: duplicate wallet rejected at binding", () => {

    const coordinator = createCoordinator();

    const session = coordinator.createSession({ roomId: "room-dup", gameId: "game-dup" });

    assert.throws(
        () => coordinator.bindPlayers(session.depositId, [
            { playerId: "p0", wallet: PLAYER_WALLET_0, expectedAmount: 10 },
            { playerId: "p1", wallet: PLAYER_WALLET_0, expectedAmount: 10 },
            { playerId: "p2", wallet: PLAYER_WALLET_2, expectedAmount: 10 }
        ]),
        InvalidDepositBindingError
    );

});

// ─── 6. Three valid distinct players accepted ───

test("R17.9L.20 Test6: three valid distinct players accepted", () => {

    const coordinator = createCoordinator();

    const session = coordinator.createSession({ roomId: "room-ok", gameId: "game-ok" });

    coordinator.bindPlayers(session.depositId, validPlayers());

    assert.equal(session.state, DEPOSIT_SESSION_STATUS.PLAYER_BINDING);

    assert.equal(session.bindings.length, 3);

    assert.equal(
        new Set(session.bindings.map((binding) => binding.wallet)).size,
        3
    );

});

// ─── 7. Canonical equivalent address forms behave identically ───

test("R17.9L.20 Test7: canonical equivalent ZERO forms all rejected", () => {

    const coordinator = createCoordinator();

    const zeroRaw = "0:0000000000000000000000000000000000000000000000000000000000000000";

    assert.throws(
        () => bindWithWallet(coordinator, zeroRaw),
        InvalidDepositBindingError
    );

});

test("R17.9L.20 Test7b: canonical normalization stores canonical form", () => {

    const coordinator = createCoordinator();

    const session = coordinator.createSession({ roomId: "room-norm", gameId: "game-norm" });

    coordinator.bindPlayers(session.depositId, validPlayers());

    for (const binding of session.bindings) {

        assert.equal(binding.wallet, canonicalizeTonWalletAddress(binding.wallet));

    }

});

// ─── 8. Existing FundSeat sender validation still passes ───

test("R17.9L.20 Test8: valid FundSeat from bound player accepted", () => {

    const coordinator = createCoordinator();

    const logger = { info() {}, warn() {}, error() {}, debug() {}, decisionTrace() {} };

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const monitor = new DepositMonitor({
        logger,
        eventBus,
        depositSessionCoordinator: coordinator,
        network: "testnet"
    });

    monitor.initialize();

    const source = new FakeDepositBlockchainSource({ monitor });

    const session = coordinator.createSession({ roomId: "room-fund", gameId: "game-fund" });

    coordinator.bindPlayers(session.depositId, validPlayers());

    coordinator.markAwaitingFunds(session.depositId);

    coordinator.setDepositAddress(session.depositId, "EQAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBMWg"); // R17.9L.21

    monitor.startWatching(session);

    const emitted = [];

    eventBus.subscribe(EVENT_TYPES.DEPOSIT_SEAT_FUNDED, (envelope) => {

        emitted.push(envelope);

    });

    source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: session.depositAddress, // R17.9L.21 must match canonical session address
        senderWallet: PLAYER_WALLET_0,
        amount: 10,
        transactionHash: "tx-test-8"
    });

    assert.equal(emitted.length, 1);

});

// ─── 9. Invalid sender still fails downstream ───

test("R17.9L.20 Test9: unknown sender rejected by DepositMonitor", () => {

    const coordinator = createCoordinator();

    const logger = { info() {}, warn() {}, error() {}, debug() {}, decisionTrace() {} };

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const monitor = new DepositMonitor({
        logger,
        eventBus,
        depositSessionCoordinator: coordinator,
        network: "testnet"
    });

    monitor.initialize();

    const source = new FakeDepositBlockchainSource({ monitor });

    const session = coordinator.createSession({ roomId: "room-bad", gameId: "game-bad" });

    coordinator.bindPlayers(session.depositId, validPlayers());

    coordinator.markAwaitingFunds(session.depositId);

    coordinator.setDepositAddress(session.depositId, "EQAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBMWg"); // R17.9L.21

    monitor.startWatching(session);

    const emitted = [];

    eventBus.subscribe(EVENT_TYPES.DEPOSIT_SEAT_FUNDED, (envelope) => {

        emitted.push(envelope);

    });

    source.emitValidPayment({
        depositId: session.depositId,
        depositAddress: "EQ_deposit_bad",
        senderWallet: "EQAREREREREREREREREREREREREREREREREREREREREREeYT",
        amount: 10,
        transactionHash: "tx-unknown"
    });

    assert.equal(emitted.length, 0);

});

// ─── 10. resolveReservedDepositWallets unit ───

test("R17.9L.20 Test10: resolveReservedDepositWallets includes expected entries", () => {

    const reserved = resolveReservedDepositWallets(testEnv());

    assert.ok(reserved.has(ZERO_ADDRESS));

    assert.equal(reserved.get(ZERO_ADDRESS), "ZERO_ADDRESS");

    const canonProd = canonicalizeTonWalletAddress(PRODUCTION_DEPLOY_WALLET);

    assert.ok(reserved.has(canonProd));

    const canonDeployer = canonicalizeTonWalletAddress(TESTNET_DEPOSIT_DEPLOYER);

    assert.ok(reserved.has(canonDeployer));

    const canonOracle = canonicalizeTonWalletAddress(ORACLE_FIXTURE);

    assert.ok(reserved.has(canonOracle));

});

test("R17.9L.20 Test10b: empty env still blocks ZERO", () => {

    const reserved = resolveReservedDepositWallets({});

    assert.ok(reserved.has(ZERO_ADDRESS));

    assert.equal(reserved.size, 1);

});

// ─── 11. Wallet not in env skipped gracefully ───

test("R17.9L.20 Test11: missing env keys produce no extra reservations", () => {

    const reserved = resolveReservedDepositWallets({
        TON_DEPLOYER_WALLET: ""
    });

    assert.equal(reserved.size, 1);

    assert.ok(reserved.has(ZERO_ADDRESS));

});

console.log("depositPlayerWalletBinding.r179l20.test.js: all scenarios complete");
