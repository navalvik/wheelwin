import { PAYMENT_STATUS } from "../../catalog/PaymentRules.js";
import { CLOCK_PHASE_SEQUENCE } from "../gameClock/ClockPhases.js";
import { CONFIGURATION_VERSION } from "../configuration/ConfigurationVersion.js";
import { GAME_STATES } from "../gameState/GameStates.js";
import { isTransitionAllowed } from "../gameState/TransitionTable.js";
import { PHYSICS_SIMULATION_STATE } from "../physics/PhysicsSimulationState.js";
import { GeometryAdapter } from "../winner/GeometryAdapter.js";
import { PlayerResolver } from "../winner/PlayerResolver.js";
import { PrizeCalculator } from "../payment/PrizeCalculator.js";
import { resolveGameFinancialRules } from "../payment/resolveGameFinancialRules.js";
import { SectorResolver } from "../winner/SectorResolver.js";

function createCheckResult({ passed, errors = [], warnings = [] }) {

    return {
        passed,
        errors: [...errors],
        warnings: [...warnings]
    };

}

export class AuditVerifier {

    constructor({
        gameCatalog,
        configurationEngine = null,
        gameContractManager = null
    }) {

        this._gameCatalog = gameCatalog;

        this._configurationEngine = configurationEngine;

        this._gameContractManager = gameContractManager;

        this._prizeCalculator = new PrizeCalculator({
            paymentRules: gameCatalog.getPaymentRules()
        });

        const winnerRules = gameCatalog.getWinnerRules();

        this._sectorResolver = new SectorResolver({
            geometryAdapter: new GeometryAdapter({
                angleToleranceRadians: winnerRules.angleToleranceRadians
            })
        });

        this._playerResolver = new PlayerResolver();

    }

    setGameContractManager(gameContractManager) {

        this._gameContractManager = gameContractManager ?? null;

    }

    verify(sources) {

        const configurationCheck = this.verifyConfiguration(sources.configuration);

        const gameStateCheck = this.verifyGameState(sources.gameStateHistory);

        const clockCheck = this.verifyClock(sources.clockHistory);

        const physicsCheck = this.verifyPhysics(sources.physics);

        const winnerCheck = this.verifyWinner(
            sources.winner,
            sources.configuration,
            sources.physics
        );

        const paymentCheck = this.verifyPayment(
            sources.payment,
            sources.winner,
            sources.configuration
        );

        const recoveryCheck = this.verifyRecovery(
            sources.recovery,
            sources
        );

        const checks = {
            configuration: configurationCheck,
            gameState: gameStateCheck,
            clock: clockCheck,
            physics: physicsCheck,
            winner: winnerCheck,
            payment: paymentCheck,
            recovery: recoveryCheck
        };

        const errors = [];

        const warnings = [];

        for (const check of Object.values(checks)) {

            errors.push(...check.errors);

            warnings.push(...check.warnings);

        }

        return {
            passed: Object.values(checks).every((check) => check.passed),
            checks,
            errors,
            warnings
        };

    }

    verifyConfiguration(configuration) {

        if (!configuration) {

            return createCheckResult({
                passed: false,
                errors: ["Configuration is missing"]
            });

        }

        const errors = [];

        const warnings = [];

        if (!Object.isFrozen(configuration)) {

            errors.push("Configuration is not immutable");

        }

        if (configuration.configurationVersion !== CONFIGURATION_VERSION) {

            errors.push("Configuration version is invalid");

        }

        if (!configuration.traceSeed) {

            errors.push("Configuration traceSeed is missing");

        }

        if (!this._gameCatalog.getStakes().includes(configuration.stake)) {

            errors.push("Configuration stake is not allowed by catalog");

        }

        const wheelRules = this._gameCatalog.getWheelRules();

        if (configuration.sectors.length < wheelRules.minSectors
            || configuration.sectors.length > wheelRules.maxSectors) {

            errors.push("Configuration sector count is outside catalog limits");

        }

        const playerIds = new Set(
            configuration.players.map((player) => player.playerId)
        );

        for (const sector of configuration.sectors) {

            if (!playerIds.has(sector.ownerId)) {

                errors.push(`Sector owner is unknown (${sector.ownerId})`);

            }

        }

        const catalogTimerKeys = Object.keys(this._gameCatalog.getTimers());

        for (const timerKey of catalogTimerKeys) {

            if (!configuration.timers[timerKey]) {

                errors.push(`Configuration timer is missing (${timerKey})`);

            }

        }

        return createCheckResult({
            passed: errors.length === 0,
            errors,
            warnings
        });

    }

    verifyGameState(gameStateHistory) {

        if (!Array.isArray(gameStateHistory) || gameStateHistory.length === 0) {

            return createCheckResult({
                passed: false,
                errors: ["Game state history is missing"]
            });

        }

        const errors = [];

        if (gameStateHistory[0].state !== GAME_STATES.READY) {

            errors.push("Game state history must begin in READY");

        }

        for (let index = 1; index < gameStateHistory.length; index += 1) {

            const previousState = gameStateHistory[index - 1].state;

            const nextState = gameStateHistory[index].state;

            if (!isTransitionAllowed(previousState, nextState)) {

                errors.push(
                    `Invalid game state transition (${previousState} -> ${nextState})`
                );

            }

        }

        const finalState = gameStateHistory[gameStateHistory.length - 1].state;

        if (finalState !== GAME_STATES.RESULT) {

            errors.push("Completed game must end in RESULT state");

        }

        return createCheckResult({
            passed: errors.length === 0,
            errors
        });

    }

    verifyClock(clockHistory) {

        if (!Array.isArray(clockHistory)) {

            return createCheckResult({
                passed: false,
                errors: ["Clock history is missing"]
            });

        }

        const errors = [];

        let lastPhaseIndex = -1;

        for (const entry of clockHistory) {

            const phaseIndex = CLOCK_PHASE_SEQUENCE.indexOf(entry.phase);

            if (phaseIndex === -1) {

                errors.push(`Unknown clock phase (${entry.phase})`);

                continue;

            }

            if (phaseIndex < lastPhaseIndex) {

                errors.push(`Clock phase order is inconsistent (${entry.phase})`);

            }

            lastPhaseIndex = Math.max(lastPhaseIndex, phaseIndex);

        }

        return createCheckResult({
            passed: errors.length === 0,
            errors
        });

    }

    verifyPhysics(physics) {

        if (!physics) {

            return createCheckResult({
                passed: false,
                errors: ["Physics snapshot is missing"]
            });

        }

        const errors = [];

        const runtime = physics.runtime ?? physics;

        if (runtime.state !== PHYSICS_SIMULATION_STATE.STOPPED) {

            errors.push("Physics simulation is not complete");

        }

        if (!Number.isFinite(runtime.angle)) {

            errors.push("Physics final angle is invalid");

        }

        if (runtime.angularVelocity !== 0) {

            errors.push("Physics angular velocity must be zero when stopped");

        }

        const commandLog = physics.commandLog ?? [];

        if (!Array.isArray(commandLog)) {

            errors.push("Physics command log is missing");

        }

        return createCheckResult({
            passed: errors.length === 0,
            errors
        });

    }

    verifyWinner(winner, configuration, physics) {

        if (!winner) {

            return createCheckResult({
                passed: false,
                errors: ["Winner result is missing"]
            });

        }

        const errors = [];

        if (!Object.isFrozen(winner)) {

            errors.push("Winner result is not immutable");

        }

        const runtime = physics?.runtime ?? physics;

        if (!physics || !Number.isFinite(runtime?.angle)) {

            errors.push("Physics final angle is unavailable for winner verification");

            return createCheckResult({
                passed: false,
                errors
            });

        }

        if (winner.finalAngle !== runtime.angle) {

            errors.push("Winner final angle does not match physics snapshot");

        }

        try {

            const expectedSector = this._sectorResolver.resolve({
                configuration,
                finalWheelAngleRadians: runtime.angle,
                triangleAngleDegrees: configuration.triangle.startAngle
            });

            if (winner.winningSector.sectorId !== expectedSector.sectorId) {

                errors.push("Winner sector does not match physics resolution");

            }

            const expectedPlayer = this._playerResolver.resolve({
                configuration,
                winningSector: expectedSector
            });

            if (winner.winningPlayer.playerId !== expectedPlayer.playerId) {

                errors.push("Winner player does not match sector ownership");

            }

        } catch (error) {

            errors.push(error.message);

        }

        return createCheckResult({
            passed: errors.length === 0,
            errors
        });

    }

    verifyPayment(payment, winner, configuration) {

        if (!payment) {

            return createCheckResult({
                passed: false,
                errors: ["Payment result is missing"]
            });

        }

        const errors = [];

        if (!Object.isFrozen(payment)) {

            errors.push("Payment result is not immutable");

        }

        if (payment.paymentStatus !== PAYMENT_STATUS.COMPLETED) {

            errors.push("Payment is not completed");

        }

        if (!winner) {

            errors.push("Winner result is required for payment verification");

            return createCheckResult({
                passed: false,
                errors
            });

        }

        if (payment.winnerId !== winner.winningPlayer.playerId) {

            errors.push("Payment winner does not match game result");

        }

        try {

            const gameId = configuration?.gameId
                ?? winner?.gameId
                ?? payment?.gameId;

            const paymentRules = this._resolvePaymentRules(gameId);

            const expectedBreakdown = this._prizeCalculator.calculate({
                configuration,
                gameResult: winner,
                paymentRules
            });

            if (payment.totalPrize !== expectedBreakdown.totalPrize) {

                errors.push("Payment total prize does not match catalog rules");

            }

            if (payment.platformFee !== expectedBreakdown.platformFee) {

                errors.push("Payment platform fee does not match catalog rules");

            }

            if (payment.winnerAmount !== expectedBreakdown.winnerAmount) {

                errors.push("Payment winner amount does not match catalog rules");

            }

        } catch (error) {

            errors.push(error.message);

        }

        return createCheckResult({
            passed: errors.length === 0,
            errors
        });

    }

    verifyRecovery(recovery, sources) {

        if (!recovery) {

            return createCheckResult({
                passed: true,
                warnings: ["Recovery snapshot is not available"]
            });

        }

        const errors = [];

        if (!Object.isFrozen(recovery)) {

            errors.push("Recovery snapshot is not immutable");

        }

        if (recovery.gameId !== sources.configuration?.gameId) {

            errors.push("Recovery gameId does not match configuration");

        }

        if (recovery.metadata?.traceSeed !== sources.configuration?.traceSeed) {

            errors.push("Recovery traceSeed does not match configuration");

        }

        const physicsAngle = sources.physics?.runtime?.angle
            ?? sources.physics?.angle;

        if (recovery.physics?.angle !== physicsAngle) {

            errors.push("Recovery physics angle does not match authoritative physics");

        }

        if (sources.winner
            && recovery.winner?.winningPlayer?.playerId
                !== sources.winner.winningPlayer.playerId) {

            errors.push("Recovery winner does not match authoritative result");

        }

        if (sources.payment
            && recovery.payment?.winnerId !== sources.payment.winnerId) {

            errors.push("Recovery payment does not match authoritative payment");

        }

        return createCheckResult({
            passed: errors.length === 0,
            errors
        });

    }

    _resolvePaymentRules(gameId) {

        const resolved = resolveGameFinancialRules(gameId, {
            gameContractManager: this._gameContractManager,
            configurationEngine: this._configurationEngine,
            gameCatalog: this._gameCatalog
        });

        return resolved.paymentRules;

    }

}
