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

    const timeoutHandledRef = useRef(false);

    const destroySession = useCallback(() => {

        sessionStartedRef.current = false;

        paymentStageStartedRef.current = false;

        preGameEndedRef.current = false;

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

    // Entering the payment page only prepares the pre-game payment UI. It must
    // NOT start any gameplay timer — the pre-game Setup Timer keeps running and
    // gameplay time comes exclusively from the authoritative server clock.
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

    // When gameplay begins the pre-game Setup Timer is no longer relevant. Clear
    // the phase so the lobby InfoBar stops on the game page and Page5 shows only
    // the authoritative GameClock.
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

    // InfoBar visibility is a layout concern tied to the game-flow pages, not to
    // whether the client owns a gameplay timer. It appears from the setup page
    // through the result page regardless of the authoritative gameplay clock.
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
            "useGameSession must be used within GameSessionProvider"
        );

    }

    return context;

}
