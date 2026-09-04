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
    PAYMENT_PARTICIPANT_STATUS
} from "../models/PaymentSession.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import {
    BlockchainMonitor,
    EntryPaymentAuditLedger,
    parseDepositCandidate
} from "../payment/BlockchainMonitor.js";
import { MockTonTransport } from "../payment/ton/MockTonTransport.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
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
    aborted = false
}) {
    return {
        transaction_id: { hash, lt },
        aborted,
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
    tonService = null
} = {}) {
    const harness = createPaymentHarness({ rooms, dataDir, durationMs });
    const registry = new RoomWalletRegistry({ entries: registryEntries });
    const auditLedger = new EntryPaymentAuditLedger();
    const observer = new RoomWalletIncomingObserver({
        logger: harness.logger,
        eventBus: harness.eventBus,
        paymentSessionManager: harness.manager,
        financialPersistence: harness.persistence,
        registry,
        roomManager: harness.roomManager,
        transport,
        tonService,
        auditLedger,
        network: "testnet"
    });

    for (const room of rooms) {
        harness.manager.createPaymentSession(room.roomId, {
            gameId: room.gameId,
            network: "testnet"
        });
    }

    const fixture = { ...harness, registry, observer, auditLedger };
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
    assert.equal(
        manager.getSession("Kb02").findParticipant(playersB[0].playerId).status,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
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
    assert.equal(
        manager.getSession("Keah").findParticipant(players[0].playerId).status,
        PAYMENT_PARTICIPANT_STATUS.PAYMENT_REQUESTED
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
