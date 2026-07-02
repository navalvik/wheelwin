import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState
} from "react";

import { GAME_STATES } from "../game/GameState";
import { GameStateMachine } from "../game/GameStateMachine";

import { isServerAuthoritative } from "../game/gameAuthority";

import { DEV_MODE } from "../config/devMode";

import { useRegisterEngineModule } from "./EngineBridgeContext";

const GameStateContext = createContext(null);

export function GameStateProvider({ children }) {

    const machineRef = useRef(null);

    if (!machineRef.current) {

        machineRef.current = new GameStateMachine();

    }

    const [gameState, setGameState] = useState(machineRef.current.getState());

    useEffect(() => {

        const unsubscribe = machineRef.current.subscribe(setGameState);

        return unsubscribe;

    }, []);

    useEffect(() => {

        return () => {

            machineRef.current.reset();

        };

    }, []);

    useRegisterEngineModule("gameState", () => ({

        onGameState: (payload) => {

            const state = typeof payload === "string"
                ? payload
                : payload?.state;

            if (state) {

                machineRef.current.applyServerState(state);

                setGameState(machineRef.current.getState());

                if (DEV_MODE) {

                    console.debug("[GameStateSync] Client updated", {
                        state,
                        previousState: payload?.previousState ?? null
                    });

                }

            }

        },

        restoreGameState: (snapshot) => {

            if (!snapshot?.gameState) {

                return;

            }

            machineRef.current.applyServerState(snapshot.gameState);

            setGameState(machineRef.current.getState());

        }

    }));

    const advanceGameState = useCallback(() => {

        machineRef.current.advance();

    }, []);

    const pushFromReady = useCallback(() => {

        if (isServerAuthoritative()) {

            return false;

        }

        if (machineRef.current.getState() !== GAME_STATES.READY) {

            return false;

        }

        return machineRef.current.advance();

    }, []);

    useEffect(() => {

        if (!DEV_MODE) {

            return undefined;

        }

        function handleKeyDown(event) {

            if (isServerAuthoritative()) {

                return;

            }

            if (event.key !== "]" && event.key !== "ArrowRight") {

                return;

            }

            if (event.target instanceof HTMLInputElement
                || event.target instanceof HTMLTextAreaElement) {

                return;

            }

            event.preventDefault();

            machineRef.current.advance();

        }

        window.addEventListener("keydown", handleKeyDown);

        return () => window.removeEventListener("keydown", handleKeyDown);

    }, []);

    const canAdvance = machineRef.current.getNextState() !== null;

    const value = useMemo(() => ({
        gameState,
        canAdvance,
        advanceGameState,
        pushFromReady
    }), [gameState, canAdvance, advanceGameState, pushFromReady]);

    return (

        <GameStateContext.Provider value={value}>

            {children}

        </GameStateContext.Provider>

    );

}

export function useGameState() {

    const context = useContext(GameStateContext);

    if (!context) {

        throw new Error(
            "useGameState must be used within GameStateProvider"
        );

    }

    return context;

}
