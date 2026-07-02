import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useSyncExternalStore
} from "react";

import { RESULT_OUTCOMES } from "../game/centralButton";

import { GAME_STATES } from "../game/GameState";

import { WinnerResolver, WINNER_EVENTS } from "../game/winner";

import { isServerAuthoritative } from "../game/gameAuthority";

import { useRegisterEngineModule } from "./EngineBridgeContext";

import { useCentralButton } from "./CentralButtonContext";

import { useGameState } from "./GameStateContext";

import { usePhysics } from "./PhysicsContext";

import { usePlayerUI } from "./PlayerUIContext";

const WinnerResolverContext = createContext(null);

function mapLocalOutcomeToResultOutcome(localOutcome) {

    return localOutcome === "LOSE"
        ? RESULT_OUTCOMES.LOST
        : RESULT_OUTCOMES.WIN;

}

function applyResultToPlayerUI(engine, winnerId) {

    if (!engine || winnerId === null || winnerId === undefined) {

        return;

    }

    engine.applyGameResult(winnerId);

}

export function WinnerResolverProvider({
    children,
    wheelConfiguration,
    localPlayerId = 1
}) {

    const { gameState } = useGameState();

    const { getFrame } = usePhysics();

    const { engine: playerUIEngine } = usePlayerUI();

    const { setResultOutcome } = useCentralButton();

    const resolverRef = useRef(null);

    const debugListenersRef = useRef(new Set());

    const winnerEventListenersRef = useRef(new Set());

    const debugRef = useRef({
        winningSector: null,
        winningPlayer: null,
        wheelAngle: 0,
        triangleAngle: 0,
        resolved: false
    });

    const resolvedForResultRef = useRef(false);

    const lastPublishedResultKeyRef = useRef(null);

    if (!resolverRef.current) {

        resolverRef.current = new WinnerResolver();

    }

    resolverRef.current.setLocalPlayerId(localPlayerId);

    const notifyDebugListeners = useCallback(() => {

        debugListenersRef.current.forEach((listener) => listener());

    }, []);

    const subscribe = useCallback((listener) => {

        debugListenersRef.current.add(listener);

        return () => {

            debugListenersRef.current.delete(listener);

        };

    }, []);

    const getDebugSnapshot = useCallback(() => debugRef.current, []);

    const emitWinnerEvent = useCallback((localOutcome) => {

        const eventType = localOutcome === "LOSE"
            ? WINNER_EVENTS.LOSE
            : WINNER_EVENTS.WIN;

        winnerEventListenersRef.current.forEach((listener) => {

            listener({ type: eventType });

        });

    }, []);

    const publishResult = useCallback((result) => {

        if (!result) {

            return;

        }

        const resultKey = [
            result.winner?.id,
            result.winningSector?.index,
            result.localOutcome
        ].join(":");

        if (lastPublishedResultKeyRef.current === resultKey) {

            return;

        }

        lastPublishedResultKeyRef.current = resultKey;

        applyResultToPlayerUI(playerUIEngine, result.winner?.id ?? null);

        setResultOutcome(
            mapLocalOutcomeToResultOutcome(result.localOutcome)
        );

        debugRef.current = {
            winningSector: result.winningSector,
            winningPlayer: result.winner,
            wheelAngle: result.finalWheelAngle,
            triangleAngle: result.finalTriangleAngle,
            resolved: true
        };

        emitWinnerEvent(result.localOutcome);

        notifyDebugListeners();

    }, [
        playerUIEngine,
        setResultOutcome,
        emitWinnerEvent,
        notifyDebugListeners
    ]);

    useEffect(() => {

        if (gameState !== GAME_STATES.RESULT) {

            resolvedForResultRef.current = false;

            lastPublishedResultKeyRef.current = null;

            resolverRef.current.reset();

            debugRef.current = {
                winningSector: null,
                winningPlayer: null,
                wheelAngle: 0,
                triangleAngle: 0,
                resolved: false
            };

            notifyDebugListeners();

            return;

        }

        if (resolvedForResultRef.current) {

            return;

        }

        if (isServerAuthoritative()) {

            return;

        }

        resolvedForResultRef.current = true;

        const frame = getFrame();

        const players = playerUIEngine.getPlayers();

        const result = resolverRef.current.resolveWinner({
            wheelAngle: frame.wheelAngle,
            triangleAngle: frame.triangleAngle,
            configuration: wheelConfiguration,
            players,
            localPlayerId
        });

        publishResult(result);

    }, [
        gameState,
        wheelConfiguration,
        playerUIEngine,
        localPlayerId,
        getFrame,
        publishResult,
        notifyDebugListeners
    ]);

    useRegisterEngineModule("winnerResolver", () => ({

        applyServerResult: (payload) => {

            const result = resolverRef.current.applyServerResult(payload);

            if (!result) {

                return null;

            }

            resolvedForResultRef.current = true;

            publishResult(result);

            return result;

        },

        getResult: () => resolverRef.current.generateResult(),

        restoreWinnerResult: (snapshot) => {

            if (!snapshot?.gameResult) {

                return null;

            }

            const result = resolverRef.current.applyServerResult(
                snapshot.gameResult
            );

            if (!result) {

                return null;

            }

            resolvedForResultRef.current = true;

            publishResult(result);

            return result;

        }

    }));

    const resolveWinner = useCallback(() => {

        const frame = getFrame();

        const players = playerUIEngine.getPlayers();

        resolverRef.current.reset();

        lastPublishedResultKeyRef.current = null;

        const result = resolverRef.current.resolveWinner({
            wheelAngle: frame.wheelAngle,
            triangleAngle: frame.triangleAngle,
            configuration: wheelConfiguration,
            players,
            localPlayerId
        });

        publishResult(result);

        return result;

    }, [
        playerUIEngine,
        getFrame,
        wheelConfiguration,
        localPlayerId,
        publishResult
    ]);

    const value = useMemo(() => ({
        getWinner: () => resolverRef.current.getWinner(),
        getWinningSector: () => resolverRef.current.getWinningSector(),
        generateResult: () => resolverRef.current.generateResult(),
        resolveWinner,
        reset: () => {
            resolverRef.current.reset();
            resolvedForResultRef.current = false;
            lastPublishedResultKeyRef.current = null;
            const frame = getFrame();
            debugRef.current = {
                winningSector: null,
                winningPlayer: null,
                wheelAngle: frame.wheelAngle,
                triangleAngle: frame.triangleAngle,
                resolved: false
            };
            notifyDebugListeners();
        },
        subscribeToWinnerEvents: (listener) => {

            winnerEventListenersRef.current.add(listener);

            return () => {

                winnerEventListenersRef.current.delete(listener);

            };

        },
        subscribe,
        getDebugSnapshot
    }), [
        resolveWinner,
        subscribe,
        getDebugSnapshot,
        getFrame,
        notifyDebugListeners
    ]);

    return (

        <WinnerResolverContext.Provider value={value}>

            {children}

        </WinnerResolverContext.Provider>

    );

}

export function useWinnerResolver() {

    const context = useContext(WinnerResolverContext);

    if (!context) {

        throw new Error(
            "useWinnerResolver must be used within WinnerResolverProvider"
        );

    }

    return context;

}

export function useWinnerDebugSnapshot() {

    const { subscribe, getDebugSnapshot } = useWinnerResolver();

    return useSyncExternalStore(subscribe, getDebugSnapshot, getDebugSnapshot);

}

export function formatWinnerDebugLines(snapshot) {

    const sector = snapshot.winningSector;

    const player = snapshot.winningPlayer;

    return {
        winningSector: sector
            ? `#${sector.index + 1} ${sector.icon} (${sector.color})`
            : "—",
        winningPlayer: player
            ? `${player.nickname} (id ${player.id})`
            : "—",
        wheelAngle: `${snapshot.wheelAngle.toFixed(1)}°`,
        triangleAngle: `${snapshot.triangleAngle.toFixed(1)}°`,
        resolved: snapshot.resolved ? "yes" : "no"
    };

}
