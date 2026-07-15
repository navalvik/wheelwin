import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState
} from "react";

import { calculatePaymentGram } from "../utils/gameSession";

import { INCOMING_SOCKET_EVENTS } from "../socket/socketEvents";

import socket from "../socket/socket";

const DEV_BASE_STAKE = 10;

const PAGE_SETUP_START = 3;

const PAGE_GAME_START = 7;

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

export function GameSessionProvider({ children, currentPage, onNavigate }) {

    const [session, setSession] = useState(INITIAL_SESSION);

    const sessionStartedRef = useRef(false);

    const preGameEndedRef = useRef(false);

    const expiredHandledRef = useRef(false);

    const destroySession = useCallback(() => {

        sessionStartedRef.current = false;

        preGameEndedRef.current = false;

        expiredHandledRef.current = false;

        setSession(INITIAL_SESSION);

    }, []);

    // Seeds unmigrated finance fields for Page3. Does not own setup timer,
    // players, room metadata, or payment state (AuthoritativeSession).
    const startSetupSession = useCallback(() => {

        if (sessionStartedRef.current) {

            return;

        }

        sessionStartedRef.current = true;

        expiredHandledRef.current = false;

        setSession({
            maxPlayers: 3,
            baseStake: DEV_BASE_STAKE,
            paymentGram: calculatePaymentGram(DEV_BASE_STAKE),
            currentPhase: "setup"
        });

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

            if (currentPage < PAGE_SETUP_START || currentPage >= PAGE_GAME_START) {

                return;

            }

            expiredHandledRef.current = true;

            destroySession();

            onNavigate(1);

        }

        socket.on(
            INCOMING_SOCKET_EVENTS.SETUP_SESSION_EXPIRED,
            handleSetupExpired
        );

        return () => {

            socket.off(
                INCOMING_SOCKET_EVENTS.SETUP_SESSION_EXPIRED,
                handleSetupExpired
            );

        };

    }, [currentPage, destroySession, onNavigate]);

    const showInfoBar = currentPage >= PAGE_SETUP_START;

    const phaseTimerLabel =
        PHASE_TIMER_LABELS[session.currentPhase] || "TIMER";

    const value = {
        session,
        showInfoBar,
        currentPage,
        destroySession,
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
