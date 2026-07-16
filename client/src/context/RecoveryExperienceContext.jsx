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
    isPreGamePage,
    resolveGameplayRecoveryPage
} from "../game/sessionRecovery/recoveryFlow";

import { RECOVERY_SOCKET_EVENTS } from "../game/sessionRecovery/sessionRecoveryEvents";

import { SOCKET_MESSAGE_CHANNEL } from "../socket/socketEvents";

import socket from "../socket/socket";

import { useGameResultRecovery } from "./GameResultContext";

import { useAuthoritativeSession } from "./AuthoritativeSessionContext";

import { useGameSession } from "./GameSessionContext";

import { usePlayerIdentity } from "./PlayerIdentityContext";

const RecoveryExperienceContext = createContext(null);

const OVERLAY_HIDE_MS = 2000;

function devLog(message) {

    if (DEV_MODE) {

        console.debug(`[RecoveryExperience] ${message}`);

    }

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

    const requestGameplayRecovery = useCallback(() => {

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
                timestamp: Date.now()
            }
        });

    }, [getIdentity]);

    const handlePreGameReconnect = useCallback(() => {

        if (!canRecoverPreGame(session, authoritative.setup)) {

            devLog("Setup timer expired — returning to welcome");

            destroySession();

            clearIdentity();

            onNavigate(APP_PAGES.WELCOME);

            setStatus(RECOVERY_UI_STATUS.FAILED);

            scheduleOverlayHide();

            return;

        }

        setStatus(RECOVERY_UI_STATUS.COMPLETE);

        devLog(`Pre-game restored on page ${currentPage}`);

        scheduleOverlayHide();

    }, [
        session,
        authoritative.setup,
        destroySession,
        clearIdentity,
        onNavigate,
        currentPage,
        scheduleOverlayHide
    ]);

    const handleGameplaySnapshot = useCallback((payload) => {

        recoveryInFlightRef.current = false;

        setStatus(RECOVERY_UI_STATUS.RESTORING);

        devLog("Snapshot received");

        const targetPage = resolveGameplayRecoveryPage(payload);

        if (!targetPage) {

            setStatus(RECOVERY_UI_STATUS.FAILED);

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

        devLog("Recovery complete");

        scheduleOverlayHide();

    }, [
        applyRecoverySnapshot,
        currentPage,
        onNavigate,
        scheduleOverlayHide
    ]);

    const handleRecoveryFailed = useCallback(() => {

        recoveryInFlightRef.current = false;

        setStatus(RECOVERY_UI_STATUS.FAILED);

        devLog("Recovery failed");

    }, []);

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

    useEffect(() => {

        function onConnect() {

            if (!hadDisconnectRef.current) {

                return;

            }

            devLog("Reconnect detected");

            if (isPreGamePage(currentPage)) {

                handlePreGameReconnect();

                hadDisconnectRef.current = false;

                return;

            }

            if (isGameplayPage(currentPage)) {

                requestGameplayRecovery();

                hadDisconnectRef.current = false;

            }

        }

        function onDisconnect() {

            if (!isPreGamePage(currentPage) && !isGameplayPage(currentPage)) {

                return;

            }

            hadDisconnectRef.current = true;

            setStatus(RECOVERY_UI_STATUS.RECONNECTING);

            devLog("Reconnect detected");

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

        socket.on("connect", onConnect);

        socket.on("disconnect", onDisconnect);

        socket.on(SOCKET_MESSAGE_CHANNEL, onGameMessage);

        return () => {

            socket.off("connect", onConnect);

            socket.off("disconnect", onDisconnect);

            socket.off(SOCKET_MESSAGE_CHANNEL, onGameMessage);

            clearOverlayTimer();

        };

    }, [
        currentPage,
        handlePreGameReconnect,
        requestGameplayRecovery,
        handleGameplaySnapshot,
        handleRecoveryFailed,
        clearOverlayTimer
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
