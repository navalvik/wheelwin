/**
 * R17.9L.21 — DepositAddress domain setter + persistence hardening.
 * No real TON. No mnemonics. No deployment. No Page4.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Address } from "@ton/core";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { DepositSession } from "../deposit/DepositSession.js";
import {
    InvalidDepositAddressError
} from "../deposit/DepositSessionErrors.js";
import { InMemoryDepositPersistence } from "../deposit/DepositPersistencePort.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { canonicalizeTonWalletAddress } from "../models/TonWalletAddress.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_SOURCE = readFileSync(
    join(HERE, "../deposit/DepositSession.js"),
    "utf8"
);
const COORDINATOR_SOURCE = readFileSync(
    join(HERE, "../deposit/DepositSessionCoordinator.js"),
    "utf8"
);

const NOOP_LOGGER = { info() {}, warn() {}, error() {}, debug() {}, decisionTrace() {} };
const EB_OPTS = { logger: NOOP_LOGGER, eventBusConfig: { logEvents: false, showDebugPanel: false } };

const PLAYER_WALLET_0 = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const PLAYER_WALLET_1 = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";
const PLAYER_WALLET_2 = "EQADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA8id";

const DEPOSIT_ADDRESS_1 = "EQAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBMWg";
const DEPOSIT_ADDRESS_2 = "EQAFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBccf";

function threePlayers() {

    return [
        { playerId: "p0", wallet: PLAYER_WALLET_0, expectedAmount: 10 },
        { playerId: "p1", wallet: PLAYER_WALLET_1, expectedAmount: 10 },
        { playerId: "p2", wallet: PLAYER_WALLET_2, expectedAmount: 10 }
    ];

}

function harness() {

    const eventBus = new EventBus(EB_OPTS);
    const persistence = new InMemoryDepositPersistence();

    const coordinator = new DepositSessionCoordinator({
        eventBus,
        persistence
    });

    const session = coordinator.createSession({
        roomId: "room-21",
        gameId: "game-21"
    });

    coordinator.bindPlayers(session.depositId, threePlayers());

    coordinator.markAwaitingFunds(session.depositId);

    return { coordinator, persistence, eventBus, session };

}

// --- Test 1: valid address assignment ---

test("R17.9L.21 T1: valid TON address assignment persists correctly", () => {

    const { coordinator, persistence, session } = harness();

    coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS_1);

    assert.equal(session.depositAddress, canonicalizeTonWalletAddress(DEPOSIT_ADDRESS_1));

    const record = persistence.loadDepositSession(session.depositId);
    assert.equal(record.payload.depositAddress, session.depositAddress);

});

// --- Test 2: invalid address rejected ---

test("R17.9L.21 T2: malformed address rejected", () => {

    const { coordinator, session } = harness();

    assert.throws(
        () => coordinator.setDepositAddress(session.depositId, "not-an-address"),
        InvalidDepositAddressError
    );

    assert.equal(session.depositAddress, null);

});

// --- Test 3: null/undefined rejected ---

test("R17.9L.21 T3: null rejected", () => {

    const { coordinator, session } = harness();

    assert.throws(
        () => coordinator.setDepositAddress(session.depositId, null),
        InvalidDepositAddressError
    );

    assert.equal(session.depositAddress, null);

});

test("R17.9L.21 T3b: undefined rejected", () => {

    const { coordinator, session } = harness();

    assert.throws(
        () => coordinator.setDepositAddress(session.depositId, undefined),
        InvalidDepositAddressError
    );

    assert.equal(session.depositAddress, null);

});

test("R17.9L.21 T3c: empty string rejected", () => {

    const { coordinator, session } = harness();

    assert.throws(
        () => coordinator.setDepositAddress(session.depositId, ""),
        InvalidDepositAddressError
    );

    assert.equal(session.depositAddress, null);

});

// --- Test 4: same address reassignment (idempotent) ---

test("R17.9L.21 T4: same address reassignment is idempotent", () => {

    const { coordinator, session } = harness();

    coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS_1);

    const versionAfterFirst = session.version;

    coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS_1);

    assert.equal(session.depositAddress, canonicalizeTonWalletAddress(DEPOSIT_ADDRESS_1));
    assert.equal(session.version, versionAfterFirst);

});

// --- Test 5: different address reassignment rejected ---

test("R17.9L.21 T5: different address reassignment rejected", () => {

    const { coordinator, session } = harness();

    coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS_1);

    assert.throws(
        () => coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS_2),
        InvalidDepositAddressError
    );

    assert.equal(session.depositAddress, canonicalizeTonWalletAddress(DEPOSIT_ADDRESS_1));

});

// --- Test 6: persistence failure → no state change, no event ---

test("R17.9L.21 T6: persistence failure leaves state unchanged", () => {

    const eventBus = new EventBus(EB_OPTS);

    const failingPersistence = new InMemoryDepositPersistence();

    const coordinator = new DepositSessionCoordinator({
        eventBus,
        persistence: failingPersistence
    });

    const session = coordinator.createSession({ roomId: "room-pf", gameId: "game-pf" });

    coordinator.bindPlayers(session.depositId, threePlayers());

    coordinator.markAwaitingFunds(session.depositId);

    failingPersistence.saveDepositSession = () => {
        throw new Error("persistence_failure");
    };

    const events = [];
    eventBus.subscribe(EVENT_TYPES.DEPOSIT_STATE_CHANGED, (e) => events.push(e));

    assert.throws(
        () => coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS_1),
        /persistence_failure/
    );

    assert.equal(session.depositAddress, null);
    assert.equal(events.length, 0);

});

// --- Test 7: restart persistence ---

test("R17.9L.21 T7: address survives save → restore cycle", () => {

    const { coordinator, persistence, session } = harness();

    coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS_1);

    const canonical = session.depositAddress;

    const coordinator2 = new DepositSessionCoordinator({
        eventBus: new EventBus(EB_OPTS),
        persistence
    });

    coordinator2.restoreFromPersistence(session.depositId);

    const restored = coordinator2.getSession(session.depositId);

    assert.equal(restored.depositAddress, canonical);

});

// --- Test 8: canonical TON identity ---

test("R17.9L.21 T8: different friendly forms of same address treated as same", () => {

    const { coordinator, session } = harness();

    const addr = Address.parse(DEPOSIT_ADDRESS_1);

    const bounceable = addr.toString({ bounceable: true, urlSafe: true });
    const nonBounceable = addr.toString({ bounceable: false, urlSafe: true });

    coordinator.setDepositAddress(session.depositId, bounceable);

    const canonical = session.depositAddress;

    coordinator.setDepositAddress(session.depositId, nonBounceable);

    assert.equal(session.depositAddress, canonical);
    assert.equal(canonical, canonicalizeTonWalletAddress(bounceable));
    assert.equal(canonical, canonicalizeTonWalletAddress(nonBounceable));

});

// --- Test 9: deterministic address mismatch ---
// Deterministic derivation (buildDepositStateInit) belongs to the orchestrator layer.
// At the domain/coordinator level, we enforce immutability (Test 5).
// This test documents the architectural boundary.

test("R17.9L.21 T9: deterministic address verification is orchestrator responsibility (boundary doc)", () => {

    const { coordinator, session } = harness();

    coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS_1);

    assert.doesNotMatch(COORDINATOR_SOURCE, /buildDepositStateInit/);
    assert.doesNotMatch(SESSION_SOURCE, /buildDepositStateInit/);
    assert.doesNotMatch(COORDINATOR_SOURCE, /contractAddress\(/);

    assert.throws(
        () => coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS_2),
        InvalidDepositAddressError
    );

});

// --- Test 10: cross-session isolation ---

test("R17.9L.21 T10: cross-session isolation", () => {

    const eventBus = new EventBus(EB_OPTS);
    const persistence = new InMemoryDepositPersistence();

    const coordinator = new DepositSessionCoordinator({ eventBus, persistence });

    const sessionA = coordinator.createSession({ roomId: "room-a21", gameId: "game-a21" });
    coordinator.bindPlayers(sessionA.depositId, threePlayers());
    coordinator.markAwaitingFunds(sessionA.depositId);

    const sessionB = coordinator.createSession({ roomId: "room-b21", gameId: "game-b21" });
    coordinator.bindPlayers(sessionB.depositId, threePlayers());
    coordinator.markAwaitingFunds(sessionB.depositId);

    coordinator.setDepositAddress(sessionA.depositId, DEPOSIT_ADDRESS_1);
    coordinator.setDepositAddress(sessionB.depositId, DEPOSIT_ADDRESS_2);

    assert.equal(sessionA.depositAddress, canonicalizeTonWalletAddress(DEPOSIT_ADDRESS_1));
    assert.equal(sessionB.depositAddress, canonicalizeTonWalletAddress(DEPOSIT_ADDRESS_2));

    assert.throws(
        () => coordinator.setDepositAddress(sessionA.depositId, DEPOSIT_ADDRESS_2),
        InvalidDepositAddressError
    );

    assert.throws(
        () => coordinator.setDepositAddress(sessionB.depositId, DEPOSIT_ADDRESS_1),
        InvalidDepositAddressError
    );

});

// --- Test 11: recovery mismatch → fail closed ---

test("R17.9L.21 T11: recovery preserves address; mismatch rejected at domain level", () => {

    const { coordinator, persistence, session } = harness();

    coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS_1);

    const coordinator2 = new DepositSessionCoordinator({
        eventBus: new EventBus(EB_OPTS),
        persistence
    });

    coordinator2.restoreFromPersistence(session.depositId);

    const restored = coordinator2.getSession(session.depositId);

    assert.equal(restored.depositAddress, canonicalizeTonWalletAddress(DEPOSIT_ADDRESS_1));

    assert.throws(
        () => coordinator2.setDepositAddress(restored.depositId, DEPOSIT_ADDRESS_2),
        InvalidDepositAddressError
    );

});

test("R17.9L.21 T11b: invalid persisted address fails closed and is not restored", () => {

    const { coordinator, persistence, session } = harness();

    coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS_1);

    const original = persistence.loadDepositSession(session.depositId);

    persistence._byId.set(session.depositId, {
        ...original,
        payload: {
            ...original.payload,
            depositAddress: "not-an-address"
        }
    });

    const coordinator2 = new DepositSessionCoordinator({
        eventBus: new EventBus(EB_OPTS),
        persistence
    });

    assert.throws(
        () => coordinator2.restoreFromPersistence(session.depositId),
        InvalidDepositAddressError
    );

    assert.equal(coordinator2.getSession(session.depositId), null);

    const summary = coordinator2.restoreActiveSessions();

    assert.equal(summary.failed, 1);
    assert.equal(summary.restored, 0);
    assert.equal(coordinator2.getSession(session.depositId), null);

    const stillOnDisk = persistence.loadDepositSession(session.depositId);

    assert.equal(stillOnDisk.payload.depositAddress, "not-an-address");

});

// --- Test 12: financial isolation ---

test("R17.9L.21 T12: setDepositAddress triggers no financial operations", () => {

    const { coordinator, session, eventBus } = harness();

    const financialEvents = [];

    for (const type of [
        EVENT_TYPES.DEPOSIT_FULL,
        EVENT_TYPES.DEPOSIT_FULL_ONCHAIN,
        EVENT_TYPES.DEPOSIT_SEAT_FUNDED,
        EVENT_TYPES.GAME_STARTED,
        EVENT_TYPES.GAME_CREATED
    ]) {

        eventBus.subscribe(type, (e) => financialEvents.push({ type, ...e }));

    }

    coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS_1);

    assert.equal(financialEvents.length, 0);

    assert.doesNotMatch(COORDINATOR_SOURCE, /broadcastTransaction/);
    assert.doesNotMatch(SESSION_SOURCE, /broadcastTransaction/);
    assert.doesNotMatch(COORDINATOR_SOURCE, /GameContractManager/);
    assert.doesNotMatch(SESSION_SOURCE, /GameContractManager/);
    assert.doesNotMatch(COORDINATOR_SOURCE, /DeploymentAuthorization/);
    assert.doesNotMatch(SESSION_SOURCE, /DeploymentAuthorization/);
    assert.doesNotMatch(COORDINATOR_SOURCE, /startWatching/);
    assert.doesNotMatch(COORDINATOR_SOURCE, /executeDepositTestnetDeploy/);

});

// --- Test 13: depositAddress null before assignment ---

test("R17.9L.21 T13: depositAddress is null before assignment", () => {

    const eventBus = new EventBus(EB_OPTS);
    const persistence = new InMemoryDepositPersistence();

    const coordinator = new DepositSessionCoordinator({ eventBus, persistence });

    const session = coordinator.createSession({ roomId: "room-null", gameId: "game-null" });

    assert.equal(session.depositAddress, null);

    const record = persistence.loadDepositSession(session.depositId);
    assert.equal(record.payload.depositAddress, null);

});

test("R17.9L.21 T14: external mutation of depositAddress is rejected", () => {

    const { session } = harness();

    assert.throws(
        () => {
            session.depositAddress = DEPOSIT_ADDRESS_1;
        },
        TypeError
    );

    assert.equal(session.depositAddress, null);

});

test("R17.9L.21 T15: restore does not rewrite a valid persisted canonical address", () => {

    const { coordinator, persistence, session } = harness();

    coordinator.setDepositAddress(session.depositId, DEPOSIT_ADDRESS_1);

    const before = persistence.loadDepositSession(session.depositId).payload.depositAddress;

    const coordinator2 = new DepositSessionCoordinator({
        eventBus: new EventBus(EB_OPTS),
        persistence
    });

    coordinator2.restoreActiveSessions();

    const restored = coordinator2.getSession(session.depositId);
    const after = persistence.loadDepositSession(session.depositId).payload.depositAddress;

    assert.equal(restored.depositAddress, before);
    assert.equal(after, before);

});
