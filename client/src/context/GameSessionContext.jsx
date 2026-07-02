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

const SETUP_PHASE_DURATION = 10 * 60;

const GAME_PHASE_DURATION = 4 * 60 + 59;

const DEV_BASE_STAKE = 10;

const PAGE_SETUP_START = 3;

const PAGE_PAYMENT_START = 6;

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

const PHASE_TIMER_LABELS = {
    setup: "SETUP TIMER",
    payment: "PAYMENT TIMER",
    game: "GAME TIMER",
    result: "RESULT TIMER"
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

    const gamePhaseStartedRef = useRef(false);

    const timeoutHandledRef = useRef(false);

    const destroySession = useCallback(() => {

        sessionStartedRef.current = false;

        gamePhaseStartedRef.current = false;

        timeoutHandledRef.current = false;

        setSession(INITIAL_SESSION);

    }, []);

    const startSetupSession = useCallback(() => {

        if (sessionStartedRef.current) {

            return;

        }

        sessionStartedRef.current = true;

        timeoutHandledRef.current = false;

        setSession({
            roomId: "8F4K2S",
            players: DEV_VERIFY_PLAYERS,
            connectedCount: 3,
            maxPlayers: 3,
            baseStake: DEV_BASE_STAKE,
            paymentGram: calculatePaymentGram(DEV_BASE_STAKE),
            currentPhase: "setup",
            phaseDuration: SETUP_PHASE_DURATION,
            phaseTimeRemaining: SETUP_PHASE_DURATION,
            smartContractStatus: null
        });

    }, []);

    const startGamePhase = useCallback(() => {

        if (gamePhaseStartedRef.current) {

            return;

        }

        gamePhaseStartedRef.current = true;

        setSession((prev) => {

            if (!prev.currentPhase) {

                return prev;

            }

            return {
                ...prev,
                currentPhase: "game",
                phaseDuration: GAME_PHASE_DURATION,
                phaseTimeRemaining: GAME_PHASE_DURATION,
                smartContractStatus: SMART_CONTRACT_STATUS.notIssued,
                players: prev.players.map((player, index) => ({
                    ...player,
                    paymentLabelTitle: PAYMENT_PAGE_LABELS[index],
                    paymentStatus: DEV_INITIAL_PAYMENT_STATUSES[index]
                }))
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

            startGamePhase();

        }

    }, [currentPage, startGamePhase]);

    useEffect(() => {

        if (currentPage !== PAGE_PAYMENT_START) {

            return undefined;

        }

        const confirmTimerId = setTimeout(() => {

            setSession((prev) => {

                if (prev.currentPhase !== "game") {

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

    useEffect(() => {

        if (!session.currentPhase || session.phaseTimeRemaining <= 0) {

            return undefined;

        }

        const timerId = setInterval(() => {

            setSession((prev) => {

                if (!prev.currentPhase || prev.phaseTimeRemaining <= 0) {

                    return prev;

                }

                return {
                    ...prev,
                    phaseTimeRemaining: prev.phaseTimeRemaining - 1
                };

            });

        }, 1000);

        return () => clearInterval(timerId);

    }, [session.currentPhase]);

    useEffect(() => {

        if (
            !session.currentPhase
            || session.phaseTimeRemaining > 0
            || timeoutHandledRef.current
        ) {

            return;

        }

        timeoutHandledRef.current = true;

        destroySession();

        onNavigate(1);

    }, [
        session.currentPhase,
        session.phaseTimeRemaining,
        destroySession,
        onNavigate
    ]);

    const showInfoBar = session.currentPhase !== null;

    const phaseTimerLabel =
        PHASE_TIMER_LABELS[session.currentPhase] || "TIMER";

    const allPaymentsConfirmed =
        areAllPaymentsConfirmed(session.players);

    const value = {
        session,
        showInfoBar,
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
            "useGameSession must be used within GameSessionProvider"
        );

    }

    return context;

}
