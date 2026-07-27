import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState
} from "react";

import { DEV_MODE } from "../config/devMode";

import {
    APP_PAGES,
    RECOVERY_UI_STATUS,
    canRecoverPreGame,
    hasGameplayIdentity,
    isGameplayPage,
    isSetupRecoveryPage,
    resolveGameplayRecoveryPage
} from "../game/sessionRecovery/recoveryFlow";

import { RECOVERY_SOCKET_EVENTS } from "../game/sessionRecovery/sessionRecoveryEvents";

import {
    INCOMING_SOCKET_EVENTS,
    SOCKET_MESSAGE_CHANNEL
} from "../socket/socketEvents";

import socket from "../socket/socket";

import { useGameResultRecovery } from "./GameResultContext";

import { useAuthoritativeSession } from "./AuthoritativeSessionContext";

import { useGameSession } from "./GameSessionContext";

import {
    readStoredRecoveryPage,
    usePlayerIdentity,
    writeStoredRecoveryPage
} from "./PlayerIdentityContext";

const RecoveryExperienceContext = createContext(null);

const OVERLAY_HIDE_MS = 2000;

function devLog(message) {

    if (DEV_MODE) {

        console.debug(`[RecoveryExperience] ${message}`);

    }

}

/** R6.2A — INFO recovery-trace only; does not affect behaviour. */
function recoveryTrace(stage, { roomId = null, playerId = null } = {}) {

    console.info(
        `[R6.2A Recovery] ${stage}`
        + ` | roomId=${roomId ?? "null"}`
        + ` | playerId=${playerId ?? "null"}`
        + ` | socket.id=${socket.id ?? "null"}`
    );

}

export function RecoveryExperienceProvider({
    children,
    currentPage,
    onNavigate
}) {

    const { applyRecoverySnapshot } = useGameResultRecovery();

    const { session, destroySession } = useGameSession();

    const authoritative = useAuthoritativeSession();

    const { getIdentity, clearIdentity } = usePlayerIdentity();

    const [status, setStatus] = useState(RECOVERY_UI_STATUS.IDLE);

    const pendingGameplaySnapshotRef = useRef(null);

    const recoveryInFlightRef = useRef(false);

    const hadDisconnectRef = useRef(false);

    const hideOverlayTimerRef = useRef(null);

    const clearOverlayTimer = useCallback(() => {

        if (hideOverlayTimerRef.current) {

            clearTimeout(hideOverlayTimerRef.current);

            hideOverlayTimerRef.current = null;

        }

    }, []);

    const scheduleOverlayHide = useCallback(() => {

        clearOverlayTimer();

        hideOverlayTimerRef.current = setTimeout(() => {

            setStatus(RECOVERY_UI_STATUS.IDLE);

            hideOverlayTimerRef.current = null;

        }, OVERLAY_HIDE_MS);

    }, [clearOverlayTimer]);

    /**
     * R6.1 — Authoritative recovery for Setup Session and gameplay.
     * Sends a playerId/roomId claim used only as a server stash lookup key.
     */
    const requestSessionRecovery = useCallback(() => {

        const identity = getIdentity();

        if (!hasGameplayIdentity(identity) || recoveryInFlightRef.current) {

            return;

        }

        recoveryInFlightRef.current = true;

        setStatus(RECOVERY_UI_STATUS.RECONNECTING);

        devLog("Recovery requested");

        socket.emit(SOCKET_MESSAGE_CHANNEL, {
            type: RECOVERY_SOCKET_EVENTS.SESSION_RECOVERY_REQUEST,
            payload: {
                timestamp: Date.now(),
                playerId: identity.playerId,
                roomId: identity.roomId
            }
        });

        recoveryTrace("SESSION_RECOVERY_REQUEST sent", identity);

    }, [getIdentity]);

    const handleSetupRecoveryComplete = useCallback(() => {

        if (!recoveryInFlightRef.current) {

            return;

        }

        recoveryInFlightRef.current = false;

        const restoredPage = readStoredRecoveryPage();

        if (
            restoredPage
            && isSetupRecoveryPage(restoredPage)
            && restoredPage !== currentPage
        ) {

            onNavigate(restoredPage);

        }

        setStatus(RECOVERY_UI_STATUS.COMPLETE);

        recoveryTrace("overlay COMPLETE", getIdentity());

        devLog(`Setup Session restored on page ${restoredPage ?? currentPage}`);

        scheduleOverlayHide();

    }, [currentPage, onNavigate, scheduleOverlayHide, getIdentity]);

    const handlePreGameReconnect = useCallback(() => {

        if (!canRecoverPreGame(session, authoritative.setup)) {

            recoveryInFlightRef.current = false;

            devLog("Setup timer expired — returning to welcome");

            destroySession();

            clearIdentity();

            onNavigate(APP_PAGES.WELCOME);

            setStatus(RECOVERY_UI_STATUS.FAILED);

            recoveryTrace("overlay FAILED", getIdentity());

            scheduleOverlayHide();

            return;

        }

        // R6.1 — Real server rebind; do not restore UI alone.
        requestSessionRecovery();

    }, [
        session,
        authoritative.setup,
        destroySession,
        clearIdentity,
        onNavigate,
        scheduleOverlayHide,
        requestSessionRecovery,
        getIdentity
    ]);

    const handleGameplaySnapshot = useCallback((payload) => {

        recoveryInFlightRef.current = false;

        setStatus(RECOVERY_UI_STATUS.RESTORING);

        devLog("Snapshot received");

        const targetPage = resolveGameplayRecoveryPage(payload);

        if (!targetPage) {

            setStatus(RECOVERY_UI_STATUS.FAILED);

            recoveryTrace("overlay FAILED", getIdentity());

            scheduleOverlayHide();

            return;

        }

        if (targetPage === APP_PAGES.RESULT) {

            applyRecoverySnapshot(payload);

            if (currentPage !== APP_PAGES.RESULT) {

                onNavigate(APP_PAGES.RESULT);

            }

            devLog("Opening Page6");

        } else if (currentPage !== APP_PAGES.GAMEPLAY) {

            pendingGameplaySnapshotRef.current = payload;

            onNavigate(APP_PAGES.GAMEPLAY);

            devLog("Opening Page5");

        }

        setStatus(RECOVERY_UI_STATUS.COMPLETE);

        recoveryTrace("overlay COMPLETE", getIdentity());

        devLog("Recovery complete");

        scheduleOverlayHide();

    }, [
        applyRecoverySnapshot,
        currentPage,
        onNavigate,
        scheduleOverlayHide,
        getIdentity
    ]);

    const handleRecoveryFailed = useCallback((payload) => {

        recoveryInFlightRef.current = false;

        setStatus(RECOVERY_UI_STATUS.FAILED);

        recoveryTrace("SESSION_RECOVERY_FAILED received", {
            roomId: payload?.roomId ?? getIdentity().roomId,
            playerId: payload?.playerId ?? getIdentity().playerId
        });

        recoveryTrace("overlay FAILED", {
            roomId: payload?.roomId ?? getIdentity().roomId,
            playerId: payload?.playerId ?? getIdentity().playerId
        });

        devLog(`Recovery failed: ${payload?.reason ?? "unknown"}`);

        if (
            isSetupRecoveryPage(currentPage)
            || currentPage === APP_PAGES.WELCOME
        ) {

            destroySession();

            clearIdentity();

            if (currentPage !== APP_PAGES.WELCOME) {

                onNavigate(APP_PAGES.WELCOME);

            }

            scheduleOverlayHide();

        }

    }, [
        currentPage,
        destroySession,
        clearIdentity,
        onNavigate,
        scheduleOverlayHide,
        getIdentity
    ]);

    const returnToLobby = useCallback(() => {

        clearIdentity();

        pendingGameplaySnapshotRef.current = null;

        recoveryInFlightRef.current = false;

        clearOverlayTimer();

        setStatus(RECOVERY_UI_STATUS.IDLE);

        onNavigate(APP_PAGES.LOBBY);

    }, [clearIdentity, clearOverlayTimer, onNavigate]);

    const consumePendingGameplaySnapshot = useCallback(() => {

        const snapshot = pendingGameplaySnapshotRef.current;

        pendingGameplaySnapshotRef.current = null;

        return snapshot;

    }, []);

    // Persist page so a refresh can return to the same Setup Session surface.
    useEffect(() => {

        if (isSetupRecoveryPage(currentPage) || isGameplayPage(currentPage)) {

            writeStoredRecoveryPage(currentPage);

        }

    }, [currentPage]);

    // Scenario C — browser refresh: identity restored from sessionStorage;
    // request authoritative reclaim once the socket is connected.
    useEffect(() => {

        const identity = getIdentity();

        if (!hasGameplayIdentity(identity)) {

            return;

        }

        if (currentPage !== APP_PAGES.WELCOME) {

            return;

        }

        const storedPage = readStoredRecoveryPage();

        if (!storedPage || !isSetupRecoveryPage(storedPage)) {

            return;

        }

        function tryBootRecovery() {

            if (!socket.connected || recoveryInFlightRef.current) {

                return;

            }

            hadDisconnectRef.current = true;

            setStatus(RECOVERY_UI_STATUS.RECONNECTING);

            requestSessionRecovery();

        }

        if (socket.connected) {

            tryBootRecovery();

        }

        socket.on("connect", tryBootRecovery);

        return () => {

            socket.off("connect", tryBootRecovery);

        };

    }, [currentPage, getIdentity, requestSessionRecovery]);

    useEffect(() => {

        function onConnect() {

            if (!hadDisconnectRef.current) {

                return;

            }

            recoveryTrace("reconnect", getIdentity());

            devLog("Reconnect detected");

            if (isSetupRecoveryPage(currentPage)) {

                handlePreGameReconnect();

                hadDisconnectRef.current = false;

                return;

            }

            if (isGameplayPage(currentPage)) {

                requestSessionRecovery();

                hadDisconnectRef.current = false;

            }

        }

        function onDisconnect() {

            if (!isSetupRecoveryPage(currentPage) && !isGameplayPage(currentPage)) {

                return;

            }

            hadDisconnectRef.current = true;

            setStatus(RECOVERY_UI_STATUS.RECONNECTING);

            recoveryTrace("disconnect", getIdentity());

            devLog("Disconnect detected");

        }

        function onGameMessage(rawMessage) {

            const type = rawMessage?.type;

            if (type === RECOVERY_SOCKET_EVENTS.SESSION_SNAPSHOT) {

                if (isGameplayPage(currentPage) || pendingGameplaySnapshotRef.current !== null) {

                    handleGameplaySnapshot(rawMessage.payload);

                }

                return;

            }

            if (type === RECOVERY_SOCKET_EVENTS.SESSION_RECOVERY_FAILED) {

                handleRecoveryFailed(rawMessage.payload);

            }

        }

        function onSetupSessionSync(payload) {

            recoveryTrace("SETUP_SESSION_SYNC received", {
                roomId: payload?.roomId ?? getIdentity().roomId,
                playerId: getIdentity().playerId
            });

            if (isSetupRecoveryPage(currentPage)) {

                handleSetupRecoveryComplete();

            }

        }

        socket.on("connect", onConnect);

        socket.on("disconnect", onDisconnect);

        socket.on(SOCKET_MESSAGE_CHANNEL, onGameMessage);

        socket.on(INCOMING_SOCKET_EVENTS.SETUP_SESSION_SYNC, onSetupSessionSync);

        return () => {

            socket.off("connect", onConnect);

            socket.off("disconnect", onDisconnect);

            socket.off(SOCKET_MESSAGE_CHANNEL, onGameMessage);

            socket.off(
                INCOMING_SOCKET_EVENTS.SETUP_SESSION_SYNC,
                onSetupSessionSync
            );

            clearOverlayTimer();

        };

    }, [
        currentPage,
        handlePreGameReconnect,
        requestSessionRecovery,
        handleGameplaySnapshot,
        handleRecoveryFailed,
        handleSetupRecoveryComplete,
        clearOverlayTimer,
        getIdentity
    ]);

    const value = useMemo(() => ({
        status,
        consumePendingGameplaySnapshot,
        returnToLobby
    }), [status, consumePendingGameplaySnapshot, returnToLobby]);

    return (

        <RecoveryExperienceContext.Provider value={value}>

            {children}

        </RecoveryExperienceContext.Provider>

    );

}

export function useRecoveryExperience() {

    const context = useContext(RecoveryExperienceContext);

    if (!context) {

        throw new Error(
            "useRecoveryExperience must be used within RecoveryExperienceProvider"
        );

    }

    return context;

}
