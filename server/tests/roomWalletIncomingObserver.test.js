/**
 * Room Wallet incoming observer — attribution, validation, idempotency.
 * Mocked TON transactions only. No TESTNET funds.
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
import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    PAYMENT_CONFIRMATION_STATUS,
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../models/PaymentSession.js";
import {
    PAYMENT_ACCEPTANCE_CLOSING_WINDOW_MS,
    PaymentSessionManager
} from "../gameplay/PaymentSessionManager.js";
import {
    BlockchainMonitor,
    EntryPaymentAuditLedger,
    parseDepositCandidate
} from "../payment/BlockchainMonitor.js";
import { MockTonTransport } from "../payment/ton/MockTonTransport.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import { RoomWalletLedgerRegistry } from "../payment/roomWallet/RoomWalletLedger.js";
import {
    ROOM_WALLET_INCOMING_REJECTION_REASONS,
    RoomWalletIncomingObserver,
    nanotonToGram,
    resolveIntendedRoomWalletAddress,
    resolveAuthoritativeRoomNumber
} from "../payment/roomWallet/RoomWalletIncomingObserver.js";
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

function createPersistence() {
    const dataDir = mkdtempSync(join(tmpdir(), "ww-rwin-"));
    const persistence = new TonFinancialPersistence({ dataDir, logger: createLogger() });
    persistence.initialize();
    return { dataDir, persistence };
}

function createPaymentHarness({
    rooms,
    dataDir = null,
    durationMs = 60_000
}) {
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const persistence = dataDir
        ? (() => {
            const store = new TonFinancialPersistence({ dataDir, logger });
            store.initialize();
            return store;
        })()
        : createPersistence().persistence;

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

    return { logger, eventBus, manager, persistence, roomManager };
}

function threePlayers(prefix) {
    return [
        { playerId: `${prefix}-p1`, wallet: friendlyAddress(`${prefix}-p1`) },
        { playerId: `${prefix}-p2`, wallet: friendlyAddress(`${prefix}-p2`) },
        { playerId: `${prefix}-p3`, wallet: friendlyAddress(`${prefix}-p3`) }
    ];
}

function createObserverFixture({
    t = null,
    registryEntries,
    rooms,
    dataDir = null,
    durationMs = 60_000,
    transport = null,
    tonService = null,
    observerOptions = {}
} = {}) {
    const harness = createPaymentHarness({ rooms, dataDir, durationMs });
    const registry = new RoomWalletRegistry({ entries: registryEntries });
    const ledgerRegistry = new RoomWalletLedgerRegistry();
    const auditLedger = new EntryPaymentAuditLedger();

    // PAYMENT_CLOSING harness fix — production app.js wires the Room Wallet
    // registry into PaymentSessionManager via setRoomWalletFinance() before
    // any session is created (Room-Wallet-only intake). Without it
    // createPaymentSession fails closed ("Room Wallet address is required
    // for player payment").
    harness.manager.setRoomWalletFinance({
        registry,
        roomWalletPaymentIntakeEnabled: true
    });

    const observer = new RoomWalletIncomingObserver({
        logger: harness.logger,
        eventBus: harness.eventBus,
        paymentSessionManager: harness.manager,
        financialPersistence: harness.persistence,
        registry,
        roomManager: harness.roomManager,
        ledgerRegistry,
        transport,
        tonService,
        auditLedger,
        network: "testnet",
        ...observerOptions
    });

    for (const room of rooms) {
        harness.manager.createPaymentSession(room.roomId, {
            gameId: room.gameId,
            network: "testnet"
        });
    }

    const fixture = { ...harness, registry, observer, auditLedger, ledgerRegistry };
    t?.after?.(() => finish(fixture));
    return fixture;
}

function finish(harness) {
    harness?.observer?.stop?.();
    harness?.manager?.shutdown?.();
    harness?.persistence?.shutdown?.({ checkpoint: false });
    harness?.eventBus?.shutdown?.();
}

test("nanotonToGram matches parseDepositCandidate TonCenter convention", () => {
    assert.equal(nanotonToGram(1_000_000_000), 1);
    assert.equal(nanotonToGram(1_500_000_000), 1.5);

    const parsed = parseDepositCandidate(inboundTx({
        hash: "h1",
        from: friendlyAddress("from"),
        to: friendlyAddress("to"),
        nanoton: 1_000_000_000
    }));

    assert.equal(parsed.amountGram, 1);
    assert.equal(parsed.amountGram, nanotonToGram(1_000_000_000));
});

test("resolveIntendedRoomWalletAddress uses roomNumber and never Number(roomId)", () => {
    const address4 = friendlyAddress("rw-4");
    const address17 = friendlyAddress("rw-17");
    const registry = new RoomWalletRegistry({
        entries: [
            { roomNumber: 4, address: address4 },
            { roomNumber: 17, address: address17 }
        ]
    });

    assert.equal(resolveIntendedRoomWalletAddress({ roomId: "4" }, registry), null);
    assert.equal(resolveIntendedRoomWalletAddress({ roomId: "Keah" }, registry), null);
    assert.equal(resolveIntendedRoomWalletAddress("Keah", registry), null);
    assert.equal(resolveAuthoritativeRoomNumber({ roomId: "Keah" }), null);
    assert.equal(resolveIntendedRoomWalletAddress({ roomNumber: 17 }, registry), address17);
    assert.equal(resolveIntendedRoomWalletAddress({
        roomId: "Keah",
        roomManager: {
            getRoom(roomId) {
                return roomId === "Keah" ? { roomNumber: 17 } : null;
            }
        }
    }, registry), address17);
});

test("A-D valid Room Wallet payment attributes sender, game, and exact amount", (t) => {
    const roomWallet = friendlyAddress("rw-1");
    const players = threePlayers("a");
    const { observer, manager, eventBus } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "Keah", roomNumber: 1, gameId: "game-a", players }]
    });

    const confirmed = [];
    eventBus.subscribe(EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED, (envelope) => {
        confirmed.push(envelope.payload);
    });

    const result = observer.processTransaction(inboundTx({
        hash: "tx-valid",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000
    }), roomWallet);

    assert.equal(result.credited, true);
    assert.equal(result.playerId, players[0].playerId);
    assert.equal(result.roomId, "Keah");
    assert.equal(result.gameId, "game-a");
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].sender, players[0].wallet);
    assert.equal(confirmed[0].amount, 1);
    assert.equal(confirmed[0].roomWalletAddress, roomWallet);
    assert.equal(confirmed[0].destination, roomWallet);
    assert.equal("address" in confirmed[0] && confirmed[0].address != null, false);

    const session = manager.getSession("Keah");
    const participant = session.findParticipant(players[0].playerId);
    assert.equal(participant.status, PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED);
    assert.equal(participant.confirmationStatus, PAYMENT_CONFIRMATION_STATUS.CONFIRMED);
    assert.equal(participant.txHash, "tx-valid");
});

test("TonCenter bounce out_msg is not credited as a Room Wallet payment", (t) => {
    const roomWallet = friendlyAddress("rw-bounce");
    const players = threePlayers("bounce");
    const { observer, manager } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "RGFT", roomNumber: 1, gameId: "game-bounce", players }]
    });

    const bouncedTransaction = {
        ...inboundTx({
            hash: "tx-bounced-bob",
            from: players[0].wallet,
            to: roomWallet,
            nanoton: 1_000_000_000
        }),
        out_msgs: [{
            source: roomWallet,
            destination: players[0].wallet,
            value: "999933333",
            message: "/////w==\n"
        }]
    };

    const result = observer.processTransaction(bouncedTransaction, roomWallet);

    assert.equal(result.credited, false);
    assert.equal(
        result.reason,
        ROOM_WALLET_INCOMING_REJECTION_REASONS.FAILED_TRANSACTION
    );

    const repeat = observer.processTransaction(bouncedTransaction, roomWallet);
    assert.equal(repeat.credited, false);
    assert.equal(
        repeat.reason,
        ROOM_WALLET_INCOMING_REJECTION_REASONS.DUPLICATE_TRANSACTION
    );
    assert.equal(repeat.duplicate, true);

    const participant = manager.getSession("RGFT").findParticipant(players[0].playerId);
    assert.notEqual(participant.status, PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED);
});

test("E wrong amount is rejected and not credited", (t) => {
    const roomWallet = friendlyAddress("rw-e");
    const players = threePlayers("e");
    const { observer, manager } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "Keah", roomNumber: 1, gameId: "game-e", players }]
    });

    const result = observer.processTransaction(inboundTx({
        hash: "tx-wrong-amt",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 2_000_000_000
    }), roomWallet);

    assert.equal(result.credited, false);
    assert.equal(result.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.WRONG_AMOUNT);
    assert.notEqual(
        manager.getSession("Keah").findParticipant(players[0].playerId).status,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    );
});

test("F wrong destination is rejected", (t) => {
    const roomWallet = friendlyAddress("rw-f");
    const other = friendlyAddress("rw-other");
    const players = threePlayers("f");
    const { observer, manager } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "Keah", roomNumber: 1, gameId: "game-f", players }]
    });

    const result = observer.processTransaction(inboundTx({
        hash: "tx-wrong-dest",
        from: players[0].wallet,
        to: other,
        nanoton: 1_000_000_000
    }), other);

    assert.equal(result.credited, false);
    assert.equal(result.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.WRONG_DESTINATION);
    assert.notEqual(
        manager.getSession("Keah").findParticipant(players[0].playerId).status,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    );
});

test("G unknown sender is rejected without durable lock-out", (t) => {
    const roomWallet = friendlyAddress("rw-g");
    const players = threePlayers("g");
    const { observer, persistence } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "Keah", roomNumber: 1, gameId: "game-g", players }]
    });

    const unknown = friendlyAddress("stranger");
    const result = observer.processTransaction(inboundTx({
        hash: "tx-unknown",
        from: unknown,
        to: roomWallet,
        nanoton: 1_000_000_000
    }), roomWallet);

    assert.equal(result.credited, false);
    assert.equal(result.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.UNKNOWN_SENDER);

    assert.throws(() => persistence.loadAuditRecord(
        `rwin__${roomWallet}__tx-unknown`
    ));
});

test("H ambiguous attribution is not credited", (t) => {
    const roomWallet = friendlyAddress("rw-h");
    const shared = friendlyAddress("shared-sender");
    const room1Players = [
        { playerId: "h1-p1", wallet: shared },
        { playerId: "h1-p2", wallet: friendlyAddress("h1-p2") },
        { playerId: "h1-p3", wallet: friendlyAddress("h1-p3") }
    ];
    const room2Players = [
        { playerId: "h2-p1", wallet: shared },
        { playerId: "h2-p2", wallet: friendlyAddress("h2-p2") },
        { playerId: "h2-p3", wallet: friendlyAddress("h2-p3") }
    ];

    const { observer, manager } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [
            { roomId: "Keah", roomNumber: 1, gameId: "game-h1", players: room1Players },
            { roomId: "Abcd", roomNumber: 1, gameId: "game-h2", players: room2Players }
        ]
    });

    const result = observer.processTransaction(inboundTx({
        hash: "tx-ambiguous",
        from: shared,
        to: roomWallet,
        nanoton: 1_000_000_000
    }), roomWallet);

    assert.equal(result.credited, false);
    assert.equal(result.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.AMBIGUOUS_ATTRIBUTION);
    assert.notEqual(
        manager.getSession("Keah").findParticipant("h1-p1").status,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    );
    assert.notEqual(
        manager.getSession("Abcd").findParticipant("h2-p1").status,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
    );
});

test("I/J duplicate and repeated poll do not credit twice", async (t) => {
    const roomWallet = friendlyAddress("rw-ij");
    const players = threePlayers("ij");
    const transport = new MockTonTransport();
    const tx = inboundTx({
        hash: "tx-dup",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000
    });
    transport.seedTransactions(roomWallet, [tx]);

    const { observer, manager } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "Keah", roomNumber: 1, gameId: "game-ij", players }],
        transport
    });

    await observer.poll();
    await observer.poll();

    const participant = manager.getSession("Keah").findParticipant(players[0].playerId);
    assert.equal(participant.status, PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED);

    const second = observer.processTransaction(tx, roomWallet);
    assert.equal(second.credited, false);
    assert.equal(second.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.DUPLICATE_TRANSACTION);
    assert.equal(second.duplicate, true);
});

test("K two simultaneous games do not cross-credit", (t) => {
    const walletA = friendlyAddress("rw-k-a");
    const walletB = friendlyAddress("rw-k-b");
    const playersA = threePlayers("ka");
    const playersB = threePlayers("kb");
    const { observer, manager } = createObserverFixture({
        t,
        registryEntries: [
            { roomNumber: 1, address: walletA },
            { roomNumber: 2, address: walletB }
        ],
        rooms: [
            { roomId: "Ka01", roomNumber: 1, gameId: "game-ka", players: playersA },
            { roomId: "Kb02", roomNumber: 2, gameId: "game-kb", players: playersB }
        ]
    });

    const creditedB = observer.processTransaction(inboundTx({
        hash: "tx-kb",
        from: playersB[0].wallet,
        to: walletA,
        nanoton: 1_000_000_000
    }), walletA);

    assert.equal(creditedB.credited, false);
    assert.equal(creditedB.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.WRONG_DESTINATION);

    const creditedA = observer.processTransaction(inboundTx({
        hash: "tx-ka",
        from: playersA[0].wallet,
        to: walletA,
        nanoton: 1_000_000_000
    }), walletA);

    assert.equal(creditedA.credited, true);
    assert.equal(creditedA.roomId, "Ka01");
    // Room-Wallet intake activation (parity with app.js wiring) issues
    // payment requests for every seat: PAYMENT_REQUESTED →
    // AWAITING_PLAYER_CONFIRMATION. Game B's seats remain untouched by
    // game A's payment regardless of the issued-seat status.
    assert.equal(
        manager.getSession("Kb02").findParticipant(playersB[0].playerId).status,
        PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
    );
});

test("L/M reconnect and persistence restart keep attribution identity", (t) => {
    const roomWallet = friendlyAddress("rw-lm");
    const players = threePlayers("lm");
    const dataDir = mkdtempSync(join(tmpdir(), "ww-rwin-rst-"));

    const first = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "Keah", roomNumber: 1, gameId: "game-lm", players }],
        dataDir
    });

    const firstResult = first.observer.processTransaction(inboundTx({
        hash: "tx-restart",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000
    }), roomWallet);

    assert.equal(firstResult.credited, true);
    first.persistence.shutdown({ checkpoint: true });
    first.manager.shutdown();

    const restoredStore = new TonFinancialPersistence({ dataDir, logger: createLogger() });
    restoredStore.initialize();

    const restored = createPaymentHarness({
        rooms: [{ roomId: "Keah", roomNumber: 1, gameId: "game-lm", players }],
        dataDir
    });
    restored.manager.restorePaymentSessions();

    const restoredParticipant = restored.manager.getSession("Keah")
        .findParticipant(players[0].playerId);
    assert.equal(restoredParticipant.status, PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED);
    assert.equal(restoredParticipant.txHash, "tx-restart");

    const observer = new RoomWalletIncomingObserver({
        logger: restored.logger,
        eventBus: restored.eventBus,
        paymentSessionManager: restored.manager,
        financialPersistence: restoredStore,
        registry: new RoomWalletRegistry({
            entries: [{ roomNumber: 1, address: roomWallet }]
        }),
        roomManager: restored.roomManager,
        network: "testnet"
    });

    t.after(() => {
        observer.stop();
        restored.manager.shutdown();
        restored.persistence.shutdown({ checkpoint: false });
        restoredStore.shutdown({ checkpoint: false });
        restored.eventBus.shutdown();
    });

    const replay = observer.processTransaction(inboundTx({
        hash: "tx-restart",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000
    }), roomWallet);

    assert.equal(replay.credited, false);
    assert.equal(replay.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.DUPLICATE_TRANSACTION);
});

test("N PaymentSessionManager remains compatible with Room Wallet confirmation events", (t) => {
    const roomWallet = friendlyAddress("rw-n");
    const players = threePlayers("n");
    const { observer, manager, eventBus } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "Keah", roomNumber: 1, gameId: "game-n", players }]
    });

    const detected = [];
    eventBus.subscribe(EVENT_TYPES.PAYMENT_TRANSACTION_DETECTED, (envelope) => {
        detected.push(envelope);
    });

    observer.processTransaction(inboundTx({
        hash: "tx-n",
        from: players[1].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000
    }), roomWallet);

    assert.equal(detected.length, 1);
    assert.equal(detected[0].source, EVENT_SOURCES.ROOM_WALLET_INCOMING_OBSERVER);
    assert.equal(
        manager.getSession("Keah").findParticipant(players[1].playerId).confirmationStatus,
        PAYMENT_CONFIRMATION_STATUS.CONFIRMED
    );
    // All seats are activated to AWAITING_PLAYER_CONFIRMATION when payment
    // requests are issued; players[0] simply has not paid yet.
    assert.equal(
        manager.getSession("Keah").findParticipant(players[0].playerId).status,
        PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
    );
});

test("expired payment context is rejected", (t) => {
    const roomWallet = friendlyAddress("rw-exp");
    const players = threePlayers("exp");
    const { observer, manager } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "Keah", roomNumber: 1, gameId: "game-exp", players }],
        durationMs: 60_000
    });

    const session = manager.getSession("Keah");
    session.paymentDeadline = Date.now() - 1000;

    const result = observer.processTransaction(inboundTx({
        hash: "tx-exp",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000
    }), roomWallet);

    assert.equal(result.credited, false);
    assert.equal(result.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.EXPIRED_PAYMENT_CONTEXT);
});

test("missing sender / hash / persistence failure paths do not credit", (t) => {
    const roomWallet = friendlyAddress("rw-miss");
    const players = threePlayers("miss");
    const { observer } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "Keah", roomNumber: 1, gameId: "game-miss", players }]
    });

    assert.equal(observer.processTransaction({ in_msg: { destination: roomWallet, value: "1" } }, roomWallet).reason,
        ROOM_WALLET_INCOMING_REJECTION_REASONS.MISSING_TRANSACTION_HASH);

    assert.equal(observer.processTransaction(inboundTx({
        hash: "tx-no-from",
        from: "",
        to: roomWallet,
        nanoton: 1_000_000_000
    }), roomWallet).reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.MISSING_SENDER);

    const noStore = new RoomWalletIncomingObserver({
        logger: createLogger(),
        registry: new RoomWalletRegistry({
            entries: [{ roomNumber: 1, address: roomWallet }]
        }),
        paymentSessionManager: observer._paymentSessionManager,
        network: "testnet"
    });

    const noPersist = noStore.processTransaction(inboundTx({
        hash: "tx-np",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000
    }), roomWallet);

    assert.equal(noPersist.credited, false);
    assert.equal(noPersist.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.PERSISTENCE_UNAVAILABLE);
});

test("BlockchainMonitor global poll invokes Room Wallet incoming observer once per cycle", async (t) => {
    let polls = 0;
    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const monitor = new BlockchainMonitor({
        logger,
        eventBus,
        transport: new MockTonTransport(),
        auditLedger: new EntryPaymentAuditLedger(),
        pollIntervalMs: 50_000
    });
    monitor.initialize();
    monitor.setRoomWalletIncomingObserver({
        async poll() {
            polls += 1;
        }
    });

    await monitor.start();
    t.after(() => monitor.stop());
    assert.equal(polls, 1);
});

function wait(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function http429(message = "TonCenter HTTP 429") {
    const error = new Error(message);
    error.status = 429;
    return error;
}

test("traffic control: overlapping observer poll is skipped", async (t) => {
    const roomWallet = friendlyAddress("rw-overlap");
    let inFlight = 0;
    let maxInFlight = 0;
    let started = 0;

    const transport = {
        async getTransactions() {
            started += 1;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await wait(60);
            inFlight -= 1;
            return [];
        }
    };

    const { observer } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{
            roomId: "Ov01",
            roomNumber: 1,
            gameId: "game-ov",
            players: threePlayers("ov")
        }],
        transport,
        observerOptions: {
            walletsPerCycle: 1,
            maxConcurrency: 1,
            retryMaxAttempts: 1
        }
    });

    const first = observer.poll();
    const second = observer.poll();
    const [a, b] = await Promise.all([first, second]);

    assert.equal(maxInFlight, 1);
    assert.equal(started, 1);
    const skipped = [a, b].filter((result) => result.skipped === true);
    const ran = [a, b].filter((result) => result.skipped !== true);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].skipReason, "in_flight");
    assert.equal(ran.length, 1);
});

test("traffic control: getTransactions concurrency never exceeds maxConcurrency", async (t) => {
    const addresses = [
        friendlyAddress("rw-c1"),
        friendlyAddress("rw-c2"),
        friendlyAddress("rw-c3"),
        friendlyAddress("rw-c4")
    ];
    let inFlight = 0;
    let maxInFlight = 0;

    const transport = {
        async getTransactions() {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await wait(30);
            inFlight -= 1;
            return [];
        }
    };

    const { observer } = createObserverFixture({
        t,
        registryEntries: addresses.map((address, index) => ({
            roomNumber: index + 1,
            address
        })),
        rooms: addresses.map((address, index) => ({
            roomId: `C${index + 1}`,
            roomNumber: index + 1,
            gameId: `game-c${index + 1}`,
            players: threePlayers(`c${index + 1}`)
        })),
        transport,
        observerOptions: {
            walletsPerCycle: 4,
            maxConcurrency: 2,
            retryMaxAttempts: 1
        }
    });

    await observer.poll();
    assert.ok(maxInFlight <= 2, `maxInFlight=${maxInFlight}`);
    assert.equal(maxInFlight, 2);
});

test("traffic control: 429 retries are bounded and delayed without overlapping polls", async (t) => {
    const roomWallet = friendlyAddress("rw-429");
    const delays = [];
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;

    const transport = {
        async getTransactions() {
            calls += 1;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            inFlight -= 1;
            throw http429();
        }
    };

    const { observer } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{
            roomId: "R429",
            roomNumber: 1,
            gameId: "game-429",
            players: threePlayers("r429")
        }],
        transport,
        observerOptions: {
            walletsPerCycle: 1,
            maxConcurrency: 1,
            retryMaxAttempts: 2,
            retryDelayMs: 400,
            delay: async (ms) => {
                delays.push(ms);
            }
        }
    });

    const first = observer.poll();
    const second = observer.poll();
    await Promise.all([first, second]);

    assert.equal(calls, 2);
    assert.deepEqual(delays, [400]);
    assert.equal(maxInFlight, 1);
});

test("traffic control: one failing wallet does not block other wallets", async (t) => {
    const failing = friendlyAddress("rw-fail");
    const okA = friendlyAddress("rw-ok-a");
    const okB = friendlyAddress("rw-ok-b");
    const calls = new Map();

    const transport = {
        async getTransactions(address) {
            calls.set(address, (calls.get(address) ?? 0) + 1);
            if (address === failing) {
                throw http429();
            }
            return [];
        }
    };

    const { observer } = createObserverFixture({
        t,
        registryEntries: [
            { roomNumber: 1, address: failing },
            { roomNumber: 2, address: okA },
            { roomNumber: 3, address: okB }
        ],
        rooms: [
            { roomId: "F1", roomNumber: 1, gameId: "game-f1", players: threePlayers("f1") },
            { roomId: "F2", roomNumber: 2, gameId: "game-f2", players: threePlayers("f2") },
            { roomId: "F3", roomNumber: 3, gameId: "game-f3", players: threePlayers("f3") }
        ],
        transport,
        observerOptions: {
            walletsPerCycle: 3,
            maxConcurrency: 1,
            retryMaxAttempts: 2,
            retryDelayMs: 0,
            delay: async () => {}
        }
    });

    await observer.poll();

    assert.equal(calls.get(failing), 2);
    assert.equal(calls.get(okA), 1);
    assert.equal(calls.get(okB), 1);
});

test("traffic control: poll still credits a valid incoming payment", async (t) => {
    const roomWallet = friendlyAddress("rw-pay");
    const players = threePlayers("pay");
    const transport = new MockTonTransport();
    transport.seedTransactions(roomWallet, [inboundTx({
        hash: "tx-traffic-pay",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000
    })]);

    const { observer, manager } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "Pay1", roomNumber: 1, gameId: "game-pay", players }],
        transport,
        observerOptions: {
            walletsPerCycle: 1,
            maxConcurrency: 1,
            retryMaxAttempts: 1
        }
    });

    const result = await observer.poll();
    assert.equal(result.processed >= 1, true);
    const participant = manager.getSession("Pay1").findParticipant(players[0].playerId);
    assert.equal(participant.status, PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED);
    assert.equal(participant.txHash, "tx-traffic-pay");
});

test("traffic control: shutdown skips new cycles", async (t) => {
    const roomWallet = friendlyAddress("rw-stop");
    let calls = 0;
    const transport = {
        async getTransactions() {
            calls += 1;
            return [];
        }
    };

    const { observer } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{
            roomId: "St1",
            roomNumber: 1,
            gameId: "game-st",
            players: threePlayers("st")
        }],
        transport,
        observerOptions: { walletsPerCycle: 1, retryMaxAttempts: 1 }
    });

    observer.shutdown();
    const result = await observer.poll();
    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, "stopped");
    assert.equal(calls, 0);
});

test("traffic control: BlockchainMonitor does not overlap _pollGlobal", async (t) => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let started = 0;

    const logger = createLogger();
    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });
    eventBus.initialize();

    const monitor = new BlockchainMonitor({
        logger,
        eventBus,
        transport: new MockTonTransport(),
        auditLedger: new EntryPaymentAuditLedger(),
        pollIntervalMs: 20
    });
    monitor.initialize();
    monitor.setRoomWalletIncomingObserver({
        async poll() {
            started += 1;
            concurrent += 1;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await wait(80);
            concurrent -= 1;
        }
    });

    await monitor.start();
    t.after(() => {
        monitor.stop();
        eventBus.shutdown();
    });

    await wait(100);
    assert.equal(maxConcurrent, 1);
    assert.ok(started >= 1);
});

// ---------------------------------------------------------------------------
// PAYMENT_CLOSING — PaymentSession payment-acceptance lifetime
// ---------------------------------------------------------------------------

test("PAYMENT_CLOSING A: transaction inside the acceptance window is accepted and recorded", (t) => {
    const roomWallet = friendlyAddress("rw-pc-a");
    const players = threePlayers("pca");
    const tx = inboundTx({
        hash: "tx-pc-a",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000,
        utime: Math.floor(Date.now() / 1000) // now, in TON Unix seconds
    });
    const transport = new MockTonTransport();
    transport.seedTransactions(roomWallet, [tx]);

    const { observer, manager, ledgerRegistry } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "PcA1", roomNumber: 1, gameId: "game-pc-a", players }],
        transport
    });

    const session = manager.getSession("PcA1");
    assert.equal(manager.isAcceptingPayments("PcA1"), true);

    const result = observer.processTransaction(tx, roomWallet);

    assert.equal(result.credited, true);
    assert.equal(result.roomId, "PcA1");
    assert.equal(result.playerId, players[0].playerId);

    const participant = session.findParticipant(players[0].playerId);
    assert.equal(participant.status, PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED);
    assert.equal(participant.txHash, "tx-pc-a");
    assert.equal(participant.paidAmount, 1);

    const received = session.receivedPayments.find(
        (payment) => payment.playerId === players[0].playerId
    );
    assert.ok(received);
    assert.equal(received.transactionHash, "tx-pc-a");
    assert.equal(received.walletAddress, players[0].wallet);
    assert.equal(received.amount, 1);

    const ledgerEntry = ledgerRegistry
        .listPlayerPayments("game-pc-a")
        .find((entry) => entry.metadata.txHash === "tx-pc-a");
    assert.ok(ledgerEntry);
    assert.equal(ledgerEntry.playerId, players[0].playerId);
    assert.equal(ledgerEntry.gameId, "game-pc-a");
    assert.equal(ledgerEntry.metadata.amountGram, 1);
});

test("PAYMENT_CLOSING B: transaction created before the acceptance start is rejected", (t) => {
    const roomWallet = friendlyAddress("rw-pc-b");
    const players = threePlayers("pcb");

    const { observer, manager, eventBus } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "PcB1", roomNumber: 1, gameId: "game-pc-b", players }]
    });

    const session = manager.getSession("PcB1");

    const confirmedEvents = [];
    eventBus.subscribe(
        EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED,
        (envelope) => confirmedEvents.push(envelope.payload)
    );

    // TonCenter utime is Unix SECONDS; 60 s before the session existed.
    const staleUtime = Math.floor((session.createdAt - 60_000) / 1000);
    const tx = inboundTx({
        hash: "tx-pc-b",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000,
        utime: staleUtime
    });

    const result = observer.processTransaction(tx, roomWallet);

    assert.equal(result.credited, false);
    assert.equal(result.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.STALE_TRANSACTION);
    assert.equal(result.roomId, "PcB1");
    assert.equal(result.playerId, players[0].playerId);

    const participant = session.findParticipant(players[0].playerId);
    assert.equal(participant.status, PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION);
    assert.equal(participant.txHash, null);
    assert.equal(confirmedEvents.length, 0);

    // The rejected observation is persisted, so re-polling cannot credit it.
    const repeat = observer.processTransaction(tx, roomWallet);
    assert.equal(repeat.credited, false);
    assert.equal(repeat.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.DUPLICATE_TRANSACTION);
});

test("PAYMENT_CLOSING C: transaction discovered inside the closing window is rejected", (t) => {
    const roomWallet = friendlyAddress("rw-pc-c");
    const players = threePlayers("pcc");

    const { observer, manager, eventBus } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "PcC1", roomNumber: 1, gameId: "game-pc-c", players }]
    });

    const session = manager.getSession("PcC1");

    // Move the hard deadline into the closing window: less than
    // PAYMENT_ACCEPTANCE_CLOSING_WINDOW_MS before expiration.
    session.paymentDeadline = Date.now() + 1_000;
    session.expiresAt = session.paymentDeadline;

    assert.equal(
        session.paymentDeadline - Date.now() < PAYMENT_ACCEPTANCE_CLOSING_WINDOW_MS,
        true
    );
    assert.equal(manager.isAcceptingPayments("PcC1"), false);

    const confirmedEvents = [];
    eventBus.subscribe(
        EVENT_TYPES.PAYMENT_TRANSACTION_CONFIRMED,
        (envelope) => confirmedEvents.push(envelope.payload)
    );

    const tx = inboundTx({
        hash: "tx-pc-c",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000,
        utime: Math.floor(Date.now() / 1000)
    });

    const result = observer.processTransaction(tx, roomWallet);

    assert.equal(result.credited, false);
    assert.equal(result.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.EXPIRED_PAYMENT_CONTEXT);
    assert.equal(result.playerId, players[0].playerId);

    const participant = session.findParticipant(players[0].playerId);
    assert.equal(participant.status, PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION);
    assert.equal(participant.txHash, null);
    assert.equal(confirmedEvents.length, 0);
    assert.equal(session.isInProgress(), true); // closing — not yet expired
});

test("PAYMENT_CLOSING C/G: after expiry the session is not credited and cannot be revived", async (t) => {
    const roomWallet = friendlyAddress("rw-pc-c2");
    const players = threePlayers("pcc2");

    const { observer, manager, eventBus } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "PcC2", roomNumber: 1, gameId: "game-pc-c2", players }],
        durationMs: 150
    });

    const completed = [];
    eventBus.subscribe(
        EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
        (envelope) => completed.push(envelope.payload)
    );

    await wait(300); // hard timer → existing _onExpiry → failSession("payment_timeout")

    const session = manager.getSession("PcC2");
    assert.equal(session.status, PAYMENT_SESSION_STATUS.PAYMENT_TIMEOUT);
    assert.equal(session.isInProgress(), false);
    assert.equal(manager.isAcceptingPayments("PcC2"), false);

    const late = observer.processTransaction(inboundTx({
        hash: "tx-pc-c2-late",
        from: players[0].wallet,
        to: roomWallet,
        nanoton: 1_000_000_000,
        utime: Math.floor(Date.now() / 1000)
    }), roomWallet);

    assert.equal(late.credited, false);
    assert.equal(late.reason, ROOM_WALLET_INCOMING_REJECTION_REASONS.UNKNOWN_SENDER);

    assert.equal(completed.length, 0);
    assert.equal(session.confirmedCount(), 0);
    assert.equal(session.isInProgress(), false);
});

test("PAYMENT_CLOSING D: three payments inside the window complete the session", (t) => {
    const roomWallet = friendlyAddress("rw-pc-d");
    const players = threePlayers("pcd");

    const { observer, manager, eventBus } = createObserverFixture({
        t,
        registryEntries: [{ roomNumber: 1, address: roomWallet }],
        rooms: [{ roomId: "PcD1", roomNumber: 1, gameId: "game-pc-d", players }]
    });

    const completed = [];
    eventBus.subscribe(
        EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
        (envelope) => completed.push(envelope.payload)
    );

    players.forEach((player, index) => {
        const result = observer.processTransaction(inboundTx({
            hash: `tx-pc-d-${index}`,
            from: player.wallet,
            to: roomWallet,
            nanoton: 1_000_000_000,
            utime: Math.floor(Date.now() / 1000)
        }), roomWallet);

        assert.equal(result.credited, true);
    });

    const session = manager.getSession("PcD1");
    assert.equal(session.status, PAYMENT_SESSION_STATUS.FULLY_PAID);
    assert.equal(session.confirmedCount(), 3);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].roomId, "PcD1");
    assert.equal(manager.isAcceptingPayments("PcD1"), false);
});

