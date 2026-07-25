/**
 * R7.0F — Central failure policy coordinator.
 *
 * Subsystems call decide() / scheduleRetry() / reportSuccess().
 * Never mutates gameplay authority or RecoveryEngine.
 */

import { LoggingManager } from "../logging/LoggingManager.js";
import { LOG_LEVELS } from "../logging/levels.js";
import { FailureContext } from "./FailureContext.js";
import { FailureClassifier } from "./FailureClassifier.js";
import { FailureDecisionEngine } from "./FailureDecisionEngine.js";
import { RetryPolicy } from "./RetryPolicy.js";
import { RetryScheduler } from "./RetryScheduler.js";
import { BackoffStrategy } from "./BackoffStrategy.js";
import { CircuitBreaker } from "./CircuitBreaker.js";
import { FailureStatistics } from "./FailureStatistics.js";
import { FailureEscalation } from "./FailureEscalation.js";
import { FailureRegistry } from "./FailureRegistry.js";
import {
    BACKOFF_STRATEGY,
    FAILURE_COMPONENT,
    FAILURE_DECISION,
    FAILURE_CATEGORY
} from "./failureTypes.js";
import { GameplayPolicy } from "./policies/GameplayPolicy.js";
import { PaymentPolicy } from "./policies/PaymentPolicy.js";
import { BlockchainPolicy } from "./policies/BlockchainPolicy.js";
import { NetworkPolicy } from "./policies/NetworkPolicy.js";
import { StoragePolicy } from "./policies/StoragePolicy.js";

export class FailurePolicyManager {

    static _instance = null;

    constructor() {

        this._enabled = false;

        this._config = null;

        this._classifier = new FailureClassifier();

        this._decisionEngine = new FailureDecisionEngine();

        this._scheduler = new RetryScheduler();

        this._registry = new FailureRegistry();

        this._statistics = null;

        this._escalation = null;

        this._defaultBackoff = null;

        this._shutdownHandler = null;

    }

    static getInstance() {

        if (!FailurePolicyManager._instance) {

            FailurePolicyManager._instance = new FailurePolicyManager();

        }

        return FailurePolicyManager._instance;

    }

    static resetForTests() {

        if (FailurePolicyManager._instance) {

            FailurePolicyManager._instance.shutdown();

        }

        FailurePolicyManager._instance = null;

    }

    /**
     * @param {{
     *   enabled?: boolean,
     *   maxAttempts?: number,
     *   initialDelayMs?: number,
     *   maxDelayMs?: number,
     *   backoffStrategy?: string,
     *   circuitBreakerEnabled?: boolean,
     *   circuitFailureThreshold?: number,
     *   circuitRecoveryTimeoutMs?: number,
     *   circuitSuccessThreshold?: number,
     *   historyLimit?: number,
     *   onShutdownRequest?: (context) => void
     * }} config
     */
    initialize(config = {}) {

        this.shutdown();

        this._enabled = config.enabled !== false;

        this._config = {
            maxAttempts: config.maxAttempts ?? 3,
            initialDelayMs: config.initialDelayMs ?? 200,
            maxDelayMs: config.maxDelayMs ?? 30_000,
            backoffStrategy: config.backoffStrategy
                ?? BACKOFF_STRATEGY.EXPONENTIAL_JITTER,
            circuitBreakerEnabled: config.circuitBreakerEnabled !== false,
            circuitFailureThreshold: config.circuitFailureThreshold ?? 5,
            circuitRecoveryTimeoutMs: config.circuitRecoveryTimeoutMs ?? 30_000,
            circuitSuccessThreshold: config.circuitSuccessThreshold ?? 2,
            historyLimit: config.historyLimit ?? 100
        };

        this._statistics = new FailureStatistics({
            historyLimit: this._config.historyLimit
        });

        this._escalation = new FailureEscalation({
            consecutiveFailureLimit: this._config.maxAttempts + 2
        });

        this._defaultBackoff = new BackoffStrategy({
            strategy: this._config.backoffStrategy,
            initialDelayMs: this._config.initialDelayMs,
            maxDelayMs: this._config.maxDelayMs
        });

        this._shutdownHandler = typeof config.onShutdownRequest === "function"
            ? config.onShutdownRequest
            : null;

        this._registry = new FailureRegistry();

        for (const policy of [
            GameplayPolicy,
            PaymentPolicy,
            BlockchainPolicy,
            NetworkPolicy,
            StoragePolicy
        ]) {

            this._registry.registerPolicy(policy.name, policy);

        }

        if (this._config.circuitBreakerEnabled) {

            for (const name of ["blockchain", "network", "storage"]) {

                this._registry.registerCircuit(name, new CircuitBreaker({
                    name,
                    failureThreshold: this._config.circuitFailureThreshold,
                    recoveryTimeoutMs: this._config.circuitRecoveryTimeoutMs,
                    successThreshold: this._config.circuitSuccessThreshold
                }));

            }

        }

        this._scheduler = new RetryScheduler();

        return this;

    }

    isEnabled() {

        return this._enabled === true;

    }

    /**
     * Primary API — classify + decide.
     *
     * @param {{
     *   component: string,
     *   operation: string,
     *   error?: Error,
     *   code?: string,
     *   attempt?: number,
     *   fields?: object
     * }} input
     */
    decide(input) {

        if (!this._enabled) {

            return {
                decision: FAILURE_DECISION.FAIL,
                reason: "failure_policy_disabled",
                delayMs: 0,
                context: null,
                category: null
            };

        }

        const domain = this._registry.getPolicy(input.component)
            ?? this._registry.getPolicy(FAILURE_COMPONENT.SYSTEM);

        const maxAttempts = domain?.maxAttempts
            ?? this._config.maxAttempts;

        const context = new FailureContext({
            ...input,
            maxAttempts,
            attempt: input.attempt ?? 1
        });

        const category = this._classifier.classify(context);

        context.failureType = category;

        const circuitName = domain?.circuitName ?? null;

        const circuit = circuitName
            ? this._registry.getCircuit(circuitName)
            : null;

        const circuitOpen = circuit ? !circuit.allowRequest() : false;

        const retryPolicy = new RetryPolicy({
            maxAttempts,
            initialDelayMs: this._config.initialDelayMs,
            maxDelayMs: this._config.maxDelayMs,
            allowRetry: domain?.allowRetry !== false
        });

        let result = this._decisionEngine.decide({
            context,
            category,
            retryPolicy,
            circuitOpen,
            policyAllowRetry: domain?.allowRetry !== false
        });

        const streakKey = `${context.component}:${context.operation}`;

        if (result.decision === FAILURE_DECISION.FAIL
            || result.decision === FAILURE_DECISION.ESCALATE
            || result.decision === FAILURE_DECISION.SHUTDOWN) {

            const escalation = this._escalation.evaluate(streakKey, category);

            if (escalation.escalate && escalation.decision) {

                result = {
                    decision: escalation.decision,
                    reason: escalation.reason,
                    delayMs: 0
                };

                this._statistics.recordEscalation();

            }

        }

        if (result.decision === FAILURE_DECISION.RETRY_LATER
            && result.delayMs == null) {

            const strategyName = domain?.backoffStrategy
                ?? this._config.backoffStrategy;

            const backoff = new BackoffStrategy({
                strategy: strategyName,
                initialDelayMs: this._config.initialDelayMs,
                maxDelayMs: this._config.maxDelayMs
            });

            result.delayMs = backoff.nextDelayMs(context.attempt);

        }

        if (result.decision === FAILURE_DECISION.RETRY_NOW) {

            result.delayMs = 0;

        }

        context.decision = result.decision;

        context.reason = result.reason;

        context.delayMs = result.delayMs;

        this._statistics.recordFailure({
            component: context.component,
            failureType: category,
            decision: result.decision
        });

        if (circuit && category !== FAILURE_CATEGORY.FATAL) {

            const before = circuit.state;

            circuit.recordFailure();

            if (circuit.state === "OPEN" && before !== "OPEN") {

                this._statistics.recordCircuitOpen();

                this._log("warn", "Circuit opened", {
                    circuit: circuit.name,
                    ...context.toLogFields()
                });

            }

        }

        this._logDecision(context);

        if (result.decision === FAILURE_DECISION.SHUTDOWN) {

            this._log("fatal", "Fatal shutdown requested", context.toLogFields());

            this._audit("fatal shutdown", context.toLogFields());

            try {

                this._shutdownHandler?.(context);

            } catch {

                // ignore
            }

        } else if (result.decision === FAILURE_DECISION.ESCALATE) {

            this._audit("failure escalation", context.toLogFields());

        }

        return {
            ...result,
            context,
            category,
            retryPolicy: retryPolicy.snapshot()
        };

    }

    /**
     * Schedule a retry using RetryScheduler (never setTimeout in callers).
     *
     * @param {{
     *   decision: object,
     *   execute: () => (void|Promise<void>),
     *   onCancel?: () => void
     * }} input
     */
    scheduleRetry({ decision, execute, onCancel = null }) {

        if (!this._enabled) {

            return null;

        }

        if (decision.decision !== FAILURE_DECISION.RETRY_NOW
            && decision.decision !== FAILURE_DECISION.RETRY_LATER) {

            return null;

        }

        const delayMs = decision.delayMs ?? 0;

        this._statistics.recordRetryScheduled(delayMs);

        this._log("info", "Retry scheduled", {
            ...decision.context?.toLogFields?.() ?? {},
            delayMs
        });

        return this._scheduler.schedule({
            delayMs,
            context: decision.context,
            execute: async () => {

                try {

                    await execute();

                    this._statistics.recordRetrySuccess();

                    this._log("info", "Retry completed", decision.context?.toLogFields?.() ?? {});

                } catch (error) {

                    this._statistics.recordRetryFailure();

                    this._log("warn", "Retry abandoned", {
                        ...decision.context?.toLogFields?.() ?? {},
                        error: error?.message
                    });

                }

            },
            onCancel: () => {

                this._log("info", "Retry cancelled", decision.context?.toLogFields?.() ?? {});

                onCancel?.();

            }
        });

    }

    /**
     * Report successful recovery of an external dependency call.
     */
    reportSuccess({ component, operation, circuitName = null } = {}) {

        if (!this._enabled) {

            return;

        }

        const domain = this._registry.getPolicy(component);

        const name = circuitName ?? domain?.circuitName;

        const circuit = name ? this._registry.getCircuit(name) : null;

        if (circuit) {

            const before = circuit.state;

            circuit.recordSuccess();

            if (before !== "CLOSED" && circuit.state === "CLOSED") {

                this._statistics.recordCircuitRecovery();

                this._log("info", "Circuit closed", { circuit: name, component, operation });

            }

        }

        this._escalation.reset(`${component}:${operation}`);

    }

    cancelRetry(jobId) {

        return this._scheduler.cancel(jobId);

    }

    getStatistics() {

        return this._statistics?.snapshot() ?? {
            totalFailures: 0,
            byComponent: {},
            retryCount: 0,
            retrySuccess: 0,
            retryFailure: 0,
            escalations: 0,
            circuitOpens: 0,
            circuitRecoveries: 0,
            fatalFailures: 0,
            recoverableFailures: 0,
            averageRetries: 0,
            recent: []
        };

    }

    /**
     * Safe status for health / console (no stacks / secrets).
     */
    getSafeStatus() {

        const stats = this.getStatistics();

        return Object.freeze({
            enabled: this._enabled,
            retryQueueSize: this._scheduler.queueSize,
            escalationCount: stats.escalations,
            recoverableFailures: stats.recoverableFailures,
            fatalFailures: stats.fatalFailures,
            retryCount: stats.retryCount,
            retrySuccess: stats.retrySuccess,
            retryFailure: stats.retryFailure,
            circuitBreakers: Object.freeze(
                this._registry.listCircuits().map((c) => Object.freeze({ ...c }))
            ),
            pendingRetries: Object.freeze(this._scheduler.listPending()),
            recentRecoverable: Object.freeze(
                stats.recent
                    .filter((e) => e.failureType !== "FATAL"
                        && e.failureType !== "NON_RECOVERABLE")
                    .slice(-10)
            )
        });

    }

    shutdown() {

        this._scheduler?.cancelAll?.();

        this._enabled = false;

    }

    _logDecision(context) {

        const level = context.decision === FAILURE_DECISION.SHUTDOWN
            ? "fatal"
            : context.decision === FAILURE_DECISION.ESCALATE
                || context.decision === FAILURE_DECISION.FAIL
                ? "warn"
                : "info";

        this._log(level, `Failure decision ${context.decision}`, context.toLogFields());

    }

    _log(level, message, fields) {

        const manager = LoggingManager.getInstance();

        if (!manager.isInitialized()) {

            return;

        }

        const mapped = level === "fatal"
            ? LOG_LEVELS.FATAL
            : level === "warn"
                ? LOG_LEVELS.WARN
                : LOG_LEVELS.INFO;

        manager.write({
            level: mapped,
            service: "wheelwin-failure-policy",
            message,
            fields
        });

    }

    _audit(message, fields) {

        const manager = LoggingManager.getInstance();

        if (manager.isInitialized()) {

            manager.audit(message, {
                component: "FailurePolicy",
                ...fields
            });

        }

    }

}

export {
    FAILURE_CATEGORY,
    FAILURE_DECISION,
    FAILURE_COMPONENT,
    BACKOFF_STRATEGY,
    CIRCUIT_STATE
} from "./failureTypes.js";
