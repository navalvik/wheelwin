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
    resolveGameplayRecoveryPage,
    shouldPreservePage6OnRecoveryFailure,
    resolveRoomRecoveryPage,
    shouldAcceptRoomRecoverySync,
    buildRoomRecoveryIdentityUpdate
} from "../game/sessionRecovery/recoveryFlow";

import {
    RECONNECT_CONNECT_ACTIONS,
    RECONNECTING_MAX_MS,
    resolvePostReconnectAction,
    applyRecoveryRequestPresentation,
    shouldResetRecoveryInFlight
} from "../game/sessionRecovery/recoveryReconnectPolicy";

import { normalizeSessionSnapshot } from "../game/sessionRecovery/sessionSnapshotUtils";

import { page6LifecycleDiag } from "../game/result/page6LifecycleDiag";

import { webPage6Diag } from "../game/result/webPage6StateDiag";

import { logTerminalNav } from "../game/session/gameplayTerminal";

import { RECOVERY_SOCKET_EVENTS } from "../game/sessionRecovery/sessionRecoveryEvents";

import { subscribeRecoveryWakeEvents } from "../game/sessionRecovery/recoveryWakeEvents";

import {
    INCOMING_SOCKET_EVENTS,
    SOCKET_MESSAGE_CHANNEL
} from "../socket/socketEvents";

import socket from "../socket/socket";

import { useGameResultRecovery } from "./GameResultContext";
import { useGameClock } from "./GameClockContext";
import { shouldRequestStaleGameplayPhaseRecovery, STALE_GAMEPLAY_PHASE_GRACE_MS } from "../game/sessionRecovery/staleGameplayPhasePolicy";

import { useGameSession } from "./GameSessionContext";

import {
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

    const { clock } = useGameClock();

    const { destroySession } = useGameSession();

    const { getIdentity, clearIdentity, setIdentity } = usePlayerIdentity();

    const [status, setStatus] = useState(RECOVERY_UI_STATUS.IDLE);

    const pendingGameplaySnapshotRef = useRef(null);

    const stalePhaseRecoveryKeysRef = useRef(new Set());

    const recoveryInFlightRef = useRef(false);

    const hadDisconnectRef = useRef(false);

    const recoveryOverlayRef = useRef(false);

    const recoveryRequestTimerRef = useRef(null);

    // Timer ids live in refs so hide scheduling survives socket-effect
    // re-subscriptions (unstable onNavigate / session updates after restore).
    const hideOverlayTimerRef = useRef(null);

    const resetToWelcomeRef = useRef(resetToWelcome);

    const sessionGenerationRef = useRef(sessionGeneration);

    useEffect(() => {
        resetToWelcomeRef.current = resetToWelcome;
        sessionGenerationRef.current = sessionGeneration;
    }, [resetToWelcome, sessionGeneration]);

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
    const requestSessionRecovery = useCallback(({ showOverlay = null } = {}) => {

        const identity = getIdentity();

        if (recoveryInFlightRef.current) {

            return;

        }

        clearOverlayTimer();
        recoveryInFlightRef.current = true;

        recoveryOverlayRef.current = applyRecoveryRequestPresentation({
            showOverlay,
            socketConnected: socket.connected === true,
            hadDisconnect: hadDisconnectRef.current,
            reconnectingStatus: RECOVERY_UI_STATUS.RECONNECTING,
            setStatus
        });

        if (recoveryRequestTimerRef.current) clearTimeout(recoveryRequestTimerRef.current);
        recoveryRequestTimerRef.current = setTimeout(() => {
            recoveryRequestTimerRef.current = null;
            recoveryInFlightRef.current = false;
            recoveryOverlayRef.current = false;
            clearOverlayTimer();
            setStatus(RECOVERY_UI_STATUS.FAILED);
            scheduleOverlayHide();
        }, RECONNECTING_MAX_MS);

        devLog("Recovery requested");

        socket.emit(SOCKET_MESSAGE_CHANNEL, {
            type: RECOVERY_SOCKET_EVENTS.SESSION_RECOVERY_REQUEST,
            payload: {
                timestamp: Date.now(),
                ...(hasGameplayIdentity(identity) ? {
                    playerId: identity.playerId,
                    roomId: identity.roomId,
                    recoveryCredential: identity.recoveryCredential ?? null
                } : {})
            }
        });

        recoveryTrace("SESSION_RECOVERY_REQUEST sent", {
            roomId: identity.roomId,
            playerId: identity.playerId
        });

    }, [clearOverlayTimer, getIdentity, scheduleOverlayHide]);

    const handleSetupRecoveryComplete = useCallback(() => {

        if (!recoveryInFlightRef.current) {

            return;

        }

        recoveryInFlightRef.current = false;

        if (recoveryRequestTimerRef.current) {
            clearTimeout(recoveryRequestTimerRef.current);
            recoveryRequestTimerRef.current = null;
        }

        const showOverlay = recoveryOverlayRef.current;
        recoveryOverlayRef.current = false;

        setStatus(showOverlay ? RECOVERY_UI_STATUS.COMPLETE : RECOVERY_UI_STATUS.IDLE);

        recoveryTrace("overlay COMPLETE", getIdentity());

        devLog("Setup session restored; awaiting authoritative room stage");

        if (showOverlay) scheduleOverlayHide();

    }, [scheduleOverlayHide, getIdentity]);

    const handleRoomRecoverySync = useCallback((payload) => {

        const previousIdentity = getIdentity();
        if (!shouldAcceptRoomRecoverySync({
            payload,
            identity: previousIdentity,
            currentPage,
            recoveryInFlight: recoveryInFlightRef.current
        })) return;

        recoveryInFlightRef.current = false;
        if (recoveryRequestTimerRef.current) {
            clearTimeout(recoveryRequestTimerRef.current);
            recoveryRequestTimerRef.current = null;
        }
        const showOverlay = recoveryOverlayRef.current;
        recoveryOverlayRef.current = false;

        setIdentity(buildRoomRecoveryIdentityUpdate(payload, previousIdentity));

        const targetPage = resolveRoomRecoveryPage(payload.stage);
        if (targetPage && targetPage !== currentPage) onNavigate(targetPage);

        // GAMEPLAY and RESULT continue through OPEN_PAGE5 and the authoritative
        // SESSION_SNAPSHOT. Stage metadata never navigates those pages.
        setStatus(showOverlay ? RECOVERY_UI_STATUS.COMPLETE : RECOVERY_UI_STATUS.IDLE);
        if (showOverlay) scheduleOverlayHide();

    }, [currentPage, getIdentity, onNavigate, scheduleOverlayHide, setIdentity]);

    const handleGameplaySnapshot = useCallback((payload) => {

        recoveryInFlightRef.current = false;

        if (recoveryRequestTimerRef.current) {
            clearTimeout(recoveryRequestTimerRef.current);
            recoveryRequestTimerRef.current = null;
        }

        const showOverlay = recoveryOverlayRef.current;
        recoveryOverlayRef.current = false;
        setStatus(showOverlay ? RECOVERY_UI_STATUS.RESTORING : RECOVERY_UI_STATUS.IDLE);

        devLog("Snapshot received");

        // R12.5C — route from normalized snapshot so openPage6 /
        // resultSessionExpiresAt are never dropped before the decision.
        const snapshot = normalizeSessionSnapshot(payload);

        const identity = getIdentity();
        if ((snapshot.roomId && snapshot.roomId !== identity.roomId)
            || (snapshot.playerId && snapshot.playerId !== identity.playerId)
            || (snapshot.gameId && identity.gameId && snapshot.gameId !== identity.gameId)) {
            recoveryOverlayRef.current = false;
            setStatus(RECOVERY_UI_STATUS.IDLE);
            return;
        }

        const targetPage = resolveGameplayRecoveryPage(snapshot);

        if (snapshot.gameId) setIdentity({ gameId: snapshot.gameId });

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

            if (currentPage === APP_PAGES.RESULT) {
                setStatus(RECOVERY_UI_STATUS.IDLE);
                return;
            }

            setStatus(showOverlay ? RECOVERY_UI_STATUS.FAILED : RECOVERY_UI_STATUS.IDLE);

            recoveryTrace("overlay FAILED", getIdentity());

            if (showOverlay) scheduleOverlayHide();

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

        if (showOverlay) {
            setStatus(RECOVERY_UI_STATUS.COMPLETE);
        }

        recoveryTrace(
            `overlay COMPLETE | navigatedPage=${resolvedPage}`
            + ` | currentPageBefore=${currentPage}`,
            getIdentity()
        );

        devLog("Recovery complete");

        if (showOverlay) scheduleOverlayHide();

    }, [
        applyRecoverySnapshot,
        currentPage,
        onNavigate,
        scheduleOverlayHide,
        getIdentity,
        setIdentity,
    ]);

    const handleRecoveryFailed = useCallback((payload) => {

        recoveryInFlightRef.current = false;

        if (recoveryRequestTimerRef.current) {
            clearTimeout(recoveryRequestTimerRef.current);
            recoveryRequestTimerRef.current = null;
        }

        recoveryOverlayRef.current = false;
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

        if (shouldPreservePage6OnRecoveryFailure(currentPage)) {
            recoveryTrace(`terminal recovery failure shown while preserving Page6 (${reason})`, getIdentity());
            scheduleOverlayHide();
            return;
        }

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
        currentPage,
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

        if (currentPage !== APP_PAGES.WELCOME) {

            return;

        }

        function tryBootRecovery() {

            if (!socket.connected || recoveryInFlightRef.current) {

                return;

            }

            requestSessionRecovery({ showOverlay: false });

        }

        if (socket.connected) {

            tryBootRecovery();

        }

        socket.on("connect", tryBootRecovery);

        return () => {

            socket.off("connect", tryBootRecovery);

        };

    }, [currentPage, getIdentity, requestSessionRecovery]);

    // A connected WebView may miss a phase transition without disconnecting.
    // Once a server-provided phase deadline is already stale, ask for ONE
    // authoritative snapshot. Never locally advance phases or animate physics.
    useEffect(() => {

        if (currentPage !== APP_PAGES.GAMEPLAY || !Number.isFinite(clock.endsAt)) {

            return undefined;

        }

        const identity = getIdentity();

        const phaseKey = [
            identity.gameId ?? "",
            clock.gameId ?? "",
            clock.phase ?? "",
            clock.endsAt
        ].join(":");

        if (stalePhaseRecoveryKeysRef.current.has(phaseKey)) {

            return undefined;

        }

        const remainingMs = Math.max(
            0,
            clock.endsAt + STALE_GAMEPLAY_PHASE_GRACE_MS - Date.now()
        );

        const timer = setTimeout(() => {

            if (!shouldRequestStaleGameplayPhaseRecovery({
                currentPage,
                gameplayPage: APP_PAGES.GAMEPLAY,
                phase: clock.phase,
                gameId: identity.gameId,
                clockGameId: clock.gameId,
                endsAt: clock.endsAt,
                now: Date.now(),
                connected: socket.connected,
                recoveryInFlight: recoveryInFlightRef.current
            })) {

                return;

            }

            if (typeof document !== "undefined"
                && document.visibilityState === "hidden") {

                return;

            }

            stalePhaseRecoveryKeysRef.current.add(phaseKey);

            recoveryTrace("stale gameplay phase: requesting authoritative snapshot", identity);

            requestSessionRecovery({ showOverlay: false });

        }, remainingMs);

        return () => clearTimeout(timer);

    }, [
        currentPage,
        clock.phase,
        clock.gameId,
        clock.endsAt,
        getIdentity,
        requestSessionRecovery
    ]);

    // R12.2 — Browser/WebView wake-up: request recovery without waiting for disconnect.
    useEffect(() => {

        if (typeof document === "undefined" || typeof window === "undefined") {

            return undefined;

        }

        return subscribeRecoveryWakeEvents({
            documentTarget: document,
            windowTarget: window,
            isEligible: () => isSetupRecoveryPage(currentPage)
                || isGameplayPage(currentPage),
            onWake: (sourceEvent) => {
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
        });

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

        if (recoveryRequestTimerRef.current) clearTimeout(recoveryRequestTimerRef.current);

    }, [clearOverlayTimer]);

    useEffect(() => {

        function onConnect() {

            const identity = getIdentity();

            if (currentPage === APP_PAGES.NO_FRIENDS_QUEUE
                && hadDisconnectRef.current) {
                recoveryInFlightRef.current = false;
                requestSessionRecovery({ showOverlay: true });
                hadDisconnectRef.current = false;
                return;
            }

            const action = resolvePostReconnectAction({
                hadDisconnect: hadDisconnectRef.current,
                currentPage,
                identity
            });

            if (action === RECONNECT_CONNECT_ACTIONS.NOOP) {

                return;

            }

            const hadDisconnect = hadDisconnectRef.current;

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
            requestSessionRecovery({ showOverlay: hadDisconnect });

        }

        function onDisconnect() {

            if (!isSetupRecoveryPage(currentPage)
                && !isGameplayPage(currentPage)
                && currentPage !== APP_PAGES.NO_FRIENDS_QUEUE) {

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

                if (
                    isGameplayPage(currentPage)
                    || isSetupRecoveryPage(currentPage)
                    || pendingGameplaySnapshotRef.current !== null
                    || (
                        currentPage === APP_PAGES.WELCOME
                        && recoveryInFlightRef.current
                    )
                ) {

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

            if (
                isSetupRecoveryPage(currentPage)
                || (
                    currentPage === APP_PAGES.WELCOME
                    && recoveryInFlightRef.current
                )
            ) {

                handleSetupRecoveryComplete();

            }

        }

        socket.on("connect", onConnect);

        socket.on("disconnect", onDisconnect);

        socket.on(SOCKET_MESSAGE_CHANNEL, onGameMessage);

        socket.on(INCOMING_SOCKET_EVENTS.SETUP_SESSION_SYNC, onSetupSessionSync);
        socket.on(INCOMING_SOCKET_EVENTS.ROOM_RECOVERY_SYNC, handleRoomRecoverySync);

        return () => {

            socket.off("connect", onConnect);

            socket.off("disconnect", onDisconnect);

            socket.off(SOCKET_MESSAGE_CHANNEL, onGameMessage);

            socket.off(
                INCOMING_SOCKET_EVENTS.SETUP_SESSION_SYNC,
                onSetupSessionSync
            );
            socket.off(
                INCOMING_SOCKET_EVENTS.ROOM_RECOVERY_SYNC,
                handleRoomRecoverySync
            );

        };

    }, [
        currentPage,
        requestSessionRecovery,
        handleGameplaySnapshot,
        handleRecoveryFailed,
        handleSetupRecoveryComplete,
        handleRoomRecoverySync,
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
