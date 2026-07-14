/**
 * C5.2 — Authoritative Session Model (foundation).
 *
 * Mirrors the server session. Does NOT generate data, fabricate defaults,
 * calculate gameplay, drive timers, invent payment statuses, or decide winners.
 * Every field stays null/empty until an authoritative socket payload arrives.
 *
 * -------------------------------------------------------------------------
 * STEP 1 — Session ownership map (current → future)
 * -------------------------------------------------------------------------
 *
 * Field (GameSessionContext today)     | Current owner              | Future authoritative owner
 * -------------------------------------|----------------------------|-----------------------------------------
 * roomId ("8F4K2S" mock)               | GameSessionContext (mock)  | Server lobby / GAME_START / roomState
 * players (DEV_VERIFY_PLAYERS)         | GameSessionContext (mock)  | Server roster / PLAYER_UPDATE / GAME_START
 * player icons / colors / sectors      | GameSession / Wheel debug  | Server configuration / WHEEL_CONFIGURATION
 * player readiness / online            | PlayerUIEngine (+ debug)   | PLAYER_ONLINE / PLAYER_OFFLINE / Recovery
 * baseStake / paymentGram              | GameSessionContext (mock)  | Server configuration / stakes catalog
 * payment status (DEV + 8s auto)       | GameSessionContext (mock)  | PAYMENT_* (settlement) + future lobby pay
 * smartContractStatus                  | GameSessionContext (mock)  | Server payment / contract pipeline
 * setup timer (local setInterval)      | GameSessionContext (local) | Future lobby clock (or stay UX-local)
 * phaseTimeRemaining / currentPhase    | GameSessionContext (local) | GameClock for gameplay; lobby TBD
 * currentPage                          | App.jsx (local navigation) | Client shell (UX) — not gameplay state
 * connectedCount / maxPlayers          | GameSession mock / lobby   | Server roomState / GAME_START
 *
 * This model stores ONLY the right-hand column when the corresponding
 * INCOMING_SOCKET_EVENTS payloads arrive. Pre-game Pages 2–4 remain on
 * GameSessionContext until later migration stages.
 */

export const AUTHORITATIVE_SESSION_ACTIONS = Object.freeze({
    GAME_START: "GAME_START",
    GAME_STATE: "GAME_STATE",
    GAME_CLOCK: "GAME_CLOCK",
    PLAYER_UPDATE: "PLAYER_UPDATE",
    PLAYER_ONLINE: "PLAYER_ONLINE",
    PLAYER_OFFLINE: "PLAYER_OFFLINE",
    WHEEL_CONFIGURATION: "WHEEL_CONFIGURATION",
    GAME_RESULT: "GAME_RESULT",
    PAYMENT: "PAYMENT",
    AUDIT: "AUDIT",
    SESSION_SNAPSHOT: "SESSION_SNAPSHOT",
    SESSION_RECOVERY_FAILED: "SESSION_RECOVERY_FAILED",
    GAME_END: "GAME_END",
    RESET: "RESET"
});

export const AUTHORITATIVE_SESSION_INITIAL_STATE = Object.freeze({
    roomId: null,
    gameId: null,
    maxPlayers: null,
    players: Object.freeze({}),
    gameState: null,
    previousGameState: null,
    clock: null,
    configuration: null,
    payment: null,
    audit: null,
    winner: null,
    recovery: null,
    lifecycle: Object.freeze({
        gameStarted: false,
        gameEnded: false,
        cleanupObserved: false
    }),
    lastEventType: null,
    lastUpdatedAt: null
});

function stamp(state, eventType) {

    return {
        ...state,
        lastEventType: eventType,
        lastUpdatedAt: Date.now()
    };

}

function resolvePlayerId(entry) {

    if (entry === null || entry === undefined) {

        return null;

    }

    if (typeof entry === "string" || typeof entry === "number") {

        return String(entry);

    }

    const id = entry.playerId ?? entry.id;

    return id === undefined || id === null ? null : String(id);

}

function freezePlayers(players) {

    return Object.freeze({ ...players });

}

function upsertPlayer(players, playerId, patch) {

    if (!playerId) {

        return players;

    }

    const previous = players[playerId] ?? Object.freeze({ playerId });

    return freezePlayers({
        ...players,
        [playerId]: Object.freeze({
            ...previous,
            ...patch,
            playerId
        })
    });

}

function ingestPlayerList(players, list) {

    if (!Array.isArray(list)) {

        return players;

    }

    let next = players;

    for (const entry of list) {

        const playerId = resolvePlayerId(entry);

        if (!playerId) {

            continue;

        }

        if (typeof entry === "string" || typeof entry === "number") {

            next = upsertPlayer(next, playerId, { playerId });

            continue;

        }

        next = upsertPlayer(next, playerId, {
            nickname: entry.nickname ?? entry.name ?? undefined,
            icon: entry.icon ?? undefined,
            color: entry.color ?? undefined,
            online: entry.online,
            state: entry.state ?? entry.playerState,
            ...entry
        });

    }

    return next;

}

/**
 * Pure reducer: copies server fields into the session mirror. Never invents
 * values that were absent from the payload.
 */
export function authoritativeSessionReducer(state, action) {

    if (!action?.type) {

        return state;

    }

    const payload = action.payload ?? {};

    switch (action.type) {

        case AUTHORITATIVE_SESSION_ACTIONS.GAME_START: {

            const players = ingestPlayerList(
                AUTHORITATIVE_SESSION_INITIAL_STATE.players,
                payload.players
            );

            return stamp({
                ...state,
                roomId: payload.roomId ?? state.roomId,
                gameId: payload.gameId ?? state.gameId,
                maxPlayers: payload.maxPlayers ?? state.maxPlayers,
                players,
                lifecycle: Object.freeze({
                    ...state.lifecycle,
                    gameStarted: true,
                    gameEnded: false,
                    cleanupObserved: false
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.GAME_STATE: {

            const nextState = typeof payload === "string"
                ? payload
                : (payload.state ?? payload.currentState ?? null);

            if (!nextState) {

                return state;

            }

            return stamp({
                ...state,
                gameId: payload.gameId ?? state.gameId,
                previousGameState: state.gameState,
                gameState: nextState
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.GAME_CLOCK: {

            if (!payload || typeof payload !== "object") {

                return state;

            }

            return stamp({
                ...state,
                gameId: payload.gameId ?? state.gameId,
                clock: Object.freeze({ ...payload })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.PLAYER_UPDATE: {

            const playerId = resolvePlayerId(payload);

            if (!playerId) {

                return state;

            }

            return stamp({
                ...state,
                players: upsertPlayer(state.players, playerId, payload)
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.PLAYER_ONLINE: {

            const playerId = resolvePlayerId(payload);

            if (!playerId) {

                return state;

            }

            return stamp({
                ...state,
                players: upsertPlayer(state.players, playerId, {
                    online: true
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.PLAYER_OFFLINE: {

            const playerId = resolvePlayerId(payload);

            if (!playerId) {

                return state;

            }

            return stamp({
                ...state,
                players: upsertPlayer(state.players, playerId, {
                    online: false
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.WHEEL_CONFIGURATION: {

            if (!payload || typeof payload !== "object") {

                return state;

            }

            return stamp({
                ...state,
                gameId: payload.gameId ?? state.gameId,
                configuration: Object.freeze({ ...payload })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.GAME_RESULT: {

            if (!payload?.winner || !payload?.winningSector) {

                return state;

            }

            return stamp({
                ...state,
                gameId: payload.gameId ?? state.gameId,
                winner: Object.freeze({ ...payload })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.PAYMENT: {

            if (!payload?.status) {

                return state;

            }

            return stamp({
                ...state,
                gameId: payload.gameId ?? state.gameId,
                payment: Object.freeze({ ...payload })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.AUDIT: {

            if (!payload?.status) {

                return state;

            }

            const cleanupObserved = payload.status === "READY"
                || payload.status === "FAILED"
                || state.lifecycle.cleanupObserved;

            return stamp({
                ...state,
                gameId: payload.gameId ?? state.gameId,
                audit: Object.freeze({ ...payload }),
                lifecycle: Object.freeze({
                    ...state.lifecycle,
                    cleanupObserved
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.SESSION_SNAPSHOT: {

            if (!payload || typeof payload !== "object") {

                return state;

            }

            const players = ingestPlayerList(
                state.players,
                payload.playerStates ?? payload.players
            );

            const rawGameState = payload.gameState;

            const gameState = typeof rawGameState === "string"
                ? rawGameState
                : (rawGameState?.currentState ?? state.gameState);

            return stamp({
                ...state,
                roomId: payload.roomId ?? state.roomId,
                gameId: payload.gameId ?? state.gameId,
                players,
                gameState,
                configuration: payload.wheelConfiguration
                    ? Object.freeze({ ...payload.wheelConfiguration })
                    : state.configuration,
                winner: payload.gameResult
                    ? Object.freeze({ ...payload.gameResult })
                    : state.winner,
                payment: payload.payment
                    ? Object.freeze({ ...payload.payment })
                    : state.payment,
                audit: payload.audit
                    ? Object.freeze({ ...payload.audit })
                    : state.audit,
                recovery: Object.freeze({
                    receivedAt: Date.now(),
                    gameId: payload.gameId ?? null,
                    gameState: typeof gameState === "string" ? gameState : null
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.SESSION_RECOVERY_FAILED: {

            return stamp({
                ...state,
                recovery: Object.freeze({
                    failed: true,
                    reason: payload?.message ?? payload?.reason ?? null,
                    receivedAt: Date.now()
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.GAME_END: {

            return stamp({
                ...state,
                gameId: payload.gameId ?? state.gameId,
                lifecycle: Object.freeze({
                    ...state.lifecycle,
                    gameEnded: true,
                    cleanupObserved: true
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.RESET:

            return { ...AUTHORITATIVE_SESSION_INITIAL_STATE };

        default:

            return state;

    }

}

/**
 * Tiny external-store wrapper used by the React context. Still only reduces
 * authoritative actions — no timers, no defaults fabrication.
 */
export function createAuthoritativeSessionStore() {

    let state = { ...AUTHORITATIVE_SESSION_INITIAL_STATE };

    const listeners = new Set();

    function notify() {

        listeners.forEach((listener) => listener());

    }

    return {

        getSnapshot() {

            return state;

        },

        subscribe(listener) {

            listeners.add(listener);

            return () => {

                listeners.delete(listener);

            };

        },

        dispatch(action) {

            const next = authoritativeSessionReducer(state, action);

            if (next === state) {

                return state;

            }

            state = next;

            notify();

            return state;

        },

        reset() {

            state = { ...AUTHORITATIVE_SESSION_INITIAL_STATE };

            notify();

            return state;

        }

    };

}
