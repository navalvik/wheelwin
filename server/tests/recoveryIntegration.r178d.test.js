/**
 * R17.8D — Recovery integration validation (gateway routing + observability).
 *
 * Drives SocketGateway._handleRecoveryRequest with stubs — does not mutate
 * GameManager / Physics / Payment / TON engines.
 */
import assert from "node:assert/strict";

import { SocketGateway } from "../socket/SocketGateway.js";
import { GAME_MESSAGE_CHANNEL } from "../socket/events.js";
import {
    RECOVERY_SOCKET_MESSAGE_TYPES,
    resolveRecoveryRoute
} from "../socket/gameplayRecoveryProtocol.js";
import { GAME_STATES } from "../engines/gameState/GameStates.js";

function createLoggerCapture() {

    const lines = [];

    return {
        lines,
        logger: {
            info(message) {
                lines.push(String(message));
            },
            debug() {},
            error() {},
            warn() {},
            startupLine() {}
        },
        has(fragment) {
            return lines.some((line) => line.includes(fragment));
        },
        find(fragment) {
            return lines.find((line) => line.includes(fragment)) ?? null;
        }
    };

}

function createFakeSocket() {

    const emitted = [];

    return {
        id: "sock-recovery-1",
        connected: true,
        emitted,
        emit(channel, message) {
            emitted.push({ channel, message });
        }
    };

}

function buildMinimalSnapshot({
    gameId,
    playerId,
    gameState,
    angle = 0.5
}) {

    return Object.freeze({
        gameId,
        configuration: Object.freeze({
            roomId: "room-1",
            traceSeed: "seed",
            configurationVersion: 1,
            sectors: [],
            players: [
                Object.freeze({ playerId })
            ],
            wheel: Object.freeze({ startAngle: 0 }),
            triangle: Object.freeze({ startAngle: 0 }),
            metadata: Object.freeze({ roomId: "room-1" })
        }),
        gameState: Object.freeze({
            currentState: gameState,
            previousState: null,
            history: []
        }),
        clock: Object.freeze({
            elapsed: 1000,
            remainingTime: 5000,
            phaseStartedAt: Date.now(),
            phaseEndsAt: Date.now() + 5000
        }),
        physics: Object.freeze({
            snapshot: Object.freeze({
                runtime: Object.freeze({
                    angle,
                    triangleAngle: 0,
                    angularVelocity: 0,
                    triangleAngularVelocity: 0,
                    state: "CREATED"
                })
            }),
            angle,
            triangleAngle: 0,
            angularVelocity: 0,
            triangleAngularVelocity: 0,
            state: "CREATED",
            selfTestActive: false,
            speedActive: gameState === GAME_STATES.SPEED,
            brakeActive: false,
            brakeDurationMs: 0,
            brakeElapsedMs: 0,
            brakeStartWheelOmega: 0
        }),
        input: Object.freeze({
            commandHistory: [],
            players: [
                Object.freeze({
                    playerId,
                    pressCount: 0,
                    completedCycles: 0,
                    remainingPresses: 3,
                    locked: false,
                    buttonLocked: false,
                    buttonPressed: false,
                    pressed: false
                })
            ]
        }),
        winner: null,
        payment: null,
        preGameReady: null,
        openPage6: gameState === GAME_STATES.RESULT,
        resultSessionExpiresAt: null,
        recoveredAt: Date.now(),
        metadata: Object.freeze({
            traceSeed: "seed",
            configurationVersion: 1,
            catalogVersion: 1
        })
    });

}

function createGatewayFixture({
    gameId = "game-1",
    playerId = "player-1",
    roomId = "room-1",
    setupActive = false,
    liveGameState = null,
    cachedSnapshot = null,
    recoverSnapshot = null,
    recoverThrows = null
} = {}) {

    const log = createLoggerCapture();

    const socket = createFakeSocket();

    let recoverPlayerCalls = 0;

    let restoreDepositCalls = 0;

    const physicsAngleBefore = recoverSnapshot?.physics?.angle ?? 0.5;

    const recoveryEngine = {
        recoverPlayer(requestedGameId, requestedPlayerId) {

            recoverPlayerCalls += 1;

            assert.equal(requestedGameId, gameId);
            assert.equal(requestedPlayerId, playerId);

            if (recoverThrows) {

                const error = new Error(recoverThrows);
                error.reason = recoverThrows;
                throw error;

            }

            return recoverSnapshot;

        },
        getDebugSnapshot(requestedGameId) {

            if (requestedGameId !== gameId) {

                return { currentState: null };

            }

            return { currentState: liveGameState };

        }
    };

    const recoverySnapshotCache = {
        get(requestedGameId) {

            if (requestedGameId !== gameId || !cachedSnapshot) {

                return null;

            }

            return {
                snapshot: cachedSnapshot,
                paymentStatus: null,
                payment: null,
                auditStatus: null,
                page6Opened: cachedSnapshot.openPage6 === true,
                resultSessionExpiresAt: null
            };

        }
    };

    const gameplayContextResolver = {
        resolve() {
            return {
                ok: true,
                playerId,
                roomId,
                gameId,
                setupActive
            };
        }
    };

    const gateway = new SocketGateway({
        logger: log.logger,
        socketConfig: { cors: { origin: "*" } },
        gameplayContextResolver,
        recoveryEngine,
        recoverySnapshotCache,
        paymentEngine: {
            getPaymentStatus() {
                return null;
            },
            getPayment() {
                return null;
            }
        },
        roomLobbyBridge: {
            reconnectGameplaySession() {
                assert.fail("reclaim should not run when socket already bound");
            },
            restoreDepositProjectionForSocket() {
                restoreDepositCalls += 1;
                return { restored: true, reason: "bound_recovery" };
            }
        },
        devMode: true
    });

    return {
        gateway,
        socket,
        log,
        get recoverPlayerCalls() {
            return recoverPlayerCalls;
        },
        get restoreDepositCalls() {
            return restoreDepositCalls;
        },
        physicsAngleBefore,
        runRecovery() {
            gateway._handleRecoveryRequest(socket, {
                type: RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_RECOVERY_REQUEST,
                payload: {
                    roomId,
                    playerId,
                    recoveryCredential: "cred-test"
                }
            });
        }
    };

}

function assertNoRecoveryFailure(socket) {

    const failed = socket.emitted.find(
        (entry) => entry.message?.type
            === RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_RECOVERY_FAILED
    );

    assert.equal(failed, undefined, "must not emit SESSION_RECOVERY_FAILED");

}

// ---------------------------------------------------------------------------
// Route contract (observability fields)
// ---------------------------------------------------------------------------

{
    const payment = resolveRecoveryRoute({
        gameId: "g1",
        gameState: null,
        hasCachedSnapshot: false
    });

    assert.equal(payment.route, "PRE_GAME_SUCCESS");
    assert.equal(payment.successRoute, "PRE_GAME_SYNC");
    assert.equal(payment.phase, "ENTRY_PAYMENT");

    const speed = resolveRecoveryRoute({
        gameId: "g1",
        gameState: GAME_STATES.SPEED,
        hasCachedSnapshot: false
    });

    assert.equal(speed.route, "GAMEPLAY_SNAPSHOT");
    assert.equal(speed.successRoute, "GAMEPLAY_SNAPSHOT");
    assert.equal(speed.phase, GAME_STATES.SPEED);

    console.log("  route successRoute/phase contract: OK");
}

// ---------------------------------------------------------------------------
// Test A — Payment recovery (pre-GAME_INITIALIZED)
// ---------------------------------------------------------------------------

{
    const fixture = createGatewayFixture({
        setupActive: false,
        liveGameState: null,
        cachedSnapshot: null,
        recoverSnapshot: null
    });

    fixture.runRecovery();

    assert.equal(
        fixture.recoverPlayerCalls,
        0,
        "Test A: RecoveryEngine must NOT be called"
    );

    assert.equal(
        fixture.restoreDepositCalls,
        1,
        "Test A: bound recovery must restore Deposit projection"
    );

    assertNoRecoveryFailure(fixture.socket);

    assert.equal(
        fixture.socket.emitted.some(
            (entry) => entry.message?.type
                === RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_SNAPSHOT
        ),
        false,
        "Test A: no gameplay SESSION_SNAPSHOT"
    );

    assert.ok(
        fixture.log.has("RECOVERY_SUCCESS"),
        "Test A: RECOVERY_SUCCESS logged"
    );

    assert.ok(
        fixture.log.has("route=PRE_GAME_SYNC"),
        "Test A: route=PRE_GAME_SYNC"
    );

    assert.ok(
        fixture.log.has("phase=ENTRY_PAYMENT"),
        "Test A: phase=ENTRY_PAYMENT"
    );

    console.log("  Test A payment recovery: OK");
}

// ---------------------------------------------------------------------------
// Test B — Immediate gameplay recovery (PRE_GAME_READY after GAME_INITIALIZED)
// ---------------------------------------------------------------------------

{
    const playerId = "player-1";

    const snapshot = buildMinimalSnapshot({
        gameId: "game-1",
        playerId,
        gameState: GAME_STATES.PRE_GAME_READY
    });

    const fixture = createGatewayFixture({
        liveGameState: GAME_STATES.PRE_GAME_READY,
        recoverSnapshot: snapshot
    });

    fixture.runRecovery();

    assert.equal(
        fixture.recoverPlayerCalls,
        1,
        "Test B: RecoveryEngine must be called"
    );

    assertNoRecoveryFailure(fixture.socket);

    const snapshotMsg = fixture.socket.emitted.find(
        (entry) => entry.channel === GAME_MESSAGE_CHANNEL
            && entry.message?.type
                === RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_SNAPSHOT
    );

    assert.ok(snapshotMsg, "Test B: SESSION_SNAPSHOT emitted");
    assert.equal(
        snapshotMsg.message.payload.gameState,
        GAME_STATES.PRE_GAME_READY
    );

    assert.ok(fixture.log.has("RECOVERY_SUCCESS"));
    assert.ok(fixture.log.has("route=GAMEPLAY_SNAPSHOT"));
    assert.ok(fixture.log.has(`phase=${GAME_STATES.PRE_GAME_READY}`));

    console.log("  Test B immediate gameplay recovery: OK");
}

// ---------------------------------------------------------------------------
// Test C — Mid-game SPEED recovery (no physics reset / restart)
// ---------------------------------------------------------------------------

{
    const playerId = "player-1";

    const snapshot = buildMinimalSnapshot({
        gameId: "game-1",
        playerId,
        gameState: GAME_STATES.SPEED,
        angle: 1.234
    });

    const fixture = createGatewayFixture({
        liveGameState: GAME_STATES.SPEED,
        recoverSnapshot: snapshot
    });

    fixture.runRecovery();

    assert.equal(fixture.recoverPlayerCalls, 1);
    assertNoRecoveryFailure(fixture.socket);

    const snapshotMsg = fixture.socket.emitted.find(
        (entry) => entry.message?.type
            === RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_SNAPSHOT
    );

    assert.ok(snapshotMsg, "Test C: SESSION_SNAPSHOT emitted");
    assert.equal(snapshotMsg.message.payload.gameState, GAME_STATES.SPEED);

    // On-demand snapshot preserves authoritative physics angle — no restart.
    assert.equal(
        snapshot.physics.angle,
        fixture.physicsAngleBefore,
        "Test C: physics angle unchanged by recovery path"
    );

    assert.ok(fixture.log.has("RECOVERY_SUCCESS"));
    assert.ok(fixture.log.has("route=GAMEPLAY_SNAPSHOT"));
    assert.ok(fixture.log.has(`phase=${GAME_STATES.SPEED}`));

    console.log("  Test C mid-game SPEED recovery: OK");
}

// ---------------------------------------------------------------------------
// Test D — RESULT cache recovery
// ---------------------------------------------------------------------------

{
    const playerId = "player-1";

    const cached = buildMinimalSnapshot({
        gameId: "game-1",
        playerId,
        gameState: GAME_STATES.RESULT
    });

    const fixture = createGatewayFixture({
        liveGameState: null,
        cachedSnapshot: cached,
        recoverThrows: "Game state is missing"
    });

    fixture.runRecovery();

    // Live build attempted (GAMEPLAY_SNAPSHOT route via cache), then cache used.
    assert.equal(fixture.recoverPlayerCalls, 1);
    assertNoRecoveryFailure(fixture.socket);

    const snapshotMsg = fixture.socket.emitted.find(
        (entry) => entry.message?.type
            === RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_SNAPSHOT
    );

    assert.ok(snapshotMsg, "Test D: SESSION_SNAPSHOT from cache");
    assert.equal(snapshotMsg.message.payload.gameState, GAME_STATES.RESULT);

    assert.ok(fixture.log.has("RECOVERY_SUCCESS"));
    assert.ok(fixture.log.has("route=GAMEPLAY_SNAPSHOT"));

    console.log("  Test D RESULT cache recovery: OK");
}

// ---------------------------------------------------------------------------
// Invalid recovery still fails clearly
// ---------------------------------------------------------------------------

{
    const log = createLoggerCapture();

    const socket = createFakeSocket();

    const gateway = new SocketGateway({
        logger: log.logger,
        socketConfig: { cors: { origin: "*" } },
        gameplayContextResolver: {
            resolve() {
                return {
                    ok: true,
                    playerId: "p1",
                    roomId: "r1",
                    gameId: null,
                    setupActive: false
                };
            }
        },
        recoveryEngine: {
            getDebugSnapshot() {
                return { currentState: null };
            },
            recoverPlayer() {
                assert.fail("must not call recoverPlayer without gameId");
            }
        },
        recoverySnapshotCache: { get() { return null; } },
        devMode: true
    });

    gateway._handleRecoveryRequest(socket, {
        type: RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_RECOVERY_REQUEST,
        payload: { roomId: "r1", playerId: "p1" }
    });

    const failed = socket.emitted.find(
        (entry) => entry.message?.type
            === RECOVERY_SOCKET_MESSAGE_TYPES.SESSION_RECOVERY_FAILED
    );

    assert.ok(failed, "invalid recovery emits SESSION_RECOVERY_FAILED");
    assert.match(
        failed.message.payload.reason,
        /No active gameplay session/i
    );

    console.log("  invalid recovery clear failure: OK");
}

console.log("recoveryIntegration.r178d.test.js — all assertions passed");
