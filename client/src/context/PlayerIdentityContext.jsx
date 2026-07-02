import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useRef
} from "react";

/**
 * In-memory player identity for the active application session only.
 *
 * Used by gameplay recovery after a socket reconnect within the same tab.
 * Intentionally does NOT persist across browser refresh (future Session
 * Management epic).
 */
const PlayerIdentityContext = createContext(null);

export function PlayerIdentityProvider({ children }) {

    const identityRef = useRef({
        roomId: null,
        playerId: null,
        gameId: null
    });

    const setIdentity = useCallback((partial) => {

        identityRef.current = {
            ...identityRef.current,
            ...partial
        };

    }, []);

    const clearIdentity = useCallback(() => {

        identityRef.current = {
            roomId: null,
            playerId: null,
            gameId: null
        };

    }, []);

    const getIdentity = useCallback(() => ({ ...identityRef.current }), []);

    const value = useMemo(() => ({
        setIdentity,
        clearIdentity,
        getIdentity
    }), [setIdentity, clearIdentity, getIdentity]);

    return (

        <PlayerIdentityContext.Provider value={value}>

            {children}

        </PlayerIdentityContext.Provider>

    );

}

export function usePlayerIdentity() {

    const context = useContext(PlayerIdentityContext);

    if (!context) {

        throw new Error(
            "usePlayerIdentity must be used within PlayerIdentityProvider"
        );

    }

    return context;

}

/**
 * Safe accessor for modules that may render outside the provider in tests.
 */
export function usePlayerIdentityReader() {

    const context = useContext(PlayerIdentityContext);

    return context?.getIdentity ?? (() => ({
        roomId: null,
        playerId: null,
        gameId: null
    }));

}
