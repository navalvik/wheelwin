import { EVENT_SOURCES } from "../events/EventSources.js";
import { EVENT_TYPES } from "../events/EventTypes.js";
import { AuditVerifier } from "./audit/AuditVerifier.js";
import { deepFreezeAudit } from "./audit/auditFreeze.js";
import { AuditValidationError } from "./audit/AuditValidationError.js";

export class AuditEngine {

    constructor({
        logger,
        eventBus,
        gameCatalog,
        configurationEngine,
        gameStateEngine,
        gameClock,
        physicsEngine,
        inputAuthority,
        winnerEngine,
        paymentEngine,
        recoveryEngine,
        metricsService = null
    }) {

        this._logger = logger;

        this._eventBus = eventBus;

        this._gameCatalog = gameCatalog;

        this._configurationEngine = configurationEngine;

        this._gameStateEngine = gameStateEngine;

        this._gameClock = gameClock;

        this._physicsEngine = physicsEngine;

        this._inputAuthority = inputAuthority;

        this._winnerEngine = winnerEngine;

        this._paymentEngine = paymentEngine;

        this._recoveryEngine = recoveryEngine;

        this._metricsService = metricsService;

        this._verifier = new AuditVerifier({ gameCatalog });

        this._reports = new Map();

        this._infrastructureHandlers = [];

        this._initialized = false;

    }

    initialize() {

        const shutdownHandler = () => {

            this._handleServerShutdown();

        };

        this._eventBus.subscribe(
            EVENT_TYPES.SERVER_SHUTDOWN,
            shutdownHandler
        );

        this._infrastructureHandlers.push({
            event: EVENT_TYPES.SERVER_SHUTDOWN,
            handler: shutdownHandler
        });

        this._initialized = true;

    }

    shutdown() {

        for (const gameId of [...this._reports.keys()]) {

            this.removeAuditReport(gameId);

        }

        for (const subscription of this._infrastructureHandlers) {

            this._eventBus.unsubscribe(
                subscription.event,
                subscription.handler
            );

        }

        this._infrastructureHandlers = [];

        this._initialized = false;

    }

    buildAuditReport(gameId) {

        this._assertInitialized();

        const traceSeed = this._configurationEngine.getConfiguration(gameId)?.traceSeed
            ?? null;

        this._emit(EVENT_TYPES.AUDIT_STARTED, {
            gameId,
            traceSeed,
            timestamp: Date.now()
        });

        try {

            const build = () => {

                const sources = this._collectAuditSources(gameId);

                this._validateAuditSources(gameId, sources);

                const verification = this._createVerificationResult(sources);

                const report = deepFreezeAudit({
                    gameId,
                    configuration: sources.configuration,
                    gameStateHistory: sources.gameStateHistory,
                    clockHistory: sources.clockHistory,
                    physics: sources.physics,
                    inputHistory: sources.inputHistory,
                    winner: sources.winner,
                    payment: sources.payment,
                    recovery: sources.recovery,
                    verification,
                    createdAt: Date.now(),
                    metadata: {
                        traceSeed: sources.configuration.traceSeed,
                        configurationVersion: sources.configuration.configurationVersion,
                        catalogVersion: this._gameCatalog.getCatalogVersion(),
                        economy: this._gameCatalog.getPaymentRules(),
                        wheelRules: this._gameCatalog.getWheelRules(),
                        timers: this._gameCatalog.getTimers()
                    }
                });

                this._reports.set(gameId, report);

                this._emit(EVENT_TYPES.AUDIT_REPORT_CREATED, {
                    gameId,
                    traceSeed: report.metadata.traceSeed,
                    passed: verification.passed,
                    timestamp: report.createdAt
                });

                this._emitAuditCompletion(gameId, traceSeed, verification.passed);

                return report;

            };

            const report = this._metricsService?.isEnabled()
                ? this._metricsService.time("audit.build", build)
                : build();

            return report;

        } catch (error) {

            this._handleAuditFailure(gameId, traceSeed, error);

            throw error;

        }

    }

    verifyGame(gameId) {

        this._assertInitialized();

        const traceSeed = this._configurationEngine.getConfiguration(gameId)?.traceSeed
            ?? null;

        this._emit(EVENT_TYPES.AUDIT_STARTED, {
            gameId,
            traceSeed,
            timestamp: Date.now()
        });

        try {

            const verify = () => {

                const sources = this._collectAuditSources(gameId);

                this._validateAuditSources(gameId, sources);

                const verification = this._createVerificationResult(sources);

                this._emitAuditCompletion(gameId, traceSeed, verification.passed);

                return verification;

            };

            return this._metricsService?.isEnabled()
                ? this._metricsService.time("audit.verify", verify)
                : verify();

        } catch (error) {

            this._handleAuditFailure(gameId, traceSeed, error);

            throw error;

        }

    }

    // C4.5 — read-only operational accessor (no behavior change).
    getActiveAuditCount() {

        return this._reports.size;

    }

    getAuditReport(gameId) {

        return this._reports.get(gameId) ?? null;

    }

    removeAuditReport(gameId) {

        if (!this._reports.has(gameId)) {

            this._logger.error(
                `Audit removal failed: report not found (${gameId})`
            );

            return false;

        }

        this._reports.delete(gameId);

        this._emit(EVENT_TYPES.AUDIT_REPORT_REMOVED, {
            gameId,
            timestamp: Date.now()
        });

        return true;

    }

    verifyAll() {

        this._assertInitialized();

        const gameIds = new Set([
            ...this._reports.keys(),
            ...this._configurationEngine.listConfigurationIds().filter(
                (gameId) => this._winnerEngine.getResult(gameId) !== null
            )
        ]);

        const results = {};

        for (const gameId of gameIds) {

            try {

                results[gameId] = this.verifyGame(gameId);

            } catch (error) {

                const reason = error instanceof AuditValidationError
                    ? error.reason
                    : error.message;

                results[gameId] = deepFreezeAudit({
                    passed: false,
                    checks: {},
                    errors: [reason],
                    warnings: []
                });

            }

        }

        return deepFreezeAudit(results);

    }

    getDebugSnapshot(gameId) {

        const sources = this._collectAuditSources(gameId);

        let verification = null;

        let report = this.getAuditReport(gameId);

        try {

            this._validateAuditSources(gameId, sources);

            verification = this._createVerificationResult(sources);

            if (!report) {

                report = {
                    gameId,
                    configuration: sources.configuration,
                    gameStateHistory: sources.gameStateHistory,
                    clockHistory: sources.clockHistory,
                    physics: sources.physics,
                    inputHistory: sources.inputHistory,
                    winner: sources.winner,
                    payment: sources.payment,
                    recovery: sources.recovery,
                    verification,
                    createdAt: null,
                    metadata: {
                        traceSeed: sources.configuration?.traceSeed ?? null,
                        configurationVersion: sources.configuration
                            ?.configurationVersion ?? null,
                        catalogVersion: this._gameCatalog.getCatalogVersion()
                    }
                };

            }

        } catch (error) {

            verification = deepFreezeAudit({
                passed: false,
                checks: {},
                errors: [
                    error instanceof AuditValidationError
                        ? error.reason
                        : error.message
                ],
                warnings: []
            });

        }

        return {
            gameId,
            configurationVerification: verification?.checks?.configuration ?? null,
            gameStateVerification: verification?.checks?.gameState ?? null,
            physicsVerification: verification?.checks?.physics ?? null,
            winnerVerification: verification?.checks?.winner ?? null,
            paymentVerification: verification?.checks?.payment ?? null,
            recoveryVerification: verification?.checks?.recovery ?? null,
            overallAuditResult: verification,
            auditReport: report
        };

    }

    _collectAuditSources(gameId) {

        const configuration = this._configurationEngine.getConfiguration(gameId);

        const gameStateHistory = this._gameStateEngine.getHistory(gameId);

        const clockDebug = this._gameClock.getDebugSnapshot(gameId);

        const physics = this._physicsEngine.getSimulation(gameId);

        return {
            configuration,
            gameStateHistory,
            clockHistory: clockDebug?.history ?? null,
            physics,
            inputHistory: this._buildInputHistory(gameId, configuration),
            winner: this._winnerEngine.getResult(gameId),
            payment: this._paymentEngine.getPayment(gameId),
            recovery: this._recoveryEngine.getRecoverySnapshot(gameId)
        };

    }

    _buildInputHistory(gameId, configuration) {

        if (!configuration || !this._inputAuthority.hasGame(gameId)) {

            return null;

        }

        const inputRules = this._gameCatalog.getInputRules();

        const commandHistory = this._inputAuthority.getAcceptedCommands(gameId);

        const players = configuration.players.map((player) => {

            const state = this._inputAuthority.getPlayerInputState(
                gameId,
                player.playerId
            );

            if (!state) {

                return null;

            }

            return {
                ...state,
                remainingPresses: Math.max(
                    0,
                    inputRules.maxPressCycles - state.pressCount
                )
            };

        });

        if (players.some((player) => player === null)) {

            return null;

        }

        return {
            commandHistory,
            players
        };

    }

    _validateAuditSources(gameId, sources) {

        if (!sources.configuration) {

            throw new AuditValidationError({
                gameId,
                reason: "Configuration is missing"
            });

        }

        if (!sources.gameStateHistory) {

            throw new AuditValidationError({
                gameId,
                reason: "Game state history is missing"
            });

        }

        if (!Array.isArray(sources.clockHistory) || sources.clockHistory.length === 0) {

            throw new AuditValidationError({
                gameId,
                reason: "Clock history is missing"
            });

        }

        if (!sources.physics) {

            throw new AuditValidationError({
                gameId,
                reason: "Physics snapshot is missing"
            });

        }

        if (!sources.inputHistory) {

            throw new AuditValidationError({
                gameId,
                reason: "Input history is missing"
            });

        }

        if (!sources.winner) {

            throw new AuditValidationError({
                gameId,
                reason: "Winner result is missing"
            });

        }

        if (!sources.payment) {

            throw new AuditValidationError({
                gameId,
                reason: "Payment result is missing"
            });

        }

    }

    _createVerificationResult(sources) {

        return deepFreezeAudit(this._verifier.verify(sources));

    }

    _emitAuditCompletion(gameId, traceSeed, passed) {

        this._emit(
            passed ? EVENT_TYPES.AUDIT_COMPLETED : EVENT_TYPES.AUDIT_FAILED,
            {
                gameId,
                traceSeed,
                passed,
                timestamp: Date.now()
            }
        );

    }

    _handleAuditFailure(gameId, traceSeed, error) {

        const reason = error instanceof AuditValidationError
            ? error.reason
            : error.message;

        this._emit(EVENT_TYPES.AUDIT_FAILED, {
            gameId,
            traceSeed,
            passed: false,
            reason,
            timestamp: Date.now()
        });

    }

    _emit(type, payload) {

        this._eventBus.emit({
            source: EVENT_SOURCES.AUDIT_ENGINE,
            type,
            payload
        });

    }

    _handleServerShutdown() {

        this._reports.clear();

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("AuditEngine is not initialized");

        }

    }

}
