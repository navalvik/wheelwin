import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState
} from "react";

import { calculatePaymentGram } from "../utils/playerProfileRules";

import { APP_PAGES } from "../game/sessionRecovery/recoveryFlow";

import { shouldNavigateOnSetupSessionExpiry } from "../game/session/setupSessionExpiry";

import { shouldNavigateOnGameplayRoomClosed } from "../game/session/gameplayTerminal";

import { INCOMING_SOCKET_EVENTS } from "../socket/socketEvents";

import socket from "../socket/socket";

const PAGE_SETUP_START = APP_PAGES.PLAYER_SETUP;

const PAGE_GAME_START = APP_PAGES.GAMEPLAY;

const INITIAL_SESSION = {
    maxPlayers: 3,
    baseStake: 0,
    paymentGram: 0,
    currentPhase: null
};

// Pre-game shell only. AuthoritativeSession owns room, players, payment, setup
// timer. GameClockContext owns gameplay time.
const PHASE_TIMER_LABELS = {
    setup: "SETUP TIMER"
};

export function formatPhaseTime(totalSeconds) {

    const minutes = Math.floor(totalSeconds / 60);

    const seconds = totalSeconds % 60;

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

}

export const GameSessionContext = createContext(null);

export function GameSessionProvider({
    children,
    currentPage,
    onNavigate,
    resetToWelcome = null
}) {

    const [session, setSession] = useState(INITIAL_SESSION);

    const sessionStartedRef = useRef(false);

    const preGameEndedRef = useRef(false);

    const expiredHandledRef = useRef(false);

    const currentPageRef = useRef(currentPage);

    const onNavigateRef = useRef(onNavigate);

    const resetToWelcomeRef = useRef(resetToWelcome);

    currentPageRef.current = currentPage;

    onNavigateRef.current = onNavigate;

    resetToWelcomeRef.current = resetToWelcome;

    const destroySession = useCallback(() => {

        sessionStartedRef.current = false;

        preGameEndedRef.current = false;

        expiredHandledRef.current = false;

        setSession(INITIAL_SESSION);

    }, []);

    // Seeds the prep-phase shell for InfoBar. Finance (baseStake / paymentGram)
    // is written by Page2 via setFinance — never hardcoded here.
    const startSetupSession = useCallback(() => {

        if (sessionStartedRef.current) {

            return;

        }

        sessionStartedRef.current = true;

        expiredHandledRef.current = false;

        setSession((prev) => ({
            ...prev,
            maxPlayers: prev.maxPlayers || 3,
            currentPhase: "setup"
        }));

    }, []);

    const setFinance = useCallback(({ baseStake, paymentGram }) => {

        const stake = Number(baseStake);

        setSession((prev) => ({
            ...prev,
            baseStake: stake,
            paymentGram: paymentGram ?? calculatePaymentGram(stake)
        }));

    }, []);

    const endPreGameSession = useCallback(() => {

        if (preGameEndedRef.current) {

            return;

        }

        preGameEndedRef.current = true;

        setSession((prev) => {

            if (!prev.currentPhase) {

                return prev;

            }

            return {
                ...prev,
                currentPhase: null
            };

        });

    }, []);

    useEffect(() => {

        if (currentPage === PAGE_SETUP_START) {

            startSetupSession();

        }

    }, [currentPage, startSetupSession]);

    useEffect(() => {

        if (currentPage === PAGE_GAME_START) {

            endPreGameSession();

        }

    }, [currentPage, endPreGameSession]);

    useEffect(() => {

        function handleSetupExpired() {

            if (expiredHandledRef.current) {

                return;

            }

            if (!shouldNavigateOnSetupSessionExpiry(currentPageRef.current)) {

                return;

            }

            expiredHandledRef.current = true;

            destroySession();

            // destroySession clears expiredHandledRef — re-arm so duplicate
            // SETUP_SESSION_EXPIRED / roomClosed cannot double-navigate.
            expiredHandledRef.current = true;

            onNavigateRef.current(APP_PAGES.WELCOME);

        }

        function handleRoomClosed() {

            if (shouldNavigateOnGameplayRoomClosed(
                currentPageRef.current,
                preGameEndedRef.current
            )) {

                resetToWelcomeRef.current?.("roomClosed");

                return;

            }

            handleSetupExpired();

        }

        function handlePaymentSessionFailed() {

            handleSetupExpired();

        }

        socket.on(
            INCOMING_SOCKET_EVENTS.SETUP_SESSION_EXPIRED,
            handleSetupExpired
        );

        socket.on("roomClosed", handleRoomClosed);

        socket.on(
            INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_FAILED,
            handlePaymentSessionFailed
        );

        return () => {

            socket.off(
                INCOMING_SOCKET_EVENTS.SETUP_SESSION_EXPIRED,
                handleSetupExpired
            );

            socket.off("roomClosed", handleRoomClosed);

            socket.off(
                INCOMING_SOCKET_EVENTS.PAYMENT_SESSION_FAILED,
                handlePaymentSessionFailed
            );

        };

    }, [destroySession]);

    const showInfoBar = currentPage >= PAGE_SETUP_START;

    const phaseTimerLabel =
        PHASE_TIMER_LABELS[session.currentPhase] || "TIMER";

    const value = {
        session,
        showInfoBar,
        currentPage,
        destroySession,
        setFinance,
        phaseTimerLabel,
        formatPhaseTime
    };

    return (

        <GameSessionContext.Provider value={value}>

            {children}

        </GameSessionContext.Provider>

    );

}

export function useGameSession() {

    const context = useContext(GameSessionContext);

    if (!context) {

        throw new Error(
            "useGameSession must be used within a GameSessionProvider"
        );

    }

    return context;

}
