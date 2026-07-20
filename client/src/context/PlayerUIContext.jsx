import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef
} from "react";

import { PlayerUIEngine } from "../game/playerUI";

import { PLAYER_UI_STATES } from "../game/playerUI/PlayerState";

import { listAuthoritativePlayers } from "../game/session";

import { useAuthoritativeSession } from "./AuthoritativeSessionContext";

import { useRegisterEngineModule } from "./EngineBridgeContext";
import { useGameState } from "./GameStateContext";
import { useCentralButton } from "./CentralButtonContext";

const PlayerUIContext = createContext(null);

export function PlayerUIProvider({ children }) {

    const { gameState } = useGameState();

    const { resultOutcome } = useCentralButton();

    const authoritative = useAuthoritativeSession();

    const engineRef = useRef(null);

    if (!engineRef.current) {

        engineRef.current = new PlayerUIEngine();

    }

    // R1.2 — seed / refresh PlayerUI from authoritative roster only.
    useEffect(() => {

        const roster = listAuthoritativePlayers(authoritative.players);

        engineRef.current.syncFromAuthoritativeRoster(roster);

    }, [authoritative.players]);

    useEffect(() => {

        engineRef.current.syncWithGameState(gameState, resultOutcome);

    }, [gameState, resultOutcome]);

    useEffect(() => {

        return () => {

            engineRef.current.reset();

        };

    }, []);

    useRegisterEngineModule("playerUI", () => ({

        updatePlayer: (payload) => {

            const id = payload?.id ?? payload?.playerId;

            if (!id) {

                return;

            }

            engineRef.current.updatePlayer({ ...payload, id });

        },

        setOnline: (playerId) => {

            engineRef.current.setOnline(playerId);

        },

        setOffline: (playerId) => {

            engineRef.current.setOffline(playerId);

        },

        updateSpeedInput: (payload) => {

            engineRef.current.updateSpeedInput(payload);

        },

        restorePlayerUI: (snapshot) => {

            engineRef.current.restoreSessionSnapshot(snapshot);

        },

        setLocalPlayerOffline: (playerId) => {

            engineRef.current.setOffline(playerId);

        },

        setLocalPlayerOnline: (playerId) => {

            engineRef.current.setOnline(playerId);

        }

    }));

    const setPlayerData = useCallback((player) => {

        engineRef.current.setPlayerData(player);

    }, []);

    const setOnline = useCallback((id) => {

        engineRef.current.setOnline(id);

    }, []);

    const setOffline = useCallback((id) => {

        engineRef.current.setOffline(id);

    }, []);

    const setState = useCallback((id, state) => {

        engineRef.current.setState(id, state);

    }, []);

    const updatePlayer = useCallback((player) => {

        engineRef.current.updatePlayer(player);

    }, []);

    const togglePlayerOnline = useCallback((id) => {

        const player = engineRef.current.getPlayer(id);

        if (!player) {

            return;

        }

        if (player.online) {

            engineRef.current.setOffline(id);

        } else {

            engineRef.current.setOnline(id);

        }

    }, []);

    const setDebugPlayerState = useCallback((id, state) => {

        engineRef.current.setState(id, state);

    }, []);

    const value = useMemo(() => ({
        engine: engineRef.current,
        setPlayerData,
        setOnline,
        setOffline,
        setState,
        updatePlayer,
        togglePlayerOnline,
        setDebugPlayerState
    }), [
        setPlayerData,
        setOnline,
        setOffline,
        setState,
        updatePlayer,
        togglePlayerOnline,
        setDebugPlayerState
    ]);

    return (

        <PlayerUIContext.Provider value={value}>

            {children}

        </PlayerUIContext.Provider>

    );

}

export function usePlayerUI() {

    const context = useContext(PlayerUIContext);

    if (!context) {

        throw new Error(
            "usePlayerUI must be used within PlayerUIProvider"
        );

    }

    return context;

}

export { PLAYER_UI_STATES };
