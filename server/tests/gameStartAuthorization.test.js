import assert from "node:assert/strict";

import { EventBus } from "../events/EventBus.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import {
    GAME_START_PHASE,
    GameStartAuthorization
} from "../gameplay/GameStartAuthorization.js";
import { GAME_CONTRACT_STATUS } from "../models/GameContract.js";
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
    clockMissing = false
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
        status: PAYMENT_SESSION_STATUS.COMPLETED,
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

    const contract = {
        roomId: "room-1",
        gameId: "game-1",
        contractId: "c-1",
        status: GAME_CONTRACT_STATUS.PAYMENTS_COMPLETE,
        paymentsCompletedAt: 1_700_000_000_100
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
        gameContractManager: {
            getContract(roomId) {

                return roomId === "room-1" ? contract : null;

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
        roomConfig: { maxPlayers: 3 }
    });

    auth.initialize();

    return {
        eventBus,
        auth,
        auditLedger,
        session,
        contract,
        room,
        collected,
        emitPaymentsComplete() {

            eventBus.emit({
                source: "test",
                type: EVENT_TYPES.PAYMENT_SESSION_COMPLETED,
                payload: { roomId: "room-1", gameId: "game-1" }
            });

            eventBus.emit({
                source: "test",
                type: EVENT_TYPES.GAME_CONTRACT_PAYMENTS_COMPLETE,
                payload: { roomId: "room-1", gameId: "game-1" }
            });

        }
    };

}

{
    const harness = createHarness();

    harness.emitPaymentsComplete();

    assert.deepEqual(
        harness.collected,
        [
            EVENT_TYPES.GAME_START_AUTHORIZED,
            EVENT_TYPES.GAME_INITIALIZING,
            EVENT_TYPES.GAME_START_BOOTSTRAP_READY
        ],
        "happy path emits authorize → initializing → bootstrap ready"
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

    harness.emitPaymentsComplete();

    assert.equal(
        harness.collected.length,
        0,
        "duplicate completion must not re-authorize"
    );

    console.log("  GameStartAuthorization happy path + idempotency passed");

    harness.auth.shutdown();

}

{
    const harness = createHarness({ validateThrows: true });

    harness.emitPaymentsComplete();

    assert.deepEqual(
        harness.collected,
        [
            EVENT_TYPES.GAME_START_AUTHORIZED,
            EVENT_TYPES.GAME_INITIALIZING,
            EVENT_TYPES.GAME_START_FAILED
        ],
        "validation failure cancels after GAME_INITIALIZING"
    );

    assert.equal(
        harness.auth.getLifecycle("room-1")?.phase,
        GAME_START_PHASE.FAILED,
        "failed start latches FAILED to block retries"
    );

    const failed = harness.auditLedger.list("room-1").find(
        (entry) => entry.type === "GAME_START_FAILED"
    );

    assert.ok(failed, "failure is audited");

    assert.match(
        String(failed.reason),
        /configuration_invalid/,
        "failure reason preserved"
    );

    console.log("  GameStartAuthorization validation failure passed");

    harness.auth.shutdown();

}

{
    const harness = createHarness({ recoveryPending: true });

    harness.emitPaymentsComplete();

    assert.equal(
        harness.collected.length,
        0,
        "recovery pending blocks game start"
    );

    console.log("  GameStartAuthorization recovery gate passed");

    harness.auth.shutdown();

}

{
    const harness = createHarness();

    harness.session.status = PAYMENT_SESSION_STATUS.ACTIVE;

    harness.emitPaymentsComplete();

    assert.equal(
        harness.collected.length,
        0,
        "incomplete payment session blocks start"
    );

    console.log("  GameStartAuthorization payment gate passed");

    harness.auth.shutdown();

}

console.log("gameStartAuthorization.test.js passed");
