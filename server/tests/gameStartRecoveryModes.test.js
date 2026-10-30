import assert from "node:assert/strict";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { GameStartAuthorization } from "../gameplay/GameStartAuthorization.js";
import { ROOM_STATUS } from "../models/RoomStatus.js";

const ROOM_ID = "room-recovery-mode-gate";
const PLAYER_IDS = ["mode-player-a", "mode-player-b", "mode-player-c"];

function buildAuthorization(gameMode, settledCount) {

    const listeners = new Map();

    const emitted = [];

    const eventBus = {
        subscribe(type, handler) {

            const handlers = listeners.get(type) ?? new Set();

            handlers.add(handler);

            listeners.set(type, handlers);

        },
        unsubscribe(type, handler) {

            listeners.get(type)?.delete(handler);

        },
        emit(envelope) {

            emitted.push(envelope);

        },
        fire(type, payload) {

            for (const handler of listeners.get(type) ?? []) {

                handler({ payload });

            }

        }
    };

    const room = {
        roomId: ROOM_ID,
        gameMode,
        status: ROOM_STATUS.FULL,
        maxPlayers: 3,
        players: [...PLAYER_IDS]
    };

    const authorization = new GameStartAuthorization({
        logger: { info() {} },
        eventBus,
        roomManager: { getRoom: () => room },
        playerManager: { getIdentity: (playerId) => ({ playerId }) },
        gameManager: {
            getPendingGameplayGameId: () => "game-mode-gate",
            getGame: () => ({ id: "game-mode-gate" })
        },
        configurationEngine: {
            getConfiguration: () => ({ traceSeed: "deterministic-seed" }),
            validateConfiguration() {}
        },
        paymentGate: {
            getGameStartGateStatus: (roomId, playerIds) => ({
                eligible: settledCount === 3,
                roomId,
                playerIds: settledCount === 3 ? [...playerIds] : []
            })
        }
    });

    authorization.initialize();

    return { authorization, eventBus, emitted };

}

for (const gameMode of ["FRIENDS", "NO_FRIENDS"]) {

    const partial = buildAuthorization(gameMode, 2);

    partial.eventBus.fire(EVENT_TYPES.VERIFY_BARRIER_COMPLETED, {
        roomId: ROOM_ID
    });

    assert.equal(
        partial.emitted.some(({ type }) => type === EVENT_TYPES.GAME_START_AUTHORIZED),
        false,
        `${gameMode} with 2/3 settled must not authorize Page5`
    );

    partial.authorization.shutdown();

    const complete = buildAuthorization(gameMode, 3);

    complete.eventBus.fire(EVENT_TYPES.VERIFY_BARRIER_COMPLETED, {
        roomId: ROOM_ID
    });

    complete.eventBus.fire(EVENT_TYPES.ROOM_PAYMENT_GATE_UPDATED, {
        roomId: ROOM_ID
    });

    assert.equal(
        complete.emitted.filter(({ type }) => type === EVENT_TYPES.GAME_START_AUTHORIZED).length,
        1,
        `${gameMode} with 3/3 settled must authorize one authoritative start`
    );

    assert.equal(
        complete.emitted.filter(({ type }) => type === EVENT_TYPES.GAME_INITIALIZING).length,
        1,
        `${gameMode} must initialize once after the authoritative start`
    );

    assert.equal(
        complete.emitted.filter(({ type }) => type === EVENT_TYPES.GAME_START_BOOTSTRAP_READY).length,
        1,
        `${gameMode} must emit one Page5 transition`
    );

    const startSnapshot = complete.authorization.getReconnectSnapshot(ROOM_ID);

    complete.eventBus.fire(EVENT_TYPES.ROOM_PAYMENT_GATE_UPDATED, {
        roomId: ROOM_ID
    });

    assert.deepEqual(
        complete.authorization.getReconnectSnapshot(ROOM_ID),
        startSnapshot,
        `${gameMode} repeated recovery must preserve the original start timestamp/phase`
    );

    assert.equal(
        complete.emitted.filter(({ type }) => type === EVENT_TYPES.GAME_START_AUTHORIZED).length,
        1,
        `${gameMode} repeated recovery/payment updates must not initialize another game`
    );

    complete.authorization.shutdown();

}

console.log("gameStartRecoveryModes.test.js: all assertions passed");
