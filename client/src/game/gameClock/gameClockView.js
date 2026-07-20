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
    serverTimestamp: null
});

const PHASE_LABELS = Object.freeze({
    READY: "READY",
    SELF_TEST: "SELF TEST",
    SPEED: "SPINNING",
    BRAKE: "BRAKING",
    RESULT: "RESULT"
});

export function reduceGameClockUpdate(payload) {

    if (!payload) {

        return INITIAL_GAME_CLOCK;

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
        serverTimestamp: payload.serverTimestamp ?? null
    };

}

export function remainingSecondsFromEndsAt(endsAt) {

    if (!Number.isFinite(endsAt)) {

        return null;

    }

    return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));

}

export function resolveGameplayCountdown(clock) {

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
