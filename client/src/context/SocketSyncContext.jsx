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

import { BUTTON_STATES } from "../game/centralButton";

import socket from "../socket/socket";

import {
    OUTGOING_SOCKET_EVENTS,
    SOCKET_CONNECTION_STATES
} from "../socket/socketEvents";

import { SocketSyncLayer } from "../socket/SocketSyncLayer";

import { useEngineBridge } from "./EngineBridgeContext";

import { useCentralButton } from "./CentralButtonContext";

const INITIAL_STATUS = {
    connectionState: SOCKET_CONNECTION_STATES.DISCONNECTED,
    connected: false,
    lastIncoming: null,
    lastOutgoing: null,
    pingMs: null,
    socketId: null
};

const SocketSyncContext = createContext(null);

export function SocketSyncProvider({ children, autoConnect = true }) {

    const bridge = useEngineBridge();

    const { subscribeToButtonEvents } = useCentralButton();

    const layerRef = useRef(null);

    const statusRef = useRef(INITIAL_STATUS);

    const listenersRef = useRef(new Set());

    const notifyListeners = useCallback(() => {

        listenersRef.current.forEach((listener) => listener());

    }, []);

    const subscribeStatus = useCallback((listener) => {

        listenersRef.current.add(listener);

        return () => {

            listenersRef.current.delete(listener);

        };

    }, []);

    const getStatusSnapshot = useCallback(() => statusRef.current, []);

    useEffect(() => {

        const layer = new SocketSyncLayer(socket, {
            engineBridge: bridge,
            devMode: DEV_MODE,
            onStatusChange: (status) => {

                statusRef.current = status;

                notifyListeners();

            }
        });

        layerRef.current = layer;

        statusRef.current = layer.getStatus();

        notifyListeners();

        if (autoConnect) {

            layer.connect();

        }

        return () => {

            layer.dispose();

            layerRef.current = null;

            statusRef.current = INITIAL_STATUS;

            notifyListeners();

        };

    }, [bridge, autoConnect, notifyListeners]);

    useEffect(() => {

        const layer = layerRef.current;

        if (!layer) {

            return undefined;

        }

        const unsubscribe = subscribeToButtonEvents((event) => {

            if (event.type === "preGameReadyConfirm") {

                layer.send(OUTGOING_SOCKET_EVENTS.PLAYER_READY_CONFIRM, {});

                return;

            }

            const outgoingType = event.type === "press"
                ? OUTGOING_SOCKET_EVENTS.BUTTON_PRESS
                : OUTGOING_SOCKET_EVENTS.BUTTON_RELEASE;

            layer.send(outgoingType, {
                buttonState: event.buttonState,
                pressCount: event.pressCount
            });

            if (event.type === "release"
                && event.buttonState === BUTTON_STATES.PUSH) {

                layer.send(OUTGOING_SOCKET_EVENTS.PLAYER_READY, {});

            }

        });

        return unsubscribe;

    }, [subscribeToButtonEvents]);

    useEffect(() => {

        const layer = layerRef.current;

        if (!layer || !autoConnect) {

            return undefined;

        }

        const intervalId = window.setInterval(() => {

            if (layer.getStatus().connected) {

                layer.sendPing();

            }

        }, 30000);

        return () => window.clearInterval(intervalId);

    }, [autoConnect]);

    const send = useCallback((type, payload) => {

        return layerRef.current?.send(type, payload) ?? null;

    }, []);

    const sendPing = useCallback(() => {

        return layerRef.current?.sendPing() ?? null;

    }, []);

    const dispatchLocal = useCallback((message) => {

        return layerRef.current?.dispatchLocal(message) ?? null;

    }, []);

    const disconnectSocket = useCallback(() => {

        layerRef.current?.disconnect();

    }, []);

    const value = useMemo(() => ({
        send,
        sendPing,
        dispatchLocal,
        disconnectSocket,
        subscribeStatus,
        getStatusSnapshot
    }), [send, sendPing, dispatchLocal, disconnectSocket, subscribeStatus, getStatusSnapshot]);

    return (

        <SocketSyncContext.Provider value={value}>

            {children}

        </SocketSyncContext.Provider>

    );

}

export function useSocketSync() {

    const context = useContext(SocketSyncContext);

    if (!context) {

        throw new Error(
            "useSocketSync must be used within SocketSyncProvider"
        );

    }

    return context;

}

export function useSocketDebugStatus() {

    const { subscribeStatus, getStatusSnapshot } = useSocketSync();

    return useSyncExternalStore(
        subscribeStatus,
        getStatusSnapshot,
        getStatusSnapshot
    );

}

function formatSocketEvent(message) {

    if (!message) {

        return "—";

    }

    return message.type;

}

export function formatSocketDebugLines(status) {

    return {
        connectionState: status.connectionState,
        socketId: status.socketId || "—",
        lastIncoming: formatSocketEvent(status.lastIncoming),
        lastOutgoing: formatSocketEvent(status.lastOutgoing),
        pingMs: status.pingMs === null ? "—" : `${status.pingMs} ms`
    };

}
