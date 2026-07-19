import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useRef,
    useState
} from "react";

/**
 * In-memory player identity for the active application session only.
 *
 * Used by gameplay recovery after a socket reconnect within the same tab.
 * Intentionally does NOT persist across browser refresh (future Session
 * Management epic).
 *
 * State is reactive so Page3 local-player highlight/footer update when
 * playerId arrives (including last-joiner startGame race).
 */
const PlayerIdentityContext = createContext(null);

const EMPTY_IDENTITY = Object.freeze({
    roomId: null,
    playerId: null,
    gameId: null
});

export function PlayerIdentityProvider({ children }) {

    const [identity, setIdentityState] = useState(EMPTY_IDENTITY);

    const identityRef = useRef(EMPTY_IDENTITY);

    const setIdentity = useCallback((partial) => {

        setIdentityState((prev) => {

            const next = {
                ...prev,
                ...partial
            };

            identityRef.current = next;

            return next;

        });

    }, []);

    const clearIdentity = useCallback(() => {

        identityRef.current = EMPTY_IDENTITY;

        setIdentityState(EMPTY_IDENTITY);

    }, []);

    const getIdentity = useCallback(() => ({ ...identityRef.current }), []);

    const value = useMemo(() => ({
        identity,
        setIdentity,
        clearIdentity,
        getIdentity
    }), [identity, setIdentity, clearIdentity, getIdentity]);

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
