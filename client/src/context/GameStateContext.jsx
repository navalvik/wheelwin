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

    const serverStateRef = useRef({
        gameId: null,
        phaseRank: null,
        serverTimestamp: null
    });

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

        onGameStart: (payload) => {

            if (payload?.gameId) {

                serverStateRef.current = {
                    gameId: payload.gameId,
                    phaseRank: null,
                    serverTimestamp: null
                };

            }

        },

        onGameState: (payload) => {

            const state = typeof payload === "string"
                ? payload
                : payload?.state;

            if (state) {

                const phaseOrder = [
                    GAME_STATES.READY,
                    GAME_STATES.SELF_TEST,
                    GAME_STATES.SPEED,
                    GAME_STATES.BRAKE,
                    GAME_STATES.RESULT
                ];

                const incomingRank = phaseOrder.indexOf(state);

                const tracked = serverStateRef.current;

                const incomingTimestamp = Number(
                    payload?.serverTimestamp ?? payload?.timestamp
                );

                if (payload?.gameId && tracked.gameId
                    && payload.gameId !== tracked.gameId) {

                    return;

                }

                if (incomingRank >= 0 && tracked.phaseRank !== null
                    && incomingRank < tracked.phaseRank) {

                    return;

                }

                if (Number.isFinite(incomingTimestamp)
                    && Number.isFinite(tracked.serverTimestamp)
                    && incomingTimestamp < tracked.serverTimestamp) {

                    return;

                }

                serverStateRef.current = {
                    gameId: payload?.gameId ?? tracked.gameId,
                    phaseRank: incomingRank >= 0
                        ? Math.max(tracked.phaseRank ?? -1, incomingRank)
                        : tracked.phaseRank,
                    serverTimestamp: Number.isFinite(incomingTimestamp)
                        ? incomingTimestamp
                        : tracked.serverTimestamp
                };

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

            const phaseOrder = [
                GAME_STATES.READY,
                GAME_STATES.SELF_TEST,
                GAME_STATES.SPEED,
                GAME_STATES.BRAKE,
                GAME_STATES.RESULT
            ];

            serverStateRef.current = {
                gameId: snapshot.gameId ?? null,
                phaseRank: phaseOrder.indexOf(snapshot.gameState),
                serverTimestamp: Number.isFinite(snapshot.timestamp)
                    ? snapshot.timestamp
                    : null
            };

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
