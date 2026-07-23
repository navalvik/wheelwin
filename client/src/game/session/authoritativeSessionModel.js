/**
 * C5.2 — Authoritative Session Model (foundation).
 *
 * Mirrors the server session. Does NOT generate data, fabricate defaults,
 * calculate gameplay, drive timers, invent payment statuses, or decide winners.
 * Every field stays null/empty until an authoritative socket payload arrives.
 *
 * -------------------------------------------------------------------------
 * Session ownership map (post C5 migration)
 * -------------------------------------------------------------------------
 *
 * Field                                 | Owner
 * --------------------------------------|----------------------------------
 * roomId, maxPlayers, player roster     | AuthoritativeSession (C5.3/C5.4)
 * setup timer (startedAt/expiresAt)     | AuthoritativeSession.setup (C5.6C)
 * payment display (Page4)               | AuthoritativeSession.entryPayment (C5.8C)
 * settlement payment (Page6)            | AuthoritativeSession.payment (C5.5)
 * baseStake / paymentGram (Page3)       | GameSessionContext (pending migration)
 * currentPhase (pre-game shell)         | GameSessionContext (InfoBar label gate)
 * gameState, clock, physics, winner     | AuthoritativeSession + gameplay contexts
 * currentPage                           | App.jsx (client navigation shell)
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
    SETUP_SESSION: "SETUP_SESSION",
    SETUP_SESSION_EXPIRED: "SETUP_SESSION_EXPIRED",
    VERIFY_COMPLETED: "VERIFY_COMPLETED",
    PAYMENT_STAGE_READY: "PAYMENT_STAGE_READY",
    ENTRY_PAYMENT_SESSION_UPDATED: "ENTRY_PAYMENT_SESSION_UPDATED",
    ENTRY_PAYMENT_COMPLETED: "ENTRY_PAYMENT_COMPLETED",
    WALLET_CONNECTION_SESSION_UPDATED: "WALLET_CONNECTION_SESSION_UPDATED",
    PAYMENT_CONNECTION_READY: "PAYMENT_CONNECTION_READY",
    PAYMENT_SESSION_CREATED: "PAYMENT_SESSION_CREATED",
    PAYMENT_SESSION_UPDATED: "PAYMENT_SESSION_UPDATED",
    PAYMENT_REQUEST: "PAYMENT_REQUEST",
    PAYMENT_SESSION_COMPLETED: "PAYMENT_SESSION_COMPLETED",
    PAYMENT_SESSION_FAILED: "PAYMENT_SESSION_FAILED",
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
    entryPayment: null,
    walletConnection: null,
    paymentSession: null,
    audit: null,
    winner: null,
    recovery: null,
    setup: null,
    lifecycle: Object.freeze({
        gameStarted: false,
        gameEnded: false,
        cleanupObserved: false,
        verifyCompleted: false,
        paymentStageReady: false,
        entryPaymentCompleted: false,
        paymentConnectionReady: false
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

const PRESERVE_WHEN_NULL = new Set([
    "nickname",
    "age",
    "icon",
    "color",
    "sectorCount",
    "sectorArrangement",
    "sectorLabel",
    "sectorValue",
    "wallet",
    "name"
]);

function upsertPlayer(players, playerId, patch) {

    if (!playerId) {

        return players;

    }

    const previous = players[playerId] ?? Object.freeze({ playerId });

    const next = {
        ...previous
    };

    for (const [key, value] of Object.entries(patch ?? {})) {

        if (key === "playerId") {

            continue;

        }

        // Redacted Verify-barrier updates use nulls — never wipe fields the
        // local client already received via a private reveal ack.
        if (
            (value === null || value === undefined)
            && PRESERVE_WHEN_NULL.has(key)
            && previous[key] != null
        ) {

            continue;

        }

        next[key] = value;

    }

    next.playerId = playerId;

    return freezePlayers({
        ...players,
        [playerId]: Object.freeze(next)
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
                entryPayment: null,
                walletConnection: null,
                paymentSession: null,
                lifecycle: Object.freeze({
                    ...state.lifecycle,
                    gameStarted: true,
                    gameEnded: false,
                    cleanupObserved: false,
                    verifyCompleted: false,
                    paymentStageReady: false,
                    entryPaymentCompleted: false,
                    paymentConnectionReady: false
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

        case AUTHORITATIVE_SESSION_ACTIONS.SETUP_SESSION: {

            if (!payload?.setupSessionId || !payload?.startedAt || !payload?.expiresAt) {

                return state;

            }

            return stamp({
                ...state,
                roomId: payload.roomId ?? state.roomId,
                setup: Object.freeze({
                    setupSessionId: payload.setupSessionId,
                    roomId: payload.roomId ?? null,
                    startedAt: payload.startedAt,
                    expiresAt: payload.expiresAt,
                    remainingTime: Number.isFinite(payload.remainingTime)
                        ? payload.remainingTime
                        : Math.max(0, payload.expiresAt - Date.now()),
                    state: payload.state ?? null,
                    verificationState: payload.verificationState ?? null,
                    paymentPrepState: payload.paymentPrepState ?? null
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.SETUP_SESSION_EXPIRED: {

            return stamp({
                ...state,
                roomId: payload?.roomId ?? state.roomId,
                setup: null
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.VERIFY_COMPLETED: {

            const players = Array.isArray(payload?.players)
                ? ingestPlayerList(state.players, payload.players)
                : state.players;

            return stamp({
                ...state,
                roomId: payload?.roomId ?? state.roomId,
                players,
                lifecycle: Object.freeze({
                    ...state.lifecycle,
                    verifyCompleted: true
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_STAGE_READY: {

            return stamp({
                ...state,
                roomId: payload?.roomId ?? state.roomId,
                lifecycle: Object.freeze({
                    ...state.lifecycle,
                    paymentStageReady: true
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.ENTRY_PAYMENT_SESSION_UPDATED: {

            if (!payload || typeof payload !== "object") {

                return state;

            }

            const players = Array.isArray(payload.players)
                ? Object.freeze(
                    payload.players.map((player) => Object.freeze({
                        playerId: player?.playerId ?? null,
                        wallet: player?.wallet ?? null,
                        paymentStatus: player?.paymentStatus ?? null
                    }))
                )
                : Object.freeze([]);

            return stamp({
                ...state,
                roomId: payload.roomId ?? state.roomId,
                entryPayment: Object.freeze({
                    roomId: payload.roomId ?? null,
                    createdAt: payload.createdAt ?? null,
                    players,
                    smartContractStatus: payload.smartContractStatus ?? null
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.ENTRY_PAYMENT_COMPLETED: {

            return stamp({
                ...state,
                roomId: payload?.roomId ?? state.roomId,
                lifecycle: Object.freeze({
                    ...state.lifecycle,
                    entryPaymentCompleted: true
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.WALLET_CONNECTION_SESSION_UPDATED: {

            if (!payload || typeof payload !== "object") {

                return state;

            }

            const players = Array.isArray(payload.players)
                ? Object.freeze(
                    payload.players.map((player) => Object.freeze({
                        playerId: player?.playerId ?? null,
                        sessionWallet: player?.sessionWallet ?? null,
                        connectedWallet: player?.connectedWallet ?? null,
                        status: player?.status ?? "WAITING"
                    }))
                )
                : Object.freeze([]);

            return stamp({
                ...state,
                roomId: payload.roomId ?? state.roomId,
                walletConnection: Object.freeze({
                    roomId: payload.roomId ?? null,
                    createdAt: payload.createdAt ?? null,
                    paymentConnectionReady:
                        payload.paymentConnectionReady === true,
                    players
                }),
                lifecycle: Object.freeze({
                    ...state.lifecycle,
                    paymentConnectionReady:
                        payload.paymentConnectionReady === true
                            ? true
                            : state.lifecycle.paymentConnectionReady
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_CONNECTION_READY: {

            return stamp({
                ...state,
                roomId: payload?.roomId ?? state.roomId,
                lifecycle: Object.freeze({
                    ...state.lifecycle,
                    paymentConnectionReady: true
                }),
                walletConnection: state.walletConnection
                    ? Object.freeze({
                        ...state.walletConnection,
                        paymentConnectionReady: true
                    })
                    : state.walletConnection
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_SESSION_CREATED:
        case AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_SESSION_UPDATED:
        case AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_SESSION_COMPLETED:
        case AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_SESSION_FAILED: {

            if (!payload || typeof payload !== "object") {

                return state;

            }

            const participants = Array.isArray(payload.participants)
                ? Object.freeze(
                    payload.participants.map((participant) => Object.freeze({
                        playerId: participant?.playerId ?? null,
                        requiredGram: participant?.requiredGram ?? null,
                        status: participant?.status ?? "WAITING",
                        wallet: participant?.wallet ?? null
                    }))
                )
                : Object.freeze([]);

            return stamp({
                ...state,
                roomId: payload.roomId ?? state.roomId,
                gameId: payload.gameId ?? state.gameId,
                paymentSession: Object.freeze({
                    paymentSessionId: payload.paymentSessionId ?? null,
                    roomId: payload.roomId ?? null,
                    gameId: payload.gameId ?? null,
                    createdAt: payload.createdAt ?? null,
                    expiresAt: payload.expiresAt ?? null,
                    status: payload.status ?? null,
                    reason: payload.reason ?? null,
                    participants
                })
            }, action.type);

        }

        case AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_REQUEST: {

            // Individual requests are informational; session UPDATED owns display.
            if (!payload || typeof payload !== "object") {

                return state;

            }

            return stamp({
                ...state,
                roomId: payload.roomId ?? state.roomId,
                gameId: payload.gameId ?? state.gameId
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
