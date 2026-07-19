import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useSyncExternalStore
} from "react";

import { PhysicsEngine } from "../game/physics/PhysicsEngine";

import { createPhysicsFrameStore } from "../game/physics/physicsFrameStore";

import { isServerAuthoritative } from "../game/gameAuthority";

import { DEV_MODE } from "../config/devMode";

import { useRegisterEngineModule } from "./EngineBridgeContext";
import { useGameState } from "./GameStateContext";

const PhysicsContext = createContext(null);

export function PhysicsProvider({ children }) {

    const { gameState } = useGameState();

    const engineRef = useRef(null);

    const frameStoreRef = useRef(null);

    if (!engineRef.current) {

        engineRef.current = new PhysicsEngine();

    }

    if (!frameStoreRef.current) {

        frameStoreRef.current = createPhysicsFrameStore();

    }

    const frameStore = frameStoreRef.current;

    const handleFrame = useCallback(() => {

        frameStore.publishFrame(engineRef.current);

    }, [frameStore]);

    const publishDiscrete = useCallback(() => {

        frameStore.publishDiscrete(engineRef.current);

    }, [frameStore]);

    const handleButtonEvent = useCallback((event) => {

        if (isServerAuthoritative()) {

            return;

        }

        engineRef.current.handleButtonEvent(event);

        publishDiscrete();

    }, [publishDiscrete]);

    useEffect(() => {

        const engine = engineRef.current;

        // C5.9B — under Server Authority the client is apply-only.
        // Never drive prepare() / local brake-speed init from GAME_STATE.
        if (isServerAuthoritative()) {

            engine.stop();

            publishDiscrete();

            return undefined;

        }

        engine.handleGameState(gameState);

        if (engine.shouldRunLoop(gameState)) {

            engine.start(handleFrame);

            return () => engine.stop();

        }

        publishDiscrete();

        return undefined;

    }, [gameState, handleFrame, publishDiscrete]);

    useEffect(() => {

        return () => {

            engineRef.current.stop();

            engineRef.current.reset();

        };

    }, []);

    useRegisterEngineModule("physics", () => ({

        applyUpdate: (payload) => {

            engineRef.current.applyServerUpdate(payload);

            frameStore.publishFrame(engineRef.current);

            publishDiscrete();

            if (DEV_MODE) {

                console.debug("[PhysicsSync] Wheel rendered", {
                    wheelAngle: engineRef.current.wheelAngle,
                    simulationTime: payload?.simulationTime ?? null
                });

            }

        },

        restorePhysics: (snapshot) => {

            engineRef.current.restoreSessionSnapshot(snapshot);

            publishDiscrete();

        }

    }));

    const getFrame = useCallback(() => frameStore.getFrame(), [frameStore]);

    const subscribeFrame = useCallback(
        (listener) => frameStore.subscribeFrame(listener),
        [frameStore]
    );

    const subscribeDiscrete = useCallback(
        (listener) => frameStore.subscribeDiscrete(listener),
        [frameStore]
    );

    const value = useMemo(() => ({
        getFrame,
        subscribeFrame,
        subscribeDiscrete,
        gameState,
        handleButtonEvent
    }), [
        getFrame,
        subscribeFrame,
        subscribeDiscrete,
        gameState,
        handleButtonEvent
    ]);

    return (

        <PhysicsContext.Provider value={value}>

            {children}

        </PhysicsContext.Provider>

    );

}

export function usePhysics() {

    const context = useContext(PhysicsContext);

    if (!context) {

        throw new Error(
            "usePhysics must be used within PhysicsProvider"
        );

    }

    return context;

}

export function usePhysicsDiscreteSnapshot() {

    const { getFrame, subscribeDiscrete } = usePhysics();

    return useSyncExternalStore(subscribeDiscrete, getFrame, getFrame);

}
