import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState
} from "react";

import {
    calculatePaymentGram,
    DEV_VERIFY_PLAYERS,
    PAYMENT_PAGE_LABELS,
    PAYMENT_STATUS,
    SMART_CONTRACT_STATUS,
    areAllPaymentsConfirmed,
    DEV_INITIAL_PAYMENT_STATUSES
} from "../utils/gameSession";

import { INCOMING_SOCKET_EVENTS } from "../socket/socketEvents";

import socket from "../socket/socket";

const DEV_BASE_STAKE = 10;

const PAGE_SETUP_START = 3;

const PAGE_PAYMENT_START = 6;

const PAGE_GAME_START = 7;

const INITIAL_SESSION = {
    roomId: null,
    players: [],
    connectedCount: 0,
    maxPlayers: 3,
    baseStake: 0,
    paymentGram: 0,
    currentPhase: null,
    phaseDuration: 0,
    phaseTimeRemaining: 0,
    smartContractStatus: null
};

// Only pre-game (lobby) phases live here now. Gameplay time is authoritative
// and rendered from GameClockContext (server GAME_CLOCK_UPDATE), never here.
// Setup Timer is owned solely by the server Setup Session (C5.6C).
const PHASE_TIMER_LABELS = {
    setup: "SETUP TIMER",
    payment: "PAYMENT TIMER"
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

    const paymentStageStartedRef = useRef(false);

    const preGameEndedRef = useRef(false);

    const expiredHandledRef = useRef(false);

    const destroySession = useCallback(() => {

        sessionStartedRef.current = false;

        paymentStageStartedRef.current = false;

        preGameEndedRef.current = false;

        expiredHandledRef.current = false;

        setSession(INITIAL_SESSION);

    }, []);

    // Prep page entry still seeds mock UX fields for unmigrated surfaces.
    // It must NOT start or own a Setup Timer — that lives on Setup Session.
    const startSetupSession = useCallback(() => {

        if (sessionStartedRef.current) {

            return;

        }

        sessionStartedRef.current = true;

        expiredHandledRef.current = false;

        setSession({
            roomId: "8F4K2S",
            players: DEV_VERIFY_PLAYERS,
            connectedCount: 3,
            maxPlayers: 3,
            baseStake: DEV_BASE_STAKE,
            paymentGram: calculatePaymentGram(DEV_BASE_STAKE),
            currentPhase: "setup",
            phaseDuration: 0,
            phaseTimeRemaining: 0,
            smartContractStatus: null
        });

    }, []);

    const initializePaymentStage = useCallback(() => {

        if (paymentStageStartedRef.current) {

            return;

        }

        paymentStageStartedRef.current = true;

        setSession((prev) => {

            if (!prev.currentPhase) {

                return prev;

            }

            return {
                ...prev,
                smartContractStatus: SMART_CONTRACT_STATUS.notIssued,
                players: prev.players.map((player, index) => ({
                    ...player,
                    paymentLabelTitle: PAYMENT_PAGE_LABELS[index],
                    paymentStatus: DEV_INITIAL_PAYMENT_STATUSES[index]
                }))
            };

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
                currentPhase: null,
                phaseTimeRemaining: 0
            };

        });

    }, []);

    useEffect(() => {

        if (currentPage === PAGE_SETUP_START) {

            startSetupSession();

        }

    }, [currentPage, startSetupSession]);

    useEffect(() => {

        if (currentPage === PAGE_PAYMENT_START) {

            initializePaymentStage();

        }

    }, [currentPage, initializePaymentStage]);

    useEffect(() => {

        if (currentPage === PAGE_GAME_START) {

            endPreGameSession();

        }

    }, [currentPage, endPreGameSession]);

    useEffect(() => {

        if (currentPage !== PAGE_PAYMENT_START) {

            return undefined;

        }

        const confirmTimerId = setTimeout(() => {

            setSession((prev) => {

                if (!prev.currentPhase) {

                    return prev;

                }

                const players = prev.players.map((player) => (
                    player.paymentStatus === PAYMENT_STATUS.waiting
                        ? {
                            ...player,
                            paymentStatus: PAYMENT_STATUS.confirmed
                        }
                        : player
                ));

                return { ...prev, players };

            });

        }, 8000);

        return () => clearTimeout(confirmTimerId);

    }, [currentPage]);

    // C5.6C — Navigate to Page1 only when the server expires Setup Session.
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

    const allPaymentsConfirmed =
        areAllPaymentsConfirmed(session.players);

    const value = {
        session,
        showInfoBar,
        currentPage,
        destroySession,
        phaseTimerLabel,
        formatPhaseTime,
        allPaymentsConfirmed
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
