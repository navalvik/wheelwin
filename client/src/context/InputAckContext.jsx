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

import { GAME_STATES } from "../game/GameState";

import { useGameState } from "./GameStateContext";
import { useRegisterEngineModule } from "./EngineBridgeContext";

const InputAckContext = createContext(null);

// Input acknowledgements are only meaningful while gameplay input is live.
// Once the authoritative GameState reaches a terminal presentation state the
// last acknowledgement is no longer relevant and must disappear.
const TERMINAL_PRESENTATION_STATES = new Set([
    GAME_STATES.BRAKE,
    GAME_STATES.RESULT
]);

export function InputAckProvider({ children }) {

    const [lastAck, setLastAck] = useState(null);

    const { gameState } = useGameState();

    const acknowledgementClearedRef = useRef(false);

    useRegisterEngineModule("inputAck", () => ({

        onInputAccepted: (payload) => {

            setLastAck({
                status: "accepted",
                label: "Input Accepted",
                ...payload
            });

            if (DEV_MODE) {

                console.debug("[InputSync] Input Accepted", payload);

            }

        },

        onInputRejected: (payload) => {

            setLastAck({
                status: "rejected",
                label: "Input Rejected",
                ...payload
            });

            if (DEV_MODE) {

                console.debug("[InputSync] Input Rejected", payload);

            }

        }

    }));

    const clearAcknowledgement = useCallback(() => {

        if (acknowledgementClearedRef.current) {

            return;

        }

        acknowledgementClearedRef.current = true;

        setLastAck(null);

    }, []);

    // React only to authoritative GameState: when gameplay reaches a terminal
    // presentation state, drop the stale acknowledgement. No timers, no delays,
    // no prediction — the cleanup follows the server's state directly. The guard
    // resets on non-terminal states so a subsequent game clears again cleanly.
    useEffect(() => {

        if (!TERMINAL_PRESENTATION_STATES.has(gameState)) {

            acknowledgementClearedRef.current = false;

            return;

        }

        clearAcknowledgement();

    }, [gameState, clearAcknowledgement]);

    const value = useMemo(() => ({
        lastAck
    }), [lastAck]);

    return (

        <InputAckContext.Provider value={value}>

            {children}

        </InputAckContext.Provider>

    );

}

export function useInputAck() {

    const context = useContext(InputAckContext);

    if (!context) {

        throw new Error(
            "useInputAck must be used within InputAckProvider"
        );

    }

    return context;

}
