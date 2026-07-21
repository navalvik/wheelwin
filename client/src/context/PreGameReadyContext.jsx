import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState
} from "react";

import { useRegisterEngineModule } from "./EngineBridgeContext";
import { usePlayerIdentity } from "./PlayerIdentityContext";

const INITIAL_STATE = Object.freeze({
    readyPlayers: {},
    startedAt: null,
    expiresAt: null,
    active: false
});

const PreGameReadyContext = createContext(null);

export function PreGameReadyProvider({ children }) {

    const { playerId: localPlayerId } = usePlayerIdentity();

    const [state, setState] = useState(INITIAL_STATE);

    const applyPayload = useCallback((payload) => {

        if (!payload || typeof payload !== "object") {

            return;

        }

        setState({
            readyPlayers: payload.readyPlayers ?? {},
            startedAt: payload.startedAt ?? null,
            expiresAt: payload.expiresAt ?? null,
            active: true
        });

    }, []);

    const clearState = useCallback(() => {

        setState(INITIAL_STATE);

    }, []);

    useRegisterEngineModule("preGameReady", () => ({

        onPreGameReadyStarted: applyPayload,

        onPreGameReadyUpdated: applyPayload,

        onPreGameReadyCompleted: clearState,

        restorePreGameReady: (snapshot) => {

            if (!snapshot?.preGameReady) {

                clearState();

                return;

            }

            applyPayload(snapshot.preGameReady);

        }

    }));

    const localConfirmed = localPlayerId != null
        && state.readyPlayers[localPlayerId] === true;

    const value = useMemo(() => ({
        ...state,
        localConfirmed,
        isPlayerReady: (playerId) => state.readyPlayers[playerId] === true
    }), [state, localConfirmed]);

    return (

        <PreGameReadyContext.Provider value={value}>

            {children}

        </PreGameReadyContext.Provider>

    );

}

export function usePreGameReady() {

    const context = useContext(PreGameReadyContext);

    if (!context) {

        throw new Error(
            "usePreGameReady must be used within PreGameReadyProvider"
        );

    }

    return context;

}
