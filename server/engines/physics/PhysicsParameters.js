export const DEFAULT_PHYSICS_PARAMETERS = Object.freeze({
    maxAngularVelocity: Math.PI * 2,
    maxAcceleration: Math.PI * 4,
    brakeCoefficient: Math.PI * 8,
    inertiaCoefficient: 0,
    velocityStopThreshold: 0.01,
    fixedSimulationStepMs: 10
});
