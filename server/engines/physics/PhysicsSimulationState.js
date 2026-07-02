export const PHYSICS_SIMULATION_STATE = Object.freeze({
    CREATED: "CREATED",
    RUNNING: "RUNNING",
    BRAKING: "BRAKING",
    STOPPED: "STOPPED",
    REMOVED: "REMOVED"
});

export const PHYSICS_STATE_TRANSITIONS = Object.freeze({
    [PHYSICS_SIMULATION_STATE.CREATED]: Object.freeze([
        PHYSICS_SIMULATION_STATE.RUNNING
    ]),
    [PHYSICS_SIMULATION_STATE.RUNNING]: Object.freeze([
        PHYSICS_SIMULATION_STATE.BRAKING,
        PHYSICS_SIMULATION_STATE.STOPPED
    ]),
    [PHYSICS_SIMULATION_STATE.BRAKING]: Object.freeze([
        PHYSICS_SIMULATION_STATE.STOPPED
    ]),
    [PHYSICS_SIMULATION_STATE.STOPPED]: Object.freeze([
        PHYSICS_SIMULATION_STATE.REMOVED
    ]),
    [PHYSICS_SIMULATION_STATE.REMOVED]: Object.freeze([])
});

export function canTransitionPhysicsState(currentState, nextState) {

    const allowed = PHYSICS_STATE_TRANSITIONS[currentState] ?? [];

    return allowed.includes(nextState);

}
