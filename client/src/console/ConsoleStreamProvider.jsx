import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useSyncExternalStore
} from "react";

import { ConsoleStreamLayer } from "./ConsoleStreamLayer";
import { CONSOLE_STORE_INITIAL_STATE } from "./consoleStore";

const ConsoleStreamContext = createContext(null);

/**
 * R6.0D / R6.1 — Live projections from `/console`.
 * Connects only when autoConnect is true (after developer auth when required).
 */
export function ConsoleStreamProvider({
    children,
    autoConnect = true,
    accessToken = null
}) {

    const layerRef = useRef(null);

    const stateRef = useRef(CONSOLE_STORE_INITIAL_STATE);

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

    const getSnapshot = useCallback(() => stateRef.current, []);

    useEffect(() => {

        const layer = new ConsoleStreamLayer({
            accessToken,
            onStateChange: (nextState) => {

                stateRef.current = nextState;

                notifyListeners();

            }
        });

        layerRef.current = layer;

        stateRef.current = layer.getState();

        notifyListeners();

        if (autoConnect) {

            layer.connect();

        }

        return () => {

            layer.dispose();

            layerRef.current = null;

            stateRef.current = CONSOLE_STORE_INITIAL_STATE;

            notifyListeners();

        };
        // Recreate transport when auth token identity changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoConnect, accessToken, notifyListeners]);

    const setFocus = useCallback((focus) => {

        layerRef.current?.setFocus(focus);

    }, []);

    const value = {
        subscribe,
        getSnapshot,
        setFocus
    };

    return (

        <ConsoleStreamContext.Provider value={value}>

            {children}

        </ConsoleStreamContext.Provider>

    );

}

function useConsoleStreamContext() {

    const context = useContext(ConsoleStreamContext);

    if (!context) {

        throw new Error(
            "Console stream hooks require ConsoleStreamProvider"
        );

    }

    return context;

}

export function useConsoleStreamState() {

    const { subscribe, getSnapshot } = useConsoleStreamContext();

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

}

export function useConsoleConnectionStatus() {

    const state = useConsoleStreamState();

    return {
        connectionState: state.connectionState,
        connected: state.connected,
        subscribed: state.subscribed,
        socketId: state.socketId
    };

}

export function useConsoleFocus() {

    const { setFocus } = useConsoleStreamContext();

    const state = useConsoleStreamState();

    return {
        focus: state.focus,
        setFocus
    };

}

export function useConsoleProjection(key) {

    const { subscribe, getSnapshot } = useConsoleStreamContext();

    const getKeySnapshot = useCallback(
        () => getSnapshot()[key] ?? null,
        [getSnapshot, key]
    );

    return useSyncExternalStore(subscribe, getKeySnapshot, getKeySnapshot);

}
