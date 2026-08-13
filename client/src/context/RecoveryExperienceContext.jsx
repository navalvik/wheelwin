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
    hasGameplayIdentity,
    isGameplayPage,
    isSetupRecoveryPage,
    isTerminalRecoveryFailure,
    resolveGameplayRecoveryPage
} from "../game/sessionRecovery/recoveryFlow";

import {
    RECONNECT_CONNECT_ACTIONS,
    RECONNECTING_MAX_MS,
    resolvePostReconnectAction,
    shouldResetRecoveryInFlight
} from "../game/sessionRecovery/recoveryReconnectPolicy";

import { normalizeSessionSnapshot } from "../game/sessionRecovery/sessionSnapshotUtils";

import { page6LifecycleDiag } from "../game/result/page6LifecycleDiag";

import { webPage6Diag } from "../game/result/webPage6StateDiag";

import { logTerminalNav } from "../game/session/gameplayTerminal";

import { RECOVERY_SOCKET_EVENTS } from "../game/sessionRecovery/sessionRecoveryEvents";

import {
    INCOMING_SOCKET_EVENTS,
    SOCKET_MESSAGE_CHANNEL
} from "../socket/socketEvents";

import socket from "../socket/socket";

import { useGameResultRecovery } from "./GameResultContext";

import { useGameSession } from "./GameSessionContext";

import {
    readStoredRecoveryPage,
    usePlayerIdentity,
    writeStoredRecoveryPage
} from "./PlayerIdentityContext";

const RecoveryExperienceContext = createContext(null);

/** Soft dismiss after successful restore toast. */
const OVERLAY_HIDE_MS = 2000;

/**
 * Hard cap for COMPLETE / RESTORING overlays. Guards against a cancelled
 * soft-hide timer leaving the full-screen backdrop mounted forever.
 * Must stay above OVERLAY_HIDE_MS.
 * R17.8F — RECONNECTING uses RECONNECTING_MAX_MS (separate timer).
 * R7.70C20 — no RETURN LOBBY button; terminal failures navigate via wipe path.
 */
const OVERLAY_MAX_VISIBLE_MS = 5000;

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
    onNavigate,
    resetToWelcome = null,
    sessionGeneration = 0
}) {

    const { applyRecoverySnapshot } = useGameResultRecovery();

    const { destroySession } = useGameSession();

    const { getIdentity, clearIdentity } = usePlayerIdentity();

    const [status, setStatus] = useState(RECOVERY_UI_STATUS.IDLE);

    const pendingGameplaySnapshotRef = useRef(null);

    const recoveryInFlightRef = useRef(false);

    const hadDisconnectRef = useRef(false);

    // Timer ids live in refs so hide scheduling survives socket-effect
    // re-subscriptions (unstable onNavigate / session updates after restore).
    const hideOverlayTimerRef = useRef(null);

    const resetToWelcomeRef = useRef(resetToWelcome);

    const sessionGenerationRef = useRef(sessionGeneration);

    resetToWelcomeRef.current = resetToWelcome;

    sessionGenerationRef.current = sessionGeneration;

    const clearOverlayTimer = useCallback(() => {

        if (hideOverlayTimerRef.current) {

            clearTimeout(hideOverlayTimerRef.current);

            hideOverlayTimerRef.current = null;

        }

    }, []);

    const hideOverlay = useCallback(() => {

        clearOverlayTimer();

        setStatus(RECOVERY_UI_STATUS.IDLE);

    }, [clearOverlayTimer]);

    const scheduleOverlayHide = useCallback(() => {

        clearOverlayTimer();

        hideOverlayTimerRef.current = setTimeout(() => {

            hideOverlayTimerRef.current = null;

            setStatus(RECOVERY_UI_STATUS.IDLE);

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
                roomId: identity.roomId,
                recoveryCredential: identity.recoveryCredential ?? null
            }
        });

        recoveryTrace("SESSION_RECOVERY_REQUEST sent", {
            roomId: identity.roomId,
            playerId: identity.playerId
        });

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

    const handleGameplaySnapshot = useCallback((payload) => {

        recoveryInFlightRef.current = false;

        setStatus(RECOVERY_UI_STATUS.RESTORING);

        devLog("Snapshot received");

        // R12.5C — route from normalized snapshot so openPage6 /
        // resultSessionExpiresAt are never dropped before the decision.
        const snapshot = normalizeSessionSnapshot(payload);

        const targetPage = resolveGameplayRecoveryPage(snapshot);

        page6LifecycleDiag("RECOVERY_DECISION", {
            roomId: snapshot.roomId ?? getIdentity().roomId,
            gameId: snapshot.gameId ?? null,
            playerId: snapshot.playerId ?? getIdentity().playerId,
            currentPageBefore: currentPage,
            gameState: snapshot.gameState ?? null,
            openPage6: snapshot.openPage6 === true,
            resultSessionExpiresAt: Number.isFinite(snapshot.resultSessionExpiresAt)
                ? snapshot.resultSessionExpiresAt
                : null,
            remainingMs: Number.isFinite(snapshot.resultSessionExpiresAt)
                ? snapshot.resultSessionExpiresAt - Date.now()
                : null,
            recoveryDecision: targetPage,
            socketConnected: socket.connected === true
        });

        recoveryTrace(
            `gameplay snapshot resolved`
            + ` | targetPage=${targetPage ?? "null"}`
            + ` | openPage6=${snapshot.openPage6 === true}`
            + ` | resultSessionExpiresAt=${
                Number.isFinite(snapshot.resultSessionExpiresAt)
                    ? snapshot.resultSessionExpiresAt
                    : "null"
            }`
            + ` | currentPage=${currentPage}`,
            {
                roomId: snapshot.roomId ?? getIdentity().roomId,
                playerId: snapshot.playerId ?? getIdentity().playerId
            }
        );

        // R12.5H — openPage6 always resolves to RESULT; destroyed sessions
        // use terminal recovery failure → Page1 (not timer-based WELCOME).
        if (!targetPage) {

            setStatus(RECOVERY_UI_STATUS.FAILED);

            recoveryTrace("overlay FAILED", getIdentity());

            scheduleOverlayHide();

            return;

        }

        // R12.5D / R12.5H — never demote an active Page6 → Page5.
        // FINISH owns client exit; Result Session deadline is not a demotion trigger.
        let resolvedPage = targetPage;

        if (
            currentPage === APP_PAGES.RESULT
            && targetPage === APP_PAGES.GAMEPLAY
        ) {

            resolvedPage = APP_PAGES.RESULT;

            recoveryTrace(
                `blocked Page6 demotion | kept RESULT`
                + ` | openPage6=${snapshot.openPage6 === true}`
                + ` | resultSessionExpiresAt=${
                    Number.isFinite(snapshot.resultSessionExpiresAt)
                        ? snapshot.resultSessionExpiresAt
                        : "null"
                }`,
                {
                    roomId: snapshot.roomId ?? getIdentity().roomId,
                    playerId: snapshot.playerId ?? getIdentity().playerId
                }
            );

        }

        if (resolvedPage === APP_PAGES.RESULT) {

            applyRecoverySnapshot(snapshot);

            if (currentPage !== APP_PAGES.RESULT) {

                page6LifecycleDiag("RECOVERY_NAVIGATE", {
                    roomId: snapshot.roomId ?? getIdentity().roomId,
                    playerId: snapshot.playerId ?? getIdentity().playerId,
                    currentPageBefore: currentPage,
                    navigationTarget: APP_PAGES.RESULT,
                    recoveryDecision: targetPage,
                    resolvedPage,
                    demotionBlocked: resolvedPage !== targetPage,
                    socketConnected: socket.connected === true
                });

                webPage6Diag("NAVIGATION_PAGE6", {
                    fromPage: currentPage,
                    toPage: APP_PAGES.RESULT,
                    source: "RecoveryExperience.handleGameplaySnapshot",
                    reason: resolvedPage !== targetPage
                        ? "demotion_blocked_keep_RESULT"
                        : "recovery_open_page6",
                    currentPageBefore: currentPage,
                    currentPageAfter: APP_PAGES.RESULT,
                    resultSessionExpiresAt: Number.isFinite(snapshot.resultSessionExpiresAt)
                        ? snapshot.resultSessionExpiresAt
                        : null,
                    demotionBlocked: resolvedPage !== targetPage
                });

                onNavigate(APP_PAGES.RESULT);

            }

            devLog("Opening Page6");

        } else if (currentPage !== APP_PAGES.GAMEPLAY) {

            pendingGameplaySnapshotRef.current = snapshot;

            page6LifecycleDiag("RECOVERY_NAVIGATE", {
                roomId: snapshot.roomId ?? getIdentity().roomId,
                playerId: snapshot.playerId ?? getIdentity().playerId,
                currentPageBefore: currentPage,
                navigationTarget: APP_PAGES.GAMEPLAY,
                recoveryDecision: targetPage,
                resolvedPage,
                demotionBlocked: false,
                socketConnected: socket.connected === true
            });

            webPage6Diag("NAVIGATION_PAGE5", {
                fromPage: currentPage,
                toPage: APP_PAGES.GAMEPLAY,
                source: "RecoveryExperience.handleGameplaySnapshot",
                reason: "recovery_open_page5",
                currentPageBefore: currentPage,
                currentPageAfter: APP_PAGES.GAMEPLAY,
                resultSessionExpiresAt: Number.isFinite(snapshot.resultSessionExpiresAt)
                    ? snapshot.resultSessionExpiresAt
                    : null
            });

            onNavigate(APP_PAGES.GAMEPLAY);

            devLog("Opening Page5");

        }

        setStatus(RECOVERY_UI_STATUS.COMPLETE);

        recoveryTrace(
            `overlay COMPLETE | navigatedPage=${resolvedPage}`
            + ` | currentPageBefore=${currentPage}`,
            getIdentity()
        );

        devLog("Recovery complete");

        scheduleOverlayHide();

    }, [
        applyRecoverySnapshot,
        currentPage,
        onNavigate,
        scheduleOverlayHide,
        getIdentity,
        destroySession,
        clearIdentity
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

        const reason = payload?.reason ?? payload?.message ?? "unknown";

        devLog(`Recovery failed: ${reason}`);

        // R6.17 — Client never decides room death. Only terminal server reasons
        // may wipe session / identity / navigate to Page1.
        if (!isTerminalRecoveryFailure(payload)) {

            scheduleOverlayHide();

            return;

        }

        destroySession();

        clearIdentity();

        resetToWelcomeRef.current?.("terminal_recovery_failure");

        scheduleOverlayHide();

    }, [
        destroySession,
        clearIdentity,
        scheduleOverlayHide,
        getIdentity
    ]);

    /**
     * R6.17 / R7.70C20 — Terminal wipe only. No RETURN LOBBY button.
     * Kept for API stability; overlays no longer expose this action.
     */
    const returnToLobby = useCallback(() => {

        clearIdentity();

        pendingGameplaySnapshotRef.current = null;

        recoveryInFlightRef.current = false;

        hideOverlay();

        onNavigate(APP_PAGES.WELCOME);

    }, [clearIdentity, hideOverlay, onNavigate]);

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

    // R12.2 — WebView wake-up: request recovery without waiting for disconnect.
    useEffect(() => {

        if (typeof document === "undefined" || typeof window === "undefined") {

            return undefined;

        }

        function onVisibilityRecovery(sourceEvent) {

            if (document.visibilityState === "hidden") {

                return;

            }

            if (!isGameplayPage(currentPage)) {

                return;

            }

            logTerminalNav({
                event: "visibility_recovery",
                currentPage,
                sessionGeneration: sessionGenerationRef.current
            });

            page6LifecycleDiag("VISIBILITY_RECOVERY", {
                sourceEvent,
                currentPage,
                visibilityState: document.visibilityState,
                socketConnected: socket.connected === true,
                sessionGeneration: sessionGenerationRef.current
            });

            devLog(`Wake-up recovery (${sourceEvent})`);

            requestSessionRecovery();

        }

        function onVisibilityChange() {

            onVisibilityRecovery("visibilitychange");

        }

        function onPageShow() {

            onVisibilityRecovery("pageshow");

        }

        document.addEventListener("visibilitychange", onVisibilityChange);

        window.addEventListener("pageshow", onPageShow);

        return () => {

            document.removeEventListener("visibilitychange", onVisibilityChange);

            window.removeEventListener("pageshow", onPageShow);

        };

    }, [currentPage, requestSessionRecovery]);

    // Hard cap: COMPLETE / RESTORING must never block input longer than 5s
    // even if the soft-hide timer was cancelled by an effect re-subscribe.
    useEffect(() => {

        if (
            status !== RECOVERY_UI_STATUS.COMPLETE
            && status !== RECOVERY_UI_STATUS.RESTORING
        ) {

            return;

        }

        const forceIdleTimer = setTimeout(() => {

            clearOverlayTimer();

            setStatus(RECOVERY_UI_STATUS.IDLE);

            devLog("Recovery overlay force-cleared after max visible time");

        }, OVERLAY_MAX_VISIBLE_MS);

        return () => {

            clearTimeout(forceIdleTimer);

        };

    }, [status, clearOverlayTimer]);

    // R17.8F — RECONNECTING must not block the lobby forever.
    // Clears overlay UI + stale inFlight only; never wipes identity/session.
    useEffect(() => {

        if (status !== RECOVERY_UI_STATUS.RECONNECTING) {

            return;

        }

        const reconnectingCapTimer = setTimeout(() => {

            recoveryInFlightRef.current = false;

            setStatus(RECOVERY_UI_STATUS.IDLE);

            recoveryTrace("reconnecting timeout cleared overlay", getIdentity());

            devLog("Reconnecting overlay cleared after max wait");

        }, RECONNECTING_MAX_MS);

        return () => {

            clearTimeout(reconnectingCapTimer);

        };

    }, [status, getIdentity]);

    // Clear soft-hide timer only on provider unmount (sessionGeneration remount
    // / leave GameFlow). Do NOT clear it in the socket-subscription effect —
    // that effect re-runs when onNavigate / session / handlers change after
    // restore and would cancel scheduleOverlayHide, leaving COMPLETE mounted.
    useEffect(() => () => {

        clearOverlayTimer();

    }, [clearOverlayTimer]);

    useEffect(() => {

        function onConnect() {

            const identity = getIdentity();

            const action = resolvePostReconnectAction({
                hadDisconnect: hadDisconnectRef.current,
                currentPage,
                identity
            });

            if (action === RECONNECT_CONNECT_ACTIONS.NOOP) {

                return;

            }

            recoveryTrace("reconnect", identity);

            devLog("Reconnect detected");

            if (shouldResetRecoveryInFlight(action)) {

                recoveryInFlightRef.current = false;

            }

            hadDisconnectRef.current = false;

            // R17.8F Case A — transport restored; no session claim to recover.
            if (action === RECONNECT_CONNECT_ACTIONS.CLEAR_TRANSPORT_ONLY) {

                setStatus(RECOVERY_UI_STATUS.IDLE);

                recoveryTrace("reconnect cleared without identity", identity);

                devLog("Reconnect cleared (no session identity)");

                return;

            }

            // R17.8F Case B / R6.17 — identity present: authoritative reclaim.
            // Local timers must never skip SESSION_RECOVERY_REQUEST.
            requestSessionRecovery();

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

        };

    }, [
        currentPage,
        requestSessionRecovery,
        handleGameplaySnapshot,
        handleRecoveryFailed,
        handleSetupRecoveryComplete,
        getIdentity
    ]);

    const value = useMemo(() => ({
        status,
        consumePendingGameplaySnapshot,
        returnToLobby,
        requestSessionRecovery
    }), [
        status,
        consumePendingGameplaySnapshot,
        returnToLobby,
        requestSessionRecovery
    ]);

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
