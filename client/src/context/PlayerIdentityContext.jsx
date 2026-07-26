import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useRef,
    useState
} from "react";

/**
 * Player identity for the active application session.
 *
 * R6.1 — Persists roomId/playerId in sessionStorage so a browser refresh during
 * an active Setup Session can present a reclaim claim. The server still owns
 * identity; the stored values are only a lookup key into soft-disconnect stash.
 */

const PlayerIdentityContext = createContext(null);

const STORAGE_KEY = "wheelwin.setupRecoveryIdentity";

const PAGE_STORAGE_KEY = "wheelwin.setupRecoveryPage";

const EMPTY_IDENTITY = Object.freeze({
    roomId: null,
    playerId: null,
    gameId: null
});

function readStoredIdentity() {

    if (typeof window === "undefined" || !window.sessionStorage) {

        return EMPTY_IDENTITY;

    }

    try {

        const raw = window.sessionStorage.getItem(STORAGE_KEY);

        if (!raw) {

            return EMPTY_IDENTITY;

        }

        const parsed = JSON.parse(raw);

        if (!parsed?.roomId || !parsed?.playerId) {

            return EMPTY_IDENTITY;

        }

        return {
            roomId: parsed.roomId,
            playerId: parsed.playerId,
            gameId: parsed.gameId ?? null
        };

    } catch {

        return EMPTY_IDENTITY;

    }

}

function writeStoredIdentity(identity) {

    if (typeof window === "undefined" || !window.sessionStorage) {

        return;

    }

    try {

        if (!identity?.roomId || !identity?.playerId) {

            window.sessionStorage.removeItem(STORAGE_KEY);

            window.sessionStorage.removeItem(PAGE_STORAGE_KEY);

            return;

        }

        window.sessionStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                roomId: identity.roomId,
                playerId: identity.playerId,
                gameId: identity.gameId ?? null
            })
        );

    } catch {

        // Ignore quota / private-mode failures; in-memory identity still works.

    }

}

export function readStoredRecoveryPage() {

    if (typeof window === "undefined" || !window.sessionStorage) {

        return null;

    }

    try {

        const raw = window.sessionStorage.getItem(PAGE_STORAGE_KEY);

        const page = Number(raw);

        return Number.isFinite(page) && page > 0 ? page : null;

    } catch {

        return null;

    }

}

export function writeStoredRecoveryPage(page) {

    if (typeof window === "undefined" || !window.sessionStorage) {

        return;

    }

    try {

        if (!Number.isFinite(page) || page <= 0) {

            window.sessionStorage.removeItem(PAGE_STORAGE_KEY);

            return;

        }

        window.sessionStorage.setItem(PAGE_STORAGE_KEY, String(page));

    } catch {

        // Ignore storage failures.

    }

}

export function PlayerIdentityProvider({ children }) {

    const [identity, setIdentityState] = useState(() => readStoredIdentity());

    const identityRef = useRef(identity);

    identityRef.current = identity;

    const setIdentity = useCallback((partial) => {

        setIdentityState((prev) => {

            const next = {
                ...prev,
                ...partial
            };

            identityRef.current = next;

            writeStoredIdentity(next);

            return next;

        });

    }, []);

    const clearIdentity = useCallback(() => {

        identityRef.current = EMPTY_IDENTITY;

        writeStoredIdentity(EMPTY_IDENTITY);

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
