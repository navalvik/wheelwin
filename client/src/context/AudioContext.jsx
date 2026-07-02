import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState
} from "react";

import { BUTTON_STATES, RESULT_OUTCOMES } from "../game/centralButton";

import { GAME_STATES } from "../game/GameState";

import { AdaptiveAudioEngine } from "../game/audio";

import { WINNER_EVENTS } from "../game/winner";

import { useRegisterEngineModule } from "./EngineBridgeContext";
import { useCentralButton } from "./CentralButtonContext";
import { useGameState } from "./GameStateContext";
import { usePhysics } from "./PhysicsContext";
import { useWinnerResolver } from "./WinnerResolverContext";

const AudioContext = createContext(null);

export function AudioProvider({ children }) {

    const { gameState } = useGameState();

    const { subscribeFrame, getFrame } = usePhysics();

    const { resultOutcome, subscribeToButtonEvents } = useCentralButton();

    const engineRef = useRef(null);

    const [status, setStatus] = useState({
        loaded: false,
        unlocked: false,
        musicPlaying: false,
        musicPaused: false,
        mechanicalPlaying: false,
        playbackRate: 1,
        volumes: {},
        loadedTracks: [],
        contextState: "uninitialized"
    });

    useEffect(() => {

        const engine = new AdaptiveAudioEngine();

        engineRef.current = engine;

        engine.load()
            .then((nextStatus) => {

                setStatus(nextStatus);

            })
            .catch((error) => {

                console.warn("[AudioEngine] Failed to load audio", error);

            });

        return () => {

            engine.dispose();

            engineRef.current = null;

        };

    }, []);

    useEffect(() => {

        const engine = engineRef.current;

        if (!engine) {

            return;

        }

        engine.handleGameState(gameState, { resultOutcome });

        setStatus(engine.getStatus());

    }, [gameState, resultOutcome]);

    useEffect(() => {

        const engine = engineRef.current;

        if (!engine) {

            return undefined;

        }

        let lastSpeed = -1;

        return subscribeFrame(() => {

            if (!engine.isUnlocked()) {

                return;

            }

            const speed = getFrame().wheelSpeed;

            if (Math.abs(speed - lastSpeed) < 0.25) {

                return;

            }

            lastSpeed = speed;

            engine.updateWheelSpeed(speed);

        });

    }, [subscribeFrame, getFrame]);

    useEffect(() => {

        const unsubscribe = subscribeToButtonEvents((event) => {

            const engine = engineRef.current;

            if (!engine) {

                return;

            }

            if (event.type === "press") {

                if (!engine.isUnlocked()) {

                    engine.unlock();

                }

                engine.playButtonPress();

            }

            if (event.type === "release") {

                if (!engine.isUnlocked()) {

                    engine.unlock();

                }

                engine.playButtonRelease();

            }

            setStatus(engine.getStatus());

        });

        return unsubscribe;

    }, [subscribeToButtonEvents]);

    const { subscribeToWinnerEvents } = useWinnerResolver();

    useEffect(() => {

        const unsubscribe = subscribeToWinnerEvents((event) => {

            const engine = engineRef.current;

            if (!engine) {

                return;

            }

            if (event.type === WINNER_EVENTS.LOSE) {

                engine.playLost();

            } else if (event.type === WINNER_EVENTS.WIN) {

                engine.playWin();

            }

            setStatus(engine.getStatus());

        });

        return unsubscribe;

    }, [subscribeToWinnerEvents]);

    useRegisterEngineModule("audio", () => ({

        onGameStart: () => {

            const engine = engineRef.current;

            if (!engine) {

                return;

            }

            engine.handleGameState(GAME_STATES.SPEED);

            setStatus(engine.getStatus());

        },

        onGameEnd: (payload) => {

            const engine = engineRef.current;

            if (!engine) {

                return;

            }

            const resultOutcome = payload?.outcome === RESULT_OUTCOMES.LOST
                ? RESULT_OUTCOMES.LOST
                : RESULT_OUTCOMES.WIN;

            engine.handleGameState(GAME_STATES.RESULT, { resultOutcome });

            setStatus(engine.getStatus());

        },

        restoreAudio: (snapshot) => {

            const engine = engineRef.current;

            if (!engine) {

                return;

            }

            engine.restoreSessionSnapshot(snapshot);

            setStatus(engine.getStatus());

        }

    }));

    const refreshStatus = useCallback(() => {

        if (engineRef.current) {

            setStatus(engineRef.current.getStatus());

        }

    }, []);

    const value = useMemo(() => ({
        status,
        refreshStatus,
        engine: engineRef.current
    }), [status, refreshStatus]);

    return (

        <AudioContext.Provider value={value}>

            {children}

        </AudioContext.Provider>

    );

}

export function useAudio() {

    const context = useContext(AudioContext);

    if (!context) {

        throw new Error(
            "useAudio must be used within AudioProvider"
        );

    }

    return context;

}
