/**
 * Active Room Wallet polling — the RoomWalletIncomingObserver polls ONLY the
 * Room Wallets assigned to currently in-progress Payment Sessions.
 *
 * Proves:
 *   A/D  zero active sessions → zero TonCenter getTransactions calls
 *        (even with a full 64-wallet catalog configured);
 *   B/C  1..N active sessions → exactly their assigned Room Wallets polled;
 *   E    legacy recovered session without persisted roomWalletAddress is
 *        resolved through the authoritative roomNumber → registry mapping;
 *   F    terminal sessions are not polled;
 *   G    restored active sessions resume polling their assigned wallet;
 *   H    Room-Wallet-only mode does not create a second BlockchainMonitor
 *        room poller for the same Room Wallet (legacy path still does);
 *   I    PAYMENT_TRANSACTION_CONFIRMED still reaches PaymentSessionManager;
 *   J    simultaneous rooms stay isolated by roomNumber / roomWalletAddress;
 *   K    legacy fully-paid game with a persisted gameplay checkpoint is never
 *        misclassified as a setup-expiry refund after restart;
 *   L    GAME_INITIALIZED is durably marked even if the gameplay checkpoint
 *        has not yet been written;
 *   M    expired fully-paid setup session with no gameplay evidence remains
 *        eligible for the legitimate Room Wallet refund path.
 *
 * Mocked TON transactions only. No TESTNET/MAINNET funds.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../models/PaymentSession.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { EntryPaymentAuditLedger } from "../payment/BlockchainMonitor.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import { RoomWalletLedgerRegistry } from "../payment/roomWallet/RoomWalletLedger.js";
import { RoomWalletIncomingObserver } from "../payment/roomWallet/RoomWalletIncomingObserver.js";
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
        warn() {},
        error() {},
        debug() {},
        decisionTrace() {}
    };
}

function inboundTx({
    hash,
    from,
    to,
    nanoton,
    comment = "",
    lt = "100",
    amountIsGram = false,
    aborted = false,
    utime = null
}) {
    return {
        transaction_id: { hash, lt },
        aborted,
        ...(utime != null ? { utime } : {}),
        in_msg: {
            source: from,
            destination: to,
            value: String(nanoton),
            message: comment,
            amountIsGram
        }
    };
}

function threePlayers(prefix) {
    return [
        { playerId: `${prefix}-p1`, wallet: friendlyAddress(`${prefix}-p1`) },
        { playerId: `${prefix}-p2`, wallet: friendlyAddress(`${prefix}-p2`) },
        { playerId: `${prefix}-p3`, wallet: friendlyAddress(`${prefix}-p3`) }
    ];
}

function catalog64() {
    return Array.from({ length: 64 }, (_, index) => ({
        roomNumber: index + 1,
        address: friendlyAddress(`active-poll-catalog-${index + 1}`)
    }));
}

function createRecordingTransport({ transactionsByAddress = {} } = {}) {
    const calls = [];
    return {
        calls,
        async getTransactions(address, query) {
            calls.push({ address, query });
            return transactionsByAddress[address] ?? [];
        }
    };
}

function createHarness({
    rooms = [],
    registryEntries = [],
    transport = null,
    dataDir = null,
    durationMs = 60_000
} = {}) {
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const persistence = dataDir
        ? new TonFinancialPersistence({ dataDir, logger })
        : new TonFinancialPersistence({
            dataDir: mkdtempSync(join(tmpdir(), "ww-active-poll-")),
            logger
        });
    persistence.initialize();

    const identities = new Map();
    const wallets = new Map();
    const roomsById = new Map();

    for (const room of rooms) {
        roomsById.set(room.roomId, room);
        for (const player of room.players) {
            identities.set(player.playerId, {
                baseStake: player.baseStake ?? 1,
                sectorCount: player.sectorCount ?? 1
            });
            wallets.set(`${room.roomId}:${player.playerId}`, player.wallet);
        }
    }

    const roomManager = {
        getRoom(roomId) {
            const room = roomsById.get(roomId);
            return room
                ? {
                    players: room.players.map((player) => player.playerId),
                    roomId: room.roomId,
                    roomNumber: room.roomNumber ?? null
                }
                : null;
        },
        resolveRoomNumber(roomId) {
            return roomsById.get(roomId)?.roomNumber ?? null;
        }
    };

    const manager = new PaymentSessionManager({
        logger,
        eventBus,
        playerManager: {
            getIdentity(playerId) {
                return identities.get(playerId) ?? null;
            }
        },
        roomManager,
        roomConfig: { paymentSessionDurationMs: durationMs },
        gameplayContextResolver: {
            resolveGameIdByRoomId(roomId) {
                return roomsById.get(roomId)?.gameId ?? null;
            }
        },
        sessionWalletStore: {
            getWallet(roomId, playerId) {
                return wallets.get(`${roomId}:${playerId}`) ?? null;
            }
        },
        financialPersistence: persistence,
        durationMs
    });

    manager.initialize();

    const registry = new RoomWalletRegistry({ entries: registryEntries });
    const ledgerRegistry = new RoomWalletLedgerRegistry();
    const auditLedger = new EntryPaymentAuditLedger();

    manager.setRoomWalletFinance({
        registry,
        roomWalletPaymentIntakeEnabled: true
    });

    const observer = new RoomWalletIncomingObserver({
        logger,
        eventBus,
        paymentSessionManager: manager,
        financialPersistence: persistence,
        registry,
        roomManager,
        ledgerRegistry,
        transport,
        auditLedger,
        network: "testnet"
    });

    for (const room of rooms) {
        manager.createPaymentSession(room.roomId, {
            gameId: room.gameId,
            network: "testnet"
        });
    }

    return {
        logger,
        eventBus,
        manager,
        persistence,
        roomManager,
        registry,
        observer,
        auditLedger,
        ledgerRegistry,
        transport
    };
}

function finish(harness) {
    harness?.observer?.stop?.();
    harness?.manager?.shutdown?.();
    harness?.persistence?.shutdown?.({ checkpoint: false });
    harness?.eventBus?.shutdown?.();
}

function polledAddresses(transport) {
    return transport.calls.map((call) => call.address).sort();
}

test("A: no active payment sessions performs zero getTransactions calls", async (t) => {
    const transport = createRecordingTransport();
    const harness = createHarness({
        t,
        registryEntries: [
            { roomNumber: 1, address: friendlyAddress("rw-a-1") },
            { roomNumber: 2, address: friendlyAddress("rw-a-2") }
        ],
        rooms: [],
        transport
    });
    t.after(() => finish(harness));

    const result = await harness.observer.poll();

    assert.equal(transport.calls.length, 0);
    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, "no_active_payment_sessions");
    assert.equal(result.polled, 0);
    assert.equal(result.activeSessions, 0);
    assert.equal(result.walletsPolled, 0);

    // Repeated idle cycles stay free of RPC traffic.
    const second = await harness.observer.poll();
    assert.equal(transport.calls.length, 0);
    assert.equal(second.skipReason, "no_active_payment_sessions");
});

test("B: one active session polls exactly its assigned Room Wallet", async (t) => {
    const entries = catalog64();
    const wallet17 = entries[16].address;
    const transport = createRecordingTransport();
    const harness = createHarness({
        t,
        registryEntries: entries,
        rooms: [{
            roomId: "Keah",
            roomNumber: 17,
            gameId: "game-b",
            players: threePlayers("b")
        }],
        transport
    });
    t.after(() => finish(harness));

    const session = harness.manager.getSession("Keah");
    assert.equal(session.roomWalletAddress, wallet17);

    const result = await harness.observer.poll();

    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].address, wallet17);
    assert.equal(result.skipped, false);
    assert.equal(result.activeSessions, 1);
    assert.equal(result.walletsPolled, 1);
    assert.equal(result.polled, 1);

    // No unrelated catalog wallet is polled on the next cycle either.
    await harness.observer.poll();
    assert.equal(transport.calls.length, 2);
    assert.deepEqual([...new Set(polledAddresses(transport))], [wallet17]);
});

test("C: two active sessions poll exactly their two Room Wallets", async (t) => {
    const entries = catalog64();
    const wallet3 = entries[2].address;
    const wallet41 = entries[40].address;
    const transport = createRecordingTransport();
    const harness = createHarness({
        t,
        registryEntries: entries,
        rooms: [
            {
                roomId: "ROOA",
                roomNumber: 3,
                gameId: "game-c-a",
                players: threePlayers("c-a")
            },
            {
                roomId: "ROOB",
                roomNumber: 41,
                gameId: "game-c-b",
                players: threePlayers("c-b")
            }
        ],
        transport
    });
    t.after(() => finish(harness));

    assert.equal(harness.manager.getSession("ROOA").roomWalletAddress, wallet3);
    assert.equal(harness.manager.getSession("ROOB").roomWalletAddress, wallet41);

    const result = await harness.observer.poll();

    assert.equal(transport.calls.length, 2);
    assert.deepEqual(polledAddresses(transport), [wallet3, wallet41].sort());
    assert.equal(result.activeSessions, 2);
    assert.equal(result.walletsPolled, 2);
});

test("D: full 64-wallet catalog with zero active sessions polls nothing", async (t) => {
    const transport = createRecordingTransport();
    const harness = createHarness({
        t,
        registryEntries: catalog64(),
        rooms: [],
        transport
    });
    t.after(() => finish(harness));

    assert.equal(harness.registry.size(), 64);

    for (let cycle = 0; cycle < 3; cycle += 1) {
        const result = await harness.observer.poll();
        assert.equal(result.skipReason, "no_active_payment_sessions");
    }

    assert.equal(transport.calls.length, 0);
});

test("E: legacy recovered session without persisted wallet resolves via roomNumber", async (t) => {
    const entries = catalog64();
    const wallet17 = entries[16].address;
    const transport = createRecordingTransport();
    const harness = createHarness({
        t,
        registryEntries: entries,
        rooms: [{
            roomId: "LGXY",
            roomNumber: 17,
            gameId: "game-e",
            players: threePlayers("e")
        }],
        transport
    });
    t.after(() => finish(harness));

    // Simulate a legacy/recovered persisted session without roomWalletAddress.
    const session = harness.manager.getSession("LGXY");
    assert.equal(session.roomWalletAddress, wallet17);
    session.roomWalletAddress = null;

    const result = await harness.observer.poll();

    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].address, wallet17);
    assert.equal(result.activeSessions, 1);
    assert.equal(result.walletsPolled, 1);
});

test("F: terminal (completed) session is not polled", async (t) => {
    const entries = catalog64();
    const transport = createRecordingTransport();
    const harness = createHarness({
        t,
        registryEntries: entries,
        rooms: [{
            roomId: "TRMN",
            roomNumber: 9,
            gameId: "game-f",
            players: threePlayers("f")
        }],
        transport
    });
    t.after(() => finish(harness));

    const session = harness.manager.getSession("TRMN");

    for (const participant of session.participants) {
        harness.manager.confirmBlockchainPayment("TRMN", participant.playerId, {
            txHash: `tx-f-${participant.playerId}`
        });
    }

    assert.equal(session.status, PAYMENT_SESSION_STATUS.FULLY_PAID);
    assert.equal(session.isInProgress(), false);

    const result = await harness.observer.poll();

    assert.equal(transport.calls.length, 0);
    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, "no_active_payment_sessions");
    assert.equal(result.activeSessions, 0);
    assert.equal(result.walletsPolled, 0);
});

test("G: restored active PaymentSession resumes polling its assigned wallet", async (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), "ww-active-poll-restart-"));
    const entries = catalog64();
    const wallet23 = entries[22].address;
    const players = threePlayers("g");

    const first = createHarness({
        registryEntries: entries,
        rooms: [{
            roomId: "RSTG",
            roomNumber: 23,
            gameId: "game-g",
            players
        }],
        transport: createRecordingTransport(),
        dataDir
    });
    first.manager.shutdown();
    first.persistence.shutdown({ checkpoint: false });
    first.eventBus.shutdown();

    const second = createHarness({
        registryEntries: entries,
        rooms: [],
        transport: createRecordingTransport(),
        dataDir
    });
    t.after(() => {
        finish(second);
        TonFinancialPersistence.destroyStorage(dataDir);
    });

    await second.manager.restorePaymentSessions();

    const restored = second.manager.getSession("RSTG");
    assert.ok(restored);
    assert.equal(restored.isInProgress(), true);
    assert.equal(restored.roomWalletAddress, wallet23);

    const result = await second.observer.poll();

    assert.equal(second.transport.calls.length, 1);
    assert.equal(second.transport.calls[0].address, wallet23);
    assert.equal(result.skipped, false);
    assert.equal(result.activeSessions, 1);
    assert.equal(result.walletsPolled, 1);
});

test("K: historical fully-paid gameplay checkpoint blocks startup refunds", async (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), "ww-paid-game-refund-guard-k-"));
    const entries = catalog64();
    const players = threePlayers("k");
    const roomId = "RGK1";
    const gameId = "game-k-paid-and-played";
    const room = {
        roomId,
        roomNumber: 23,
        gameId,
        players
    };

    const first = createHarness({
        registryEntries: entries,
        rooms: [room],
        transport: createRecordingTransport(),
        dataDir
    });

    const originalSession = first.manager.getSession(roomId);
    for (const participant of originalSession.participants) {
        first.manager.confirmBlockchainPayment(roomId, participant.playerId, {
            txHash: `tx-k-${participant.playerId}`
        });
    }
    assert.equal(originalSession.status, PAYMENT_SESSION_STATUS.FULLY_PAID);

    finish(first);

    const second = createHarness({
        registryEntries: entries,
        rooms: [],
        transport: createRecordingTransport(),
        dataDir
    });
    t.after(() => {
        finish(second);
        TonFinancialPersistence.destroyStorage(dataDir);
    });

    // Models a legacy successful game: the pre-marker PaymentSession remains
    // FULLY_PAID, but the durable gameplay recovery record proves it initialized.
    const originalLoader = second.persistence.loadRecoveryDataRecord.bind(second.persistence);
    second.persistence.loadRecoveryDataRecord = (recordId) => (
        recordId === gameId
            ? { recordId: gameId, status: "TERMINAL", payload: { gameState: "RESULT" } }
            : originalLoader(recordId)
    );

    const refundCalls = [];
    second.manager.setRoomWalletFinance({
        settlementAdapter: {
            async refundPayments(request) {
                refundCalls.push(request);
                return { ok: false, retryable: true, code: "TEST_SHOULD_NOT_REFUND" };
            }
        }
    });

    const summary = await second.manager.restorePaymentSessions();

    assert.equal(summary.restored, 0, "terminal paid gameplay must not be restored as a refund candidate");
    assert.equal(second.manager.getSession(roomId), null);
    assert.equal(refundCalls.length, 0, "a successful game's three stakes must never be automatically refunded");
});

test("L: GAME_INITIALIZED marker blocks refund if checkpoint write has not happened yet", async (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), "ww-paid-game-refund-guard-l-"));
    const entries = catalog64();
    const players = threePlayers("l");
    const roomId = "RGL1";
    const gameId = "game-l-initialized";
    const room = {
        roomId,
        roomNumber: 24,
        gameId,
        players
    };

    const first = createHarness({
        registryEntries: entries,
        rooms: [room],
        transport: createRecordingTransport(),
        dataDir
    });

    const originalSession = first.manager.getSession(roomId);
    for (const participant of originalSession.participants) {
        first.manager.confirmBlockchainPayment(roomId, participant.playerId, {
            txHash: `tx-l-${participant.playerId}`
        });
    }
    assert.equal(originalSession.status, PAYMENT_SESSION_STATUS.FULLY_PAID);

    first.eventBus.emit({
        source: "test",
        type: EVENT_TYPES.GAME_INITIALIZED,
        payload: { roomId, gameId }
    });

    const saved = first.persistence.loadPaymentSession(originalSession.paymentSessionId);
    assert.equal(saved.payload.recoveryMetadata.gameplayInitializedGameId, gameId);

    finish(first);

    const second = createHarness({
        registryEntries: entries,
        rooms: [],
        transport: createRecordingTransport(),
        dataDir
    });
    t.after(() => {
        finish(second);
        TonFinancialPersistence.destroyStorage(dataDir);
    });

    const refundCalls = [];
    second.manager.setRoomWalletFinance({
        settlementAdapter: {
            async refundPayments(request) {
                refundCalls.push(request);
                return { ok: false, retryable: true, code: "TEST_SHOULD_NOT_REFUND" };
            }
        }
    });

    const summary = await second.manager.restorePaymentSessions();

    assert.equal(summary.restored, 0, "GAME_INITIALIZED marker must prevent full-paid refund recovery");
    assert.equal(second.manager.getSession(roomId), null);
    assert.equal(refundCalls.length, 0);
});

test("M: expired pre-game FULLY_PAID session with no checkpoint remains refundable", async (t) => {
    const dataDir = mkdtempSync(join(tmpdir(), "ww-pre-game-refund-guard-m-"));
    const entries = catalog64();
    const players = threePlayers("m");
    const roomId = "RGM1";
    const gameId = "game-m-pre-game-expired";
    const room = {
        roomId,
        roomNumber: 25,
        gameId,
        players
    };

    const first = createHarness({
        registryEntries: entries,
        rooms: [room],
        transport: createRecordingTransport(),
        dataDir
    });

    const originalSession = first.manager.getSession(roomId);
    for (const participant of originalSession.participants) {
        first.manager.confirmBlockchainPayment(roomId, participant.playerId, {
            txHash: `tx-m-${participant.playerId}`
        });
    }
    assert.equal(originalSession.status, PAYMENT_SESSION_STATUS.FULLY_PAID);

    finish(first);

    const second = createHarness({
        registryEntries: entries,
        rooms: [],
        transport: createRecordingTransport(),
        dataDir
    });
    t.after(() => {
        finish(second);
        TonFinancialPersistence.destroyStorage(dataDir);
    });

    const refundCalls = [];
    second.manager.setRoomWalletFinance({
        settlementAdapter: {
            async refundPayments(request) {
                refundCalls.push(request);
                return {
                    ok: true,
                    results: request.refunds.map((refund) => ({
                        ok: true,
                        playerId: refund.playerId,
                        txHash: `mock-refund-${refund.playerId}`
                    }))
                };
            }
        }
    });

    // No RoomManager entry or recovery record leaves this legacy session on the
    // pre-game refund-recovery path; it must not be silently stranded.
    const summary = await second.manager.restorePaymentSessions();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(summary.restored, 1);
    assert.equal(refundCalls.length, 1, "legitimate pre-game refund recovery must remain enabled");
    assert.equal(refundCalls[0].roomNumber, 25);
    assert.equal(refundCalls[0].refunds.length, 3);
    assert.equal(
        second.manager.getSession(roomId).status,
        PAYMENT_SESSION_STATUS.CANCELLED,
        "mock-confirmed refunds finalize the expired setup session"
    );
});

function createWatchRecordingManager({
    eventBus,
    watches,
    intakeEnabled,
    wallet1,
    gameId
}) {
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
                        roomId: "room-1",
                        roomNumber: 1,
                        players: ["p1", "p2", "p3"]
                    }
                    : null;
            },
            resolveRoomNumber(roomId) {
                return roomId === "room-1" ? 1 : null;
            }
        },
        gameplayContextResolver: {
            resolveGameIdByRoomId(roomId) {
                return roomId === "room-1" ? gameId : null;
            }
        },
        sessionWalletStore: {
            getWallet(_roomId, playerId) {
                return friendlyAddress(`${gameId}-player-${playerId}`);
            }
        },
        blockchainMonitor: {
            // watchPayment is the only entry point that creates a per-room
            // TonCenter polling timer (BlockchainMonitor._ensurePoll).
            watchPayment(args) {
                watches.push(args);
            },
            unwatchPayment() {},
            stopRoom() {}
        }
    });

    manager.initialize();
    manager.setRoomWalletFinance({
        registry: new RoomWalletRegistry({
            entries: [{ roomNumber: 1, address: wallet1 }]
        }),
        roomWalletPaymentIntakeEnabled: intakeEnabled
    });

    return manager;
}

test("H: Room-Wallet-only mode never registers a second room poller", (t) => {
    const watches = [];
    const wallet1 = friendlyAddress("rw-h-1");
    const eventBus = new EventBus({
        logger: createLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const manager = createWatchRecordingManager({
        eventBus,
        watches,
        intakeEnabled: true,
        wallet1,
        gameId: "game-h"
    });
    t.after(() => {
        manager.shutdown();
        eventBus.shutdown();
    });

    const session = manager.createPaymentSession("room-1", { gameId: "game-h" });
    assert.equal(session.roomWalletAddress, wallet1);

    // Activation must not register BlockchainMonitor watches (existing guard).
    assert.equal(watches.length, 0);

    watches.length = 0;
    manager.submitPlayerConfirmation("room-1", "p1");

    // The fix: BLOCKCHAIN_PENDING no longer creates a second poller for the
    // same active Room Wallet in Room-Wallet-only mode.
    assert.equal(watches.length, 0);
});

test("H2: legacy non-RoomWallet path still registers payment watches", (t) => {
    const watches = [];
    const wallet1 = friendlyAddress("rw-h2-1");
    const eventBus = new EventBus({
        logger: createLogger(),
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const manager = createWatchRecordingManager({
        eventBus,
        watches,
        intakeEnabled: false,
        wallet1,
        gameId: "game-h2"
    });
    t.after(() => {
        manager.shutdown();
        eventBus.shutdown();
    });

    manager.createPaymentSession("room-1", { gameId: "game-h2" });

    watches.length = 0;
    manager.submitPlayerConfirmation("room-1", "p1");

    // Legacy watchPayment behavior is preserved for non-RoomWallet paths.
    assert.equal(watches.length, 1);
    assert.equal(watches[0].contractAddress, wallet1);
});

test("I: payment confirmation via poll still reaches PaymentSessionManager", async (t) => {
    const wallet5 = friendlyAddress("rw-i-5");
    const players = threePlayers("i");
    const tx = inboundTx({
        hash: "tx-i-poll-confirm",
        from: players[0].wallet,
        to: wallet5,
        nanoton: 1_000_000_000
    });
    const transport = createRecordingTransport({
        transactionsByAddress: { [wallet5]: [tx] }
    });
    const harness = createHarness({
        t,
        registryEntries: [{ roomNumber: 5, address: wallet5 }],
        rooms: [{
            roomId: "CNFM",
            roomNumber: 5,
            gameId: "game-i",
            players
        }],
        transport
    });
    t.after(() => finish(harness));

    const detected = [];
    const confirmed = [];
    harness.eventBus.subscribe(EVENT_TYPES.PAYMENT_TRANSACTION_DETECTED, (envelope) => {
        detected.push(envelope.payload);
    });
    harness.eventBus.subscribe(EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED, (envelope) => {
        confirmed.push(envelope.payload);
    });

    const result = await harness.observer.poll();

    assert.equal(transport.calls.length, 1);
    assert.equal(result.processed, 1);
    assert.equal(detected.length, 1);
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].roomId, "CNFM");
    assert.equal(confirmed[0].roomWalletAddress, wallet5);
    assert.equal(confirmed[0].sender, players[0].wallet);

    const participant = harness.manager
        .getSession("CNFM")
        .findParticipant(players[0].playerId);
    assert.equal(participant.status, PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED);
    assert.equal(participant.txHash, "tx-i-poll-confirm");
});

test("J: simultaneous rooms stay isolated by roomWalletAddress", async (t) => {
    const entries = catalog64();
    const wallet3 = entries[2].address;
    const wallet41 = entries[40].address;
    const playersA = threePlayers("j-a");
    const playersB = threePlayers("j-b");
    const transport = createRecordingTransport({
        transactionsByAddress: {
            [wallet3]: [inboundTx({
                hash: "tx-j-room-a",
                from: playersA[0].wallet,
                to: wallet3,
                nanoton: 1_000_000_000
            })]
        }
    });
    const harness = createHarness({
        t,
        registryEntries: entries,
        rooms: [
            {
                roomId: "ISLA",
                roomNumber: 3,
                gameId: "game-j-a",
                players: playersA
            },
            {
                roomId: "ISLB",
                roomNumber: 41,
                gameId: "game-j-b",
                players: playersB
            }
        ],
        transport
    });
    t.after(() => finish(harness));

    const confirmed = [];
    harness.eventBus.subscribe(EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED, (envelope) => {
        confirmed.push(envelope.payload);
    });

    await harness.observer.poll();

    // Room A credited; Room B untouched.
    assert.deepEqual(confirmed.map((payload) => payload.roomId), ["ISLA"]);
    const sessionA = harness.manager.getSession("ISLA");
    const sessionB = harness.manager.getSession("ISLB");
    assert.equal(
        sessionA.findParticipant(playersA[0].playerId).status,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    );
    for (const participant of sessionB.participants) {
        assert.notEqual(
            participant.status,
            PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
        );
    }

    // Cross-room isolation: a Room A sender paying Room B's wallet is rejected.
    const crossRoom = harness.observer.processTransaction(
        inboundTx({
            hash: "tx-j-cross",
            from: playersA[1].wallet,
            to: wallet41,
            nanoton: 1_000_000_000
        }),
        wallet41
    );
    assert.equal(crossRoom.credited, false);
    assert.equal(crossRoom.reason, "wrong_destination");
    assert.equal(
        sessionB.findParticipant(playersB[0].playerId).status,
        PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
    );
});





