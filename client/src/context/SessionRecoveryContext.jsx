import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useSyncExternalStore
} from "react";

import { DEV_MODE } from "../config/devMode";

import { SessionRecoveryEngine } from "../game/sessionRecovery";

import { useEngineBridge, useRegisterEngineModule } from "./EngineBridgeContext";

import { usePlayerIdentityReader } from "./PlayerIdentityContext";

import { useRecoveryExperience } from "./RecoveryExperienceContext";

import { useSocketSync } from "./SocketSyncContext";

const SessionRecoveryContext = createContext(null);

export function SessionRecoveryProvider({
    children,
    localPlayerId = 1
}) {

    const bridge = useEngineBridge();

    const { send, subscribeStatus, getStatusSnapshot } = useSocketSync();

    const getPlayerIdentity = usePlayerIdentityReader();

    const { consumePendingGameplaySnapshot } = useRecoveryExperience();

    const engineRef = useRef(null);

    const statusRef = useRef(null);

    const listenersRef = useRef(new Set());

    const notifyListeners = useCallback(() => {

        listenersRef.current.forEach((listener) => listener());

    }, []);

    const subscribe = useCallback((listener) => {

        listenersRef.current.add(listener);

        return () => {

            listenersRef.current.delete(listener);

        };

    }, []);

    const getRecoverySnapshot = useCallback(
        () => statusRef.current || engineRef.current?.getStatus() || {},
        []
    );

    useEffect(() => {

        const engine = new SessionRecoveryEngine({
            localPlayerId,
            devMode: DEV_MODE,
            getModules: () => bridge.getModules(),
            getPlayerIdentity,
            sendMessage: (type, payload) => send(type, payload),
            onStateChange: (status) => {

                statusRef.current = status;

                notifyListeners();

            }
        });

        engineRef.current = engine;

        statusRef.current = engine.getStatus();

        notifyListeners();

        const pending = consumePendingGameplaySnapshot();

        if (pending) {

            engine.restoreSession(pending);

        }

        return () => {

            engine.reset();

            engineRef.current = null;

            statusRef.current = null;

        };

    }, [bridge, localPlayerId, send, notifyListeners, getPlayerIdentity, consumePendingGameplaySnapshot]);

    const lastSocketStateRef = useRef(null);

    useEffect(() => {

        const engine = engineRef.current;

        if (!engine) {

            return undefined;

        }

        const unsubscribe = subscribeStatus(() => {

            const socketStatus = getStatusSnapshot();

            const stateKey = socketStatus.connectionState;

            if (lastSocketStateRef.current === stateKey) {

                return;

            }

            lastSocketStateRef.current = stateKey;

            engine.handleSocketStatus(socketStatus);

        });

        const initialStatus = getStatusSnapshot();

        lastSocketStateRef.current = initialStatus.connectionState;

        engine.handleSocketStatus(initialStatus);

        return unsubscribe;

    }, [subscribeStatus, getStatusSnapshot]);

    useRegisterEngineModule("sessionRecovery", () => ({

        handleSnapshot: (payload) => {

            return engineRef.current?.restoreSession(payload);

        },

        handleRecoveryFailed: (payload) => {

            engineRef.current?.handleRecoveryFailed(payload);

        },

        requestRecovery: () => {

            engineRef.current?.requestRecovery();

        }

    }));

    const value = useMemo(() => ({
        requestRecovery: () => engineRef.current?.requestRecovery(),
        restoreSession: (snapshot) => engineRef.current?.restoreSession(snapshot),
        subscribe,
        getRecoverySnapshot
    }), [subscribe, getRecoverySnapshot]);

    return (

        <SessionRecoveryContext.Provider value={value}>

            {children}

        </SessionRecoveryContext.Provider>

    );

}

export function useSessionRecovery() {

    const context = useContext(SessionRecoveryContext);

    if (!context) {

        throw new Error(
            "useSessionRecovery must be used within SessionRecoveryProvider"
        );

    }

    return context;

}

export function useSessionRecoveryDebug() {

    const { subscribe, getRecoverySnapshot } = useSessionRecovery();

    return useSyncExternalStore(subscribe, getRecoverySnapshot, getRecoverySnapshot);

}

export function formatRecoveryDebugLines(status = {}) {

    const lastRecoveryTime = status.lastRecoveryTime
        ? new Date(status.lastRecoveryTime).toLocaleTimeString()
        : "—";

    return {
        connectionState: status.connectionState || "—",
        recoveryProgress: status.recoveryProgress || "—",
        lastRecoveryTime,
        recoveredGameState: status.recoveredGameState || "—",
        recoveryMessage: status.recoveryMessage || "—"
    };

}
