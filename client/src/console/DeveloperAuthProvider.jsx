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
    clearStoredDeveloperSession,
    fetchDeveloperAuthStatus,
    isSessionExpired,
    loadStoredDeveloperSession,
    loginDeveloper,
    logoutDeveloper,
    refreshDeveloperSession,
    storeDeveloperSession,
    toClientSession
} from "./developerAuthApi";

const DeveloperAuthContext = createContext(null);

/**
 * R6.1 — Developer session context for the console tree only.
 */
export function DeveloperAuthProvider({ children }) {

    const [authEnabled, setAuthEnabled] = useState(true);

    const [environment, setEnvironment] = useState("Development");

    const [session, setSession] = useState(() => loadStoredDeveloperSession());

    const [status, setStatus] = useState("loading");

    const [error, setError] = useState(null);

    const refreshTimerRef = useRef(null);

    const applySession = useCallback((next) => {

        if (!next) {

            clearStoredDeveloperSession();

            setSession(null);

            return;

        }

        const clientSession = toClientSession(next);

        storeDeveloperSession(clientSession);

        setSession(clientSession);

    }, []);

    const clearSession = useCallback(() => {

        clearStoredDeveloperSession();

        setSession(null);

    }, []);

    const renew = useCallback(async (current) => {

        if (!current?.refreshToken) {

            clearSession();

            setStatus("anonymous");

            return null;

        }

        try {

            const renewed = await refreshDeveloperSession(current.refreshToken);

            applySession(renewed);

            setStatus("authenticated");

            setError(null);

            return toClientSession(renewed);

        } catch (err) {

            clearSession();

            setStatus("anonymous");

            setError(err.message || "Session expired");

            return null;

        }

    }, [applySession, clearSession]);

    useEffect(() => {

        let cancelled = false;

        async function bootstrap() {

            try {

                const authStatus = await fetchDeveloperAuthStatus();

                if (cancelled) {

                    return;

                }

                setAuthEnabled(authStatus?.enabled !== false);

                if (authStatus?.environment) {

                    setEnvironment(authStatus.environment);

                }

                if (authStatus?.enabled === false) {

                    clearSession();

                    setStatus("open");

                    return;

                }

                const stored = loadStoredDeveloperSession();

                if (!stored) {

                    setStatus("anonymous");

                    return;

                }

                if (!isSessionExpired(stored)) {

                    setSession(stored);

                    setStatus("authenticated");

                    return;

                }

                await renew(stored);

            } catch {

                if (!cancelled) {

                    // If status endpoint unreachable, still allow login attempt.
                    setAuthEnabled(true);

                    setStatus("anonymous");

                }

            }

        }

        bootstrap();

        return () => {

            cancelled = true;

        };

    }, [clearSession, renew]);

    useEffect(() => {

        if (refreshTimerRef.current) {

            window.clearTimeout(refreshTimerRef.current);

            refreshTimerRef.current = null;

        }

        if (!session?.expiresAt || status !== "authenticated") {

            return undefined;

        }

        const delay = Math.max(
            5_000,
            session.expiresAt - Date.now() - 30_000
        );

        refreshTimerRef.current = window.setTimeout(() => {

            renew(session);

        }, delay);

        return () => {

            if (refreshTimerRef.current) {

                window.clearTimeout(refreshTimerRef.current);

            }

        };

    }, [session, status, renew]);

    const login = useCallback(async ({ username, password }) => {

        setError(null);

        setStatus("authenticating");

        try {

            const next = await loginDeveloper({ username, password });

            applySession(next);

            setStatus("authenticated");

            return true;

        } catch (err) {

            setStatus("anonymous");

            setError(err.message || "Login failed");

            return false;

        }

    }, [applySession]);

    const logout = useCallback(async () => {

        const current = session;

        clearSession();

        setStatus(authEnabled ? "anonymous" : "open");

        setError(null);

        await logoutDeveloper({
            accessToken: current?.accessToken,
            refreshToken: current?.refreshToken
        });

    }, [authEnabled, clearSession, session]);

    const value = useMemo(() => ({
        authEnabled,
        environment: session?.environment || environment,
        session,
        status,
        error,
        isAuthenticated: status === "authenticated" || status === "open",
        requiresLogin: authEnabled && status !== "authenticated" && status !== "open",
        accessToken: session?.accessToken ?? null,
        login,
        logout
    }), [
        authEnabled,
        environment,
        session,
        status,
        error,
        login,
        logout
    ]);

    return (

        <DeveloperAuthContext.Provider value={value}>

            {children}

        </DeveloperAuthContext.Provider>

    );

}

export function useDeveloperAuth() {

    const context = useContext(DeveloperAuthContext);

    if (!context) {

        throw new Error("useDeveloperAuth requires DeveloperAuthProvider");

    }

    return context;

}
