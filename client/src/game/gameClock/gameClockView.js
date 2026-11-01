// C4.7 — Authoritative GameClock presentation helpers.
//
// This module is deliberately free of any timing logic. It only stores the
// authoritative values the server pushes and formats them for display. The
// client never derives, predicts, or ticks gameplay time locally.

export const INITIAL_GAME_CLOCK = Object.freeze({
    gameId: null,
    phase: null,
    startedAt: null,
    endsAt: null,
    remainingMs: null,
    remainingSeconds: null,
    running: false,
    active: false,
    serverTimestamp: null,
    receivedAtMonotonic: null
});

const PHASE_LABELS = Object.freeze({
    PRE_GAME_READY: "PREPARATION",
    READY: "READY",
    SELF_TEST: "SELF TEST",
    SPEED: "SPINNING",
    BRAKE: "BRAKING",
    RESULT: "RESULT"
});

const CLOCK_PHASE_ORDER = Object.freeze({
    PRE_GAME_READY: 0,
    READY: 1,
    SELF_TEST: 2,
    SPEED: 3,
    BRAKE: 4,
    RESULT: 5
});

export function reduceGameClockUpdate(
    payload,
    current = INITIAL_GAME_CLOCK,
    receivedAtMonotonic = null
) {

    if (!payload) {

        return INITIAL_GAME_CLOCK;

    }

    if (payload.gameId && current?.gameId === payload.gameId) {

        const incomingOrder = CLOCK_PHASE_ORDER[payload.phase];
        const currentOrder = CLOCK_PHASE_ORDER[current.phase];

        if (Number.isFinite(incomingOrder)
            && Number.isFinite(currentOrder)
            && incomingOrder < currentOrder) {

            return current;

        }

        if (payload.phase === current.phase
            && Number.isFinite(payload.startedAt)
            && Number.isFinite(current.startedAt)
            && payload.startedAt < current.startedAt) {

            return current;

        }

        if (payload.phase === current.phase
            && Number.isFinite(payload.serverTimestamp)
            && Number.isFinite(current.serverTimestamp)
            && payload.serverTimestamp < current.serverTimestamp) {

            return current;

        }

    }

    const remainingSeconds = payload.remainingSeconds ?? null;

    return {
        gameId: payload.gameId ?? null,
        phase: payload.phase ?? null,
        startedAt: payload.startedAt ?? null,
        endsAt: payload.endsAt ?? null,
        remainingMs: payload.remainingMs ?? null,
        remainingSeconds,
        running: payload.running === true,
        active: payload.running === true && Boolean(payload.phase),
        serverTimestamp: payload.serverTimestamp ?? null,
        receivedAtMonotonic: Number.isFinite(receivedAtMonotonic)
            ? receivedAtMonotonic
            : null
    };

}

export function remainingSecondsFromEndsAt(endsAt) {

    if (!Number.isFinite(endsAt)) {

        return null;

    }

    return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));

}

export function resolveGameplayCountdown(
    clock,
    nowMonotonic = (typeof performance !== "undefined" ? performance.now() : null)
) {

    if (Number.isFinite(clock?.remainingMs)
        && Number.isFinite(clock?.receivedAtMonotonic)
        && Number.isFinite(nowMonotonic)) {

        const elapsed = Math.max(0, nowMonotonic - clock.receivedAtMonotonic);

        return Math.max(0, Math.ceil((clock.remainingMs - elapsed) / 1000));

    }

    if (Number.isFinite(clock?.endsAt)) {

        return remainingSecondsFromEndsAt(clock.endsAt);

    }

    return clock?.remainingSeconds ?? null;

}

export function resolveClockPhaseLabel(phase) {

    if (!phase) {

        return "—";

    }

    return PHASE_LABELS[phase] || phase;

}

export function formatClockSeconds(remainingSeconds) {

    if (remainingSeconds === null || remainingSeconds === undefined) {

        return "--:--";

    }

    const safeSeconds = Math.max(0, remainingSeconds);

    const minutes = Math.floor(safeSeconds / 60);

    const seconds = safeSeconds % 60;

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

}
