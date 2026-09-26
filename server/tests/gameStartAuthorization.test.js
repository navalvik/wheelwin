/**
 * R18.XSDd — Game start authorization in Room-Wallet intake mode.
 *
 * PAYMENT_SESSION_COMPLETED (FULLY_PAID) → GameStartAuthorization
 * → GAME_START_AUTHORIZED → GAME_INITIALIZING → GAME_START_BOOTSTRAP_READY
 * (the existing Page5 startup gate).
 *
 * The Room Wallet ledger is the authoritative received-funds gate. No
 * smart-contract state is consulted: the former `contract` reference in
 * _checkStartConditions crashed this exact path ("ReferenceError: contract
 * is not defined") and left the XSDd game short of Page5.
 */
import assert from "node:assert/strict";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    GAME_START_PHASE,
    GameStartAuthorization
} from "../gameplay/GameStartAuthorization.js";
import {
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../models/PaymentSession.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";
import { EntryPaymentAuditLedger } from "../payment/BlockchainMonitor.js";

function createLogger() {

    return {
        info() {},
        error() {},
        warn() {},
        debug() {}
    };

}

function createHarness({
    configuration = { gameId: "game-1", traceSeed: "seed-1", players: [], sectors: [] },
    validateThrows = false,
    recoveryPending = false,
    simulationMissing = false,
    clockMissing = false,
    ledgerMode = "complete",
    sessionStatus = PAYMENT_SESSION_STATUS.COMPLETED
} = {}) {

    const logger = createLogger();

    const eventBus = new EventBus({
        logger,
        eventBusConfig: { logEvents: false, showDebugPanel: false }
    });

    eventBus.initialize();

    const auditLedger = new EntryPaymentAuditLedger();

    const room = {
        roomId: "room-1",
        players: ["p1", "p2", "p3"],
        status: ROOM_STATUS.LOCKED,
        maxPlayers: 3
    };

    const session = {
        roomId: "room-1",
        gameId: "game-1",
        status: sessionStatus,
        completedAt: 1_700_000_000_000,
        participants: [
            { playerId: "p1", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED },
            { playerId: "p2", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED },
            { playerId: "p3", status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED }
        ],
        allConfirmed() {

            return this.participants.every(
                (participant) => (
                    participant.status === PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED
                )
            );

        }
    };

    // Room-Wallet intake: the authoritative received-funds ledger.
    const roomWalletLedgerRegistry = ledgerMode === "missing"
        ? null
        : {
            listPlayerPayments(gameId) {

                if (ledgerMode === "incomplete") {

                    return [{ playerId: "p1" }, { playerId: "p2" }];

                }

                return [
                    { playerId: "p1" },
                    { playerId: "p2" },
                    { playerId: "p3" }
                ];

            }
        };

    const collected = [];

    for (const type of [
        EVENT_TYPES.GAME_START_AUTHORIZED,
        EVENT_TYPES.GAME_INITIALIZING,
        EVENT_TYPES.GAME_START_BOOTSTRAP_READY,
        EVENT_TYPES.GAME_START_FAILED
    ]) {

        eventBus.subscribe(type, (envelope) => {

            collected.push(envelope.type);

        });

    }

    const auth = new GameStartAuthorization({
        logger,
        eventBus,
        roomManager: {
            getRoom(roomId) {

                return roomId === "room-1" ? room : null;

            }
        },
        playerManager: {
            getIdentity(playerId) {

                return { playerId };

            }
        },
        gameManager: {
            getGame(gameId) {

                return gameId === "game-1" ? { gameId, status: "CREATED" } : null;

            },
            getPendingGameplayGameId(roomId) {

                return roomId === "room-1" ? "game-1" : null;

            }
        },
        paymentSessionManager: {
            getSession(roomId) {

                return roomId === "room-1" ? session : null;

            }
        },
        configurationEngine: {
            getConfiguration(gameId) {

                return gameId === "game-1" ? configuration : null;

            },
            validateConfiguration() {

                if (validateThrows) {

                    throw new Error("bad_config");

                }

            }
        },
        physicsEngine: {
            getSimulation(gameId) {

                return simulationMissing ? null : { gameId };

            }
        },
        gameClockEngine: {
            getClock(gameId) {

                return clockMissing ? null : { gameId };

            }
        },
        recoveryEngine: {
            getRecoverySnapshot(gameId) {

                return recoveryPending ? { gameId } : null;

            }
        },
        auditLedger,
        roomConfig: { maxPlayers: 3 },
        roomWalletPaymentIntakeEnabled: true,
        roomWalletLedgerRegistry
    });

    auth.initialize();

    return {
        eventBus,
        auth,
        auditLedger,
        session,
        room,
        collected,
        emitPaymentSessionCompleted() {

            eventBus.emit({
                source: "test",
                type: EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
                payload: { roomId: "room-1", gameId: "game-1" }
            });

        }
    };

}

console.log("gameStartAuthorization (Room Wallet intake) tests");

// A — FULL PAYMENT → GAME START (R18.XSDd regression).
// Three confirmed Room Wallet payments + FULLY_PAID PaymentSession must
// authorize game start with no ReferenceError and no contract dependency.
{

    const harness = createHarness();

    harness.emitPaymentSessionCompleted();

    assert.deepEqual(
        harness.collected,
        [
            EVENT_TYPES.GAME_START_AUTHORIZED,
            EVENT_TYPES.GAME_INITIALIZING,
            EVENT_TYPES.GAME_START_BOOTSTRAP_READY
        ],
        "full Room Wallet payment emits authorize → initializing → bootstrap ready"
    );

    assert.equal(
        harness.auth.getLifecycle("room-1")?.phase,
        GAME_START_PHASE.OPENED,
        "lifecycle reaches OPEN_PAGE5"
    );

    const auditTypes = harness.auditLedger.list("room-1").map((entry) => entry.type);

    assert.deepEqual(
        auditTypes,
        [
            "BLOCKCHAIN_COMPLETE",
            "GAME_START_AUTHORIZED",
            "GAME_INITIALIZING",
            "OPEN_PAGE5"
        ],
        "immutable audit records every transition"
    );

    harness.collected.length = 0;

    harness.emitPaymentSessionCompleted();

    assert.equal(
        harness.collected.length,
        0,
        "duplicate completion must not re-authorize"
    );

    console.log("  A. FULLY_PAID → GAME_START_AUTHORIZED → BOOTSTRAP_READY passed");

    harness.auth.shutdown();

}

// B — Room Wallet ledger incomplete → blocked (fail-closed).
{

    const harness = createHarness({ ledgerMode: "incomplete" });

    harness.emitPaymentSessionCompleted();

    assert.equal(
        harness.collected.length,
        0,
        "missing Room Wallet ledger entry blocks game start"
    );

    console.log("  B. incomplete Room Wallet ledger blocks start passed");

    harness.auth.shutdown();

}

// C — Room Wallet ledger registry missing → blocked (fail-closed).
{

    const harness = createHarness({ ledgerMode: "missing" });

    harness.emitPaymentSessionCompleted();

    assert.equal(
        harness.collected.length,
        0,
        "missing Room Wallet ledger registry blocks game start"
    );

    console.log("  C. missing ledger registry blocks start passed");

    harness.auth.shutdown();

}

// D — incomplete payment session → blocked.
{

    const harness = createHarness({ sessionStatus: PAYMENT_SESSION_STATUS.ACTIVE });

    harness.emitPaymentSessionCompleted();

    assert.equal(
        harness.collected.length,
        0,
        "incomplete payment session blocks start"
    );

    console.log("  D. incomplete payment session blocks start passed");

    harness.auth.shutdown();

}

// E — recovery pending → blocked.
{

    const harness = createHarness({ recoveryPending: true });

    harness.emitPaymentSessionCompleted();

    assert.equal(
        harness.collected.length,
        0,
        "recovery pending blocks game start"
    );

    console.log("  E. recovery gate passed");

    harness.auth.shutdown();

}

console.log("gameStartAuthorization.test.js passed");

