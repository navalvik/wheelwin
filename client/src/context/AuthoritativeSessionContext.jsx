import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useSyncExternalStore
} from "react";

import { DEV_MODE } from "../config/devMode";

import { bindAuthoritativeSessionStore } from "../game/gameAuthority";

import {
    AUTHORITATIVE_SESSION_ACTIONS,
    createAuthoritativeSessionStore
} from "../game/session";

import { useRegisterEngineModule } from "./EngineBridgeContext";
import { usePlayerIdentity } from "./PlayerIdentityContext";

const AuthoritativeSessionContext = createContext(null);

function logSession(state) {

    if (!DEV_MODE) {

        return;

    }

    console.debug("[AuthoritativeSession]", {
        lastEventType: state.lastEventType,
        roomId: state.roomId,
        maxPlayers: state.maxPlayers,
        gameId: state.gameId,
        gameState: state.gameState,
        playerCount: Object.keys(state.players).length,
        hasConfiguration: Boolean(state.configuration),
        hasWinner: Boolean(state.winner),
        paymentStatus: state.payment?.status ?? null,
        auditStatus: state.audit?.status ?? null,
        recovery: state.recovery,
        lifecycle: state.lifecycle
    });

}

/**
 * C5.2 — Read-only subscription layer.
 *
 * Registers as an EngineBridge module so session updates arrive through the
 * existing SocketSyncLayer → SocketDispatcher path (no extra socket listeners).
 * GameSessionContext retains only unmigrated pre-game finance fields.
 */
export function AuthoritativeSessionProvider({ children }) {

    const storeRef = useRef(null);

    const { setIdentity } = usePlayerIdentity();

    if (!storeRef.current) {

        storeRef.current = createAuthoritativeSessionStore();

        // Bind immediately so isServerAuthoritative() can read lifecycle
        // before the mount effect runs (C5.9A).
        bindAuthoritativeSessionStore(storeRef.current);

    }

    const store = storeRef.current;

    useEffect(() => {

        return store.subscribe(() => {

            logSession(store.getSnapshot());

        });

    }, [store]);

    useEffect(() => {

        bindAuthoritativeSessionStore(store);

        return () => {

            store.reset();

            bindAuthoritativeSessionStore(null);

        };

    }, [store]);

    useRegisterEngineModule("authoritativeSession", () => ({

        onGameStart: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.GAME_START,
                payload
            });

            // Bind local playerId for every recipient (Host + guests). startGame
            // already carries per-socket playerId; keep identity in sync so
            // Verify highlight does not depend on Lobby still being mounted.
            if (payload?.playerId) {

                setIdentity({
                    roomId: payload.roomId ?? null,
                    gameId: payload.gameId ?? null,
                    playerId: payload.playerId
                });

            }

            // startGame carries the Setup Session snapshot so every client —
            // including the filling player who may have missed SYNC — gets
            // expiresAt for the InfoBar Setup Timer.
            if (payload?.setup) {

                store.dispatch({
                    type: AUTHORITATIVE_SESSION_ACTIONS.SETUP_SESSION,
                    payload: payload.setup
                });

            }

        },

        onGameState: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.GAME_STATE,
                payload
            });

        },

        onClockUpdate: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.GAME_CLOCK,
                payload
            });

        },

        onPlayerUpdate: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.PLAYER_UPDATE,
                payload
            });

        },

        onPlayerOnline: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.PLAYER_ONLINE,
                payload
            });

        },

        onPlayerOffline: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.PLAYER_OFFLINE,
                payload
            });

        },

        onWheelConfiguration: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.WHEEL_CONFIGURATION,
                payload
            });

        },

        onGameResult: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.GAME_RESULT,
                payload
            });

        },

        onPayment: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.PAYMENT,
                payload
            });

        },

        onAudit: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.AUDIT,
                payload
            });

        },

        onSessionSnapshot: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.SESSION_SNAPSHOT,
                payload
            });

        },

        onSessionRecoveryFailed: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.SESSION_RECOVERY_FAILED,
                payload
            });

        },

        onSetupSession: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.SETUP_SESSION,
                payload
            });

        },

        onSetupSessionExpired: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.SETUP_SESSION_EXPIRED,
                payload
            });

        },

        onVerifyCompleted: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.VERIFY_COMPLETED,
                payload
            });

        },

        onPaymentStageReady: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_STAGE_READY,
                payload
            });

        },

        onEntryPaymentSessionUpdated: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.ENTRY_PAYMENT_SESSION_UPDATED,
                payload
            });

        },

        onEntryPaymentCompleted: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.ENTRY_PAYMENT_COMPLETED,
                payload
            });

        },

        onGameplayTimer: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.GAMEPLAY_TIMER,
                payload
            });

        },

        onGameEnd: (payload) => {

            store.dispatch({
                type: AUTHORITATIVE_SESSION_ACTIONS.GAME_END,
                payload
            });

        }

    }));

    const value = useMemo(() => ({
        getSnapshot: () => store.getSnapshot(),
        subscribe: (listener) => store.subscribe(listener)
    }), [store]);

    return (

        <AuthoritativeSessionContext.Provider value={value}>

            {children}

        </AuthoritativeSessionContext.Provider>

    );

}

export function useAuthoritativeSession() {

    const context = useContext(AuthoritativeSessionContext);

    if (!context) {

        throw new Error(
            "useAuthoritativeSession must be used within AuthoritativeSessionProvider"
        );

    }

    return useSyncExternalStore(
        context.subscribe,
        context.getSnapshot,
        context.getSnapshot
    );

}

export function useAuthoritativeSessionStore() {

    const context = useContext(AuthoritativeSessionContext);

    if (!context) {

        throw new Error(
            "useAuthoritativeSessionStore must be used within AuthoritativeSessionProvider"
        );

    }

    return context;

}
