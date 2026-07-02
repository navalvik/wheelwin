import { RESULT_OUTCOMES } from "../centralButton/ButtonState";

import { GAME_STATES } from "../GameState";

export function normalizeSessionSnapshot(snapshot = {}) {

    const physicsSource = snapshot.physics || snapshot;

    const buttonSource = snapshot.button || snapshot.pressCounters || {};

    const pressCounter = buttonSource.pressCounter
        ?? buttonSource.pressCount
        ?? snapshot.pressCounters?.pressCounter
        ?? 0;

    return {
        gameState: snapshot.gameState || GAME_STATES.READY,
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
            enabled: buttonSource.enabled,
            locked: buttonSource.locked
        },
        remainingGameTime: snapshot.remainingGameTime ?? null,
        gameResult: snapshot.gameResult || null,
        resultOutcome: mapSnapshotResultOutcome(snapshot)
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
        "playerUI",
        "button",
        "audio"
    ];

    if (normalized.gameResult
        || normalized.gameState === GAME_STATES.RESULT) {

        modules.push("winnerResolver");

    }

    return modules;

}
