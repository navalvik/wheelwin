import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState
} from "react";

import {
    BUTTON_STATES,
    CentralButtonEngine,
    RESULT_OUTCOMES
} from "../game/centralButton";

import socket from "../socket/socket";

import { useRegisterEngineModule } from "./EngineBridgeContext";
import { useGameState } from "./GameStateContext";
import { usePhysics } from "./PhysicsContext";
import { usePlayerIdentity } from "./PlayerIdentityContext";

const CentralButtonContext = createContext(null);

export function CentralButtonProvider({ children, onReadyComplete }) {

    const { gameState } = useGameState();

    const { handleButtonEvent } = usePhysics();

    const { playerId: localPlayerId } = usePlayerIdentity();

    const localPlayerIdRef = useRef(localPlayerId);

    localPlayerIdRef.current = localPlayerId;

    const engineRef = useRef(null);

    if (!engineRef.current) {

        engineRef.current = new CentralButtonEngine();

    }

    const [snapshot, setSnapshot] = useState(
        engineRef.current.getSnapshot()
    );

    const [resultOutcome, setResultOutcomeState] = useState(
        RESULT_OUTCOMES.WIN
    );

    const buttonEventListenersRef = useRef(new Set());

    useEffect(() => {

        const unsubscribe = engineRef.current.subscribe(setSnapshot);

        return unsubscribe;

    }, []);

    useEffect(() => {

        engineRef.current.syncWithGameState(gameState, resultOutcome);

    }, [gameState, resultOutcome]);

    useEffect(() => {

        const updateTransmitAlways = () => {

            engineRef.current.setTransmitAlways(socket.connected);

        };

        updateTransmitAlways();

        socket.on("connect", updateTransmitAlways);

        socket.on("disconnect", updateTransmitAlways);

        return () => {

            socket.off("connect", updateTransmitAlways);

            socket.off("disconnect", updateTransmitAlways);

        };

    }, []);

    useEffect(() => {

        const unsubscribe = engineRef.current.onEvent((event) => {

            handleButtonEvent(event);

            buttonEventListenersRef.current.forEach((listener) => {

                listener(event);

            });

            if (event.type === "release"
                && event.buttonState === BUTTON_STATES.PUSH) {

                onReadyComplete?.();

            }

        });

        return unsubscribe;

    }, [handleButtonEvent, onReadyComplete]);

    useEffect(() => {

        return () => {

            engineRef.current.reset();

        };

    }, []);

    useRegisterEngineModule("button", () => ({

        restoreButton: (snapshot) => {

            engineRef.current.restoreSessionSnapshot(snapshot);

            setSnapshot(engineRef.current.getSnapshot());

            if (snapshot.resultOutcome) {

                setResultOutcome(snapshot.resultOutcome);

            }

        },

        applyAuthoritativeInput: (payload) => {

            const payloadPlayerId = payload?.playerId;

            const currentLocalId = localPlayerIdRef.current;

            if (currentLocalId != null
                && payloadPlayerId != null
                && String(payloadPlayerId) !== String(currentLocalId)) {

                return;

            }

            engineRef.current.applyAuthoritativeInput(payload);

            setSnapshot(engineRef.current.getSnapshot());

        }

    }));

    const press = useCallback(() => {

        engineRef.current.press();

    }, []);

    const release = useCallback(() => {

        engineRef.current.release();

    }, []);

    const setResultOutcome = useCallback((outcome) => {

        setResultOutcomeState(outcome);

        engineRef.current.setResultOutcome(outcome);

    }, []);

    const setDebugResultOutcome = useCallback((outcome) => {

        setResultOutcome(outcome);

    }, [setResultOutcome]);

    const subscribeToButtonEvents = useCallback((listener) => {

        buttonEventListenersRef.current.add(listener);

        return () => {

            buttonEventListenersRef.current.delete(listener);

        };

    }, []);

    const value = useMemo(() => ({
        snapshot,
        press,
        release,
        setResultOutcome,
        setDebugResultOutcome,
        resultOutcome,
        subscribeToButtonEvents
    }), [
        snapshot,
        press,
        release,
        setResultOutcome,
        setDebugResultOutcome,
        resultOutcome,
        subscribeToButtonEvents
    ]);

    return (

        <CentralButtonContext.Provider value={value}>

            {children}

        </CentralButtonContext.Provider>

    );

}

export function useCentralButton() {

    const context = useContext(CentralButtonContext);

    if (!context) {

        throw new Error(
            "useCentralButton must be used within CentralButtonProvider"
        );

    }

    return context;

}
