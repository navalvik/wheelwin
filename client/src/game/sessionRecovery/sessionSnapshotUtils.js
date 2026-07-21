import { RESULT_OUTCOMES } from "../centralButton/ButtonState";

import { GAME_STATES } from "../GameState";

export function normalizeSessionSnapshot(snapshot = {}) {

    const physicsSource = snapshot.physics || snapshot;

    const buttonSource = snapshot.button || snapshot.pressCounters || {};

    const pressCounter = buttonSource.pressCounter
        ?? buttonSource.pressCount
        ?? snapshot.pressCounters?.pressCounter
        ?? 0;

    const gameState = typeof snapshot.gameState === "string"
        ? snapshot.gameState
        : snapshot.gameState?.currentState
            ?? GAME_STATES.READY;

    return {
        gameId: snapshot.gameId ?? null,
        roomId: snapshot.roomId ?? null,
        playerId: snapshot.playerId ?? null,
        gameState,
        wheelConfiguration: snapshot.wheelConfiguration || null,
        wheelAngle: snapshot.wheelAngle
            ?? physicsSource.wheelAngle
            ?? 0,
        triangleAngle: snapshot.triangleAngle
            ?? physicsSource.triangleAngle
            ?? 0,
        physics: {
            wheelAngle: snapshot.wheelAngle
                ?? physicsSource.wheelAngle
                ?? 0,
            triangleAngle: snapshot.triangleAngle
                ?? physicsSource.triangleAngle
                ?? 0,
            currentWheelSpeed: physicsSource.currentWheelSpeed
                ?? physicsSource.wheelSpeed
                ?? 0,
            triangleSpeed: physicsSource.triangleSpeed ?? 0,
            isBraking: physicsSource.isBraking ?? false,
            remainingBrakeTime: physicsSource.remainingBrakeTime ?? null,
            elapsedTime: physicsSource.elapsedTime ?? null
        },
        playerStates: Array.isArray(snapshot.playerStates)
            ? snapshot.playerStates
            : [],
        button: {
            currentState: buttonSource.currentState
                ?? buttonSource.state
                ?? null,
            pressCounter,
            completedCycles: buttonSource.completedCycles
                ?? pressCounter,
            remainingPresses: buttonSource.remainingPresses,
            buttonPressed: buttonSource.buttonPressed === true
                || buttonSource.pressed === true,
            pressed: buttonSource.pressed === true
                || buttonSource.buttonPressed === true,
            locked: buttonSource.buttonLocked === true
                || buttonSource.locked === true,
            buttonLocked: buttonSource.buttonLocked === true
                || buttonSource.locked === true,
            lastReleaseAt: buttonSource.lastReleaseAt ?? null,
            cooldownUntil: buttonSource.cooldownUntil ?? null,
            enabled: buttonSource.enabled,
            preGameReadyConfirmed: snapshot.preGameReady?.readyPlayers
                && snapshot.playerId != null
                ? snapshot.preGameReady.readyPlayers[snapshot.playerId] === true
                : buttonSource.preGameReadyConfirmed === true
        },
        preGameReady: snapshot.preGameReady || null,
        remainingGameTime: snapshot.remainingGameTime ?? null,
        phaseStartedAt: snapshot.phaseStartedAt ?? null,
        phaseEndsAt: snapshot.phaseEndsAt ?? null,
        gameResult: snapshot.gameResult || null,
        payment: snapshot.payment || null,
        resultOutcome: mapSnapshotResultOutcome(snapshot),
        timestamp: snapshot.timestamp ?? null
    };

}

function mapSnapshotResultOutcome(snapshot) {

    if (snapshot.resultOutcome) {

        return snapshot.resultOutcome;

    }

    const outcome = snapshot.gameResult?.localOutcome
        ?? snapshot.gameResult?.outcome;

    if (outcome === "LOSE" || outcome === RESULT_OUTCOMES.LOST) {

        return RESULT_OUTCOMES.LOST;

    }

    if (outcome === "WIN" || outcome === RESULT_OUTCOMES.WIN) {

        return RESULT_OUTCOMES.WIN;

    }

    return null;

}

export function getModulesToRestore(snapshot) {

    const normalized = normalizeSessionSnapshot(snapshot);

    const modules = [
        "wheel",
        "physics",
        "gameState",
        "gameClock",
        "playerUI",
        "button",
        "audio"
    ];

    if (normalized.preGameReady
        || normalized.gameState === GAME_STATES.PRE_GAME_READY) {

        modules.splice(6, 0, "preGameReady");

    }

    if (normalized.gameResult
        || normalized.gameState === GAME_STATES.RESULT) {

        modules.push("winnerResolver");

    }

    if (normalized.payment) {

        modules.push("payment");

    }

    return modules;

}
