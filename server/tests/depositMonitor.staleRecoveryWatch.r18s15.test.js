/**
 * R18-S15 — Stale recovered Deposit watches must not consume TonCenter
 * polling capacity when their RoomManager room is no longer live.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DepositActivationVerificationCoordinator } from "../deposit/DepositActivationVerificationCoordinator.js";
import { DepositMonitor } from "../deposit/DepositMonitor.js";
import { FakeDepositBlockchainSource } from "../deposit/FakeDepositBlockchainSource.js";
import { DepositSessionCoordinator } from "../deposit/DepositSessionCoordinator.js";
import { DEPOSIT_SESSION_STATUS } from "../deposit/DepositSessionStates.js";
import {
    RealTonDepositBlockchainSource
} from "../deposit/RealTonDepositBlockchainSource.js";
import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";

const STALE_ROOM = "room-stale-recovery";
const LIVE_ROOM = "room-live-recovery";
const STALE_ADDRESS = "EQAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBMWg";
const LIVE_ADDRESS = "EQAFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBccf";

function createLogger() {

    return {
        info() {},
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {}
    };

}

function threePlayers() {

    return [
        { playerId: "p1", wallet: "EQ_wallet_1", expectedAmount: 10 },
        { playerId: "p2", wallet: "EQ_wallet_2", expectedAmount: 10 },
        { playerId: "p3", wallet: "EQ_wallet_3", expectedAmount: 10 }
    ];

}

function createEventBus() {

    const eventBus = new EventBus({
        logger: createLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    return eventBus;

}

function createWatchableSession(coordinator, {
    roomId,
    gameId,
    depositAddress
}) {

    const session = coordinator.createSession({ roomId, gameId });

    coordinator.bindPlayers(session.depositId, threePlayers());
    coordinator.markAwaitingFunds(session.depositId);
    coordinator.setDepositAddress(session.depositId, depositAddress);

    return coordinator.getSession(session.depositId);

}

class SpyPollSource {

    constructor() {

        this.polls = [];

    }

    async poll(watches = []) {

        this.polls.push((watches ?? []).map((watch) => watch.depositId));

        return Object.freeze({
            observed: 0,
            skipped: 0,
            failed: 0,
            results: Object.freeze([])
        });

    }

}

function createMonitor({ roomManager = null, blockchainSource = null } = {}) {

    const eventBus = createEventBus();
    const depositSessionCoordinator = new DepositSessionCoordinator({ eventBus });
    const source = blockchainSource ?? new SpyPollSource();

    const monitor = new DepositMonitor({
        logger: createLogger(),
        eventBus,
        depositSessionCoordinator,
        blockchainSource: source,
        network: "testnet",
        roomManager
    });

    monitor.initialize();

    return {
        eventBus,
        depositSessionCoordinator,
        source,
        monitor
    };

}

test("R18-S15 Test A: recovered deposit for a dead room is not continuously polled", async () => {

    const { monitor, depositSessionCoordinator, source } = createMonitor({
        roomManager: {
            getRoom() {

                return null;

            }
        }
    });

    const session = createWatchableSession(depositSessionCoordinator, {
        roomId: STALE_ROOM,
        gameId: "game-stale",
        depositAddress: STALE_ADDRESS
    });

    const restored = monitor.restoreActiveWatches();

    assert.equal(restored.restored, 0);
    assert.ok(restored.skipped >= 1);
    assert.equal(monitor.listActiveWatches().length, 0);

    monitor.startWatching(session);

    assert.equal(monitor.listActiveWatches().length, 1);

    await monitor.poll();
    await monitor.poll();

    assert.equal(monitor.listActiveWatches().length, 0);
    assert.equal(source.polls.length, 2);
    assert.deepEqual(source.polls[0], []);
    assert.deepEqual(source.polls[1], []);

});

test("R18-S15 Test B: recovered deposit for a live room remains eligible for polling", async () => {

    const { monitor, depositSessionCoordinator, source } = createMonitor({
        roomManager: {
            getRoom(roomId) {

                return roomId === LIVE_ROOM ? { roomId } : null;

            }
        }
    });

    const session = createWatchableSession(depositSessionCoordinator, {
        roomId: LIVE_ROOM,
        gameId: "game-live",
        depositAddress: LIVE_ADDRESS
    });

    const restored = monitor.restoreActiveWatches();

    assert.equal(restored.restored, 1);
    assert.equal(monitor.listActiveWatches().length, 1);
    assert.equal(monitor.listActiveWatches()[0].depositId, session.depositId);

    await monitor.poll();
    await monitor.poll();

    assert.equal(monitor.listActiveWatches().length, 1);
    assert.deepEqual(source.polls[0], [session.depositId]);
    assert.deepEqual(source.polls[1], [session.depositId]);

});

test("R18-S15 Test C: live deposit polling is not blocked by a stale recovery watch", async () => {

    const { monitor, depositSessionCoordinator, source } = createMonitor({
        roomManager: {
            getRoom(roomId) {

                return roomId === LIVE_ROOM ? { roomId } : null;

            }
        }
    });

    const stale = createWatchableSession(depositSessionCoordinator, {
        roomId: STALE_ROOM,
        gameId: "game-stale",
        depositAddress: STALE_ADDRESS
    });

    const live = createWatchableSession(depositSessionCoordinator, {
        roomId: LIVE_ROOM,
        gameId: "game-live",
        depositAddress: LIVE_ADDRESS
    });

    monitor.startWatching(stale);
    monitor.startWatching(live);

    assert.equal(monitor.listActiveWatches().length, 2);

    await monitor.poll();

    const remaining = monitor.listActiveWatches();

    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].depositId, live.depositId);
    assert.deepEqual(source.polls[0], [live.depositId]);

});

test("R18-S15 Test E: live deposit still reaches DEPOSIT_FULL_ONCHAIN", () => {

    const eventBus = createEventBus();
    const depositSessionCoordinator = new DepositSessionCoordinator({ eventBus });
    const monitor = new DepositMonitor({
        logger: createLogger(),
        eventBus,
        depositSessionCoordinator,
        network: "testnet",
        roomManager: {
            getRoom(roomId) {

                return roomId === LIVE_ROOM ? { roomId } : null;

            }
        }
    });

    monitor.initialize();

    const source = new FakeDepositBlockchainSource({ monitor });
    const emitted = [];

    eventBus.subscribe(EVENT_TYPES.DEPOSIT_FULL_ONCHAIN, (envelope) => {

        emitted.push(envelope.payload);

    });

    const session = createWatchableSession(depositSessionCoordinator, {
        roomId: LIVE_ROOM,
        gameId: "game-live-full",
        depositAddress: LIVE_ADDRESS
    });

    monitor.startWatching(session);

    source.emitFullDeposit({
        depositId: session.depositId,
        depositAddress: session.depositAddress,
        players: threePlayers()
    });

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].depositId, session.depositId);

});

test("R18-S15: syncFromActiveSessions does not verify a dead-room recovered deposit", async () => {

    let verifyCalls = 0;

    const coordinator = new DepositActivationVerificationCoordinator({
        depositSessionCoordinator: {
            listActiveDepositSessions() {

                return [
                    {
                        depositId: "dep_stale_recovery",
                        depositAddress: STALE_ADDRESS,
                        roomId: STALE_ROOM,
                        state: DEPOSIT_SESSION_STATUS.AWAITING_FUNDS
                    }
                ];

            }
        },
        roomManager: {
            getRoom() {

                return null;

            }
        }
    });

    coordinator.verifyActivation = async () => {

        verifyCalls += 1;

        return { status: "VERIFIED" };

    };

    const summary = await coordinator.syncFromActiveSessions();

    assert.equal(summary.scanned, 1);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.verified, 0);
    assert.equal(verifyCalls, 0);

});

test("R18-S15: TonCenter 429 stops remaining watches in the same poll cycle", async () => {

    const addresses = [];

    const tonService = {
        getActiveNetwork() {

            return "testnet";

        },
        async getAccount(address) {

            addresses.push(address);

            const error = new Error("Request failed with status code 429");

            error.status = 429;

            throw error;

        },
        async getTransactions() {

            return [];

        },
        async runGetMethod() {

            return null;

        }
    };

    const source = new RealTonDepositBlockchainSource({
        logger: createLogger(),
        tonService,
        network: "testnet"
    });

    const result = await source.poll([
        {
            depositId: "dep_stale_recovery",
            depositAddress: STALE_ADDRESS,
            network: "testnet"
        },
        {
            depositId: "dep_live",
            depositAddress: LIVE_ADDRESS,
            network: "testnet"
        }
    ]);

    assert.equal(addresses.length, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].reason, "rate_limited");
    assert.equal(result.results.length, 1);

});
