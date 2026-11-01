import {
    createContext,
    useContext,
    useMemo,
    useState
} from "react";

import {
    INITIAL_GAME_CLOCK,
    formatClockSeconds,
    reduceGameClockUpdate,
    resolveClockPhaseLabel
} from "../game/gameClock/gameClockView";

import { useRegisterEngineModule } from "./EngineBridgeContext";
import { useAuthoritativeSessionStore } from "./AuthoritativeSessionContext";

const GameClockContext = createContext(null);

export function GameClockProvider({ children }) {

    const [clock, setClock] = useState(INITIAL_GAME_CLOCK);

    const authoritativeSession = useAuthoritativeSessionStore();

    const belongsToActiveGame = (payload) => {

        const activeGameId = authoritativeSession.getSnapshot()?.gameId;

        return !activeGameId
            || !payload?.gameId
            || payload.gameId === activeGameId;

    };

    // The authoritative GameClock is pushed by the server (GAME_CLOCK_UPDATE).
    // Registering the module here — above Page5 and for the whole gameplay
    // session — guarantees no clock packet is missed due to page mounting and
    // that a reconnecting client re-syncs on the next authoritative tick.
    useRegisterEngineModule("gameClock", () => ({

        onClockUpdate: (payload) => {

            if (!belongsToActiveGame(payload)) return;

            const receivedAt = typeof performance !== "undefined"
                ? performance.now()
                : Date.now();

            setClock((current) => reduceGameClockUpdate(
                payload,
                current,
                receivedAt
            ));

        },

        restoreClock: (snapshot) => {

            if (!snapshot) {

                return;

            }

            if (!belongsToActiveGame(snapshot)) return;

            const receivedAt = typeof performance !== "undefined"
                ? performance.now()
                : Date.now();

            setClock((current) => reduceGameClockUpdate({
                gameId: snapshot.gameId ?? null,
                phase: typeof snapshot.gameState === "string"
                    ? snapshot.gameState
                    : snapshot.gameState?.currentState ?? null,
                startedAt: snapshot.phaseStartedAt ?? null,
                endsAt: snapshot.phaseEndsAt ?? null,
                remainingMs: Number.isFinite(snapshot.remainingGameTime)
                    ? snapshot.remainingGameTime
                    : null,
                remainingSeconds: Number.isFinite(snapshot.remainingGameTime)
                    ? Math.ceil(snapshot.remainingGameTime / 1000)
                    : null,
                running: true,
                serverTimestamp: snapshot.timestamp ?? Date.now(),
                syncSequence: snapshot.syncSequence ?? null
            }, current, receivedAt));

        }

    }));

    const value = useMemo(() => ({
        clock,
        phaseLabel: resolveClockPhaseLabel(clock.phase),
        remainingText: formatClockSeconds(clock.remainingSeconds)
    }), [clock]);

    return (

        <GameClockContext.Provider value={value}>

            {children}

        </GameClockContext.Provider>

    );

}

export function useGameClock() {

    const context = useContext(GameClockContext);

    if (!context) {

        throw new Error(
            "useGameClock must be used within GameClockProvider"
        );

    }

    return context;

}
