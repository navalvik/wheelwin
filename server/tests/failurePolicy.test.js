/**
 * R7.0F — Failure recovery policy subsystem tests.
 */

import assert from "node:assert/strict";

import {
    FailurePolicyManager,
    FAILURE_CATEGORY,
    FAILURE_DECISION,
    BACKOFF_STRATEGY,
    CIRCUIT_STATE
} from "../failure/FailurePolicyManager.js";
import { FailureClassifier } from "../failure/FailureClassifier.js";
import { FailureContext } from "../failure/FailureContext.js";
import { FailureDecisionEngine } from "../failure/FailureDecisionEngine.js";
import { RetryPolicy } from "../failure/RetryPolicy.js";
import { RetryScheduler } from "../failure/RetryScheduler.js";
import { BackoffStrategy } from "../failure/BackoffStrategy.js";
import { CircuitBreaker } from "../failure/CircuitBreaker.js";
import { FailureEscalation } from "../failure/FailureEscalation.js";
import { HealthService } from "../services/HealthService.js";
import { MonitoringManager } from "../monitoring/MonitoringManager.js";

function delay(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

function reset() {

    FailurePolicyManager.resetForTests();

    MonitoringManager.resetForTests();

}

function createManager(overrides = {}) {

    reset();

    return FailurePolicyManager.getInstance().initialize({
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 100,
        backoffStrategy: BACKOFF_STRATEGY.EXPONENTIAL,
        circuitBreakerEnabled: true,
        circuitFailureThreshold: 3,
        circuitRecoveryTimeoutMs: 50,
        circuitSuccessThreshold: 1,
        historyLimit: 50,
        ...overrides
    });

}

async function main() {

    // --- Classification ---

    {
        const classifier = new FailureClassifier();

        assert.equal(
            classifier.classify(new FailureContext({
                component: "blockchain",
                operation: "poll",
                error: new Error("temporary network timeout")
            })),
            FAILURE_CATEGORY.RECOVERABLE
        );

        assert.equal(
            classifier.classify(new FailureContext({
                component: "network",
                operation: "http",
                code: "429"
            })),
            FAILURE_CATEGORY.RATE_LIMITED
        );

        assert.equal(
            classifier.classify(new FailureContext({
                component: "configuration",
                operation: "load",
                code: "VALIDATION_ERROR"
            })),
            FAILURE_CATEGORY.NON_RECOVERABLE
        );

        assert.equal(
            classifier.classify(new FailureContext({
                component: "system",
                operation: "boot",
                code: "INVARIANT_VIOLATION"
            })),
            FAILURE_CATEGORY.FATAL
        );

        assert.equal(
            classifier.classify(new FailureContext({
                component: "gameplay",
                operation: "tick",
                code: "RECONNECT"
            })),
            FAILURE_CATEGORY.TRANSIENT
        );

        console.log("  classification: OK");
    }

    // --- Decision engine ---

    {
        const engine = new FailureDecisionEngine();

        const retryPolicy = new RetryPolicy({ maxAttempts: 3, allowRetry: true });

        const gameplay = engine.decide({
            context: new FailureContext({
                component: "gameplay",
                operation: "authority",
                attempt: 1
            }),
            category: FAILURE_CATEGORY.RECOVERABLE,
            retryPolicy,
            policyAllowRetry: false
        });

        assert.equal(gameplay.decision, FAILURE_DECISION.FAIL);

        const transient = engine.decide({
            context: new FailureContext({
                component: "network",
                operation: "reconnect",
                attempt: 1
            }),
            category: FAILURE_CATEGORY.TRANSIENT,
            retryPolicy,
            policyAllowRetry: true
        });

        assert.equal(transient.decision, FAILURE_DECISION.RETRY_NOW);

        console.log("  decision engine: OK");
    }

    // --- Backoff ---

    {
        const fixed = new BackoffStrategy({
            strategy: BACKOFF_STRATEGY.FIXED,
            initialDelayMs: 100,
            maxDelayMs: 1000
        });

        assert.equal(fixed.nextDelayMs(1), 100);

        assert.equal(fixed.nextDelayMs(5), 100);

        const linear = new BackoffStrategy({
            strategy: BACKOFF_STRATEGY.LINEAR,
            initialDelayMs: 50,
            maxDelayMs: 1000
        });

        assert.equal(linear.nextDelayMs(3), 150);

        const exp = new BackoffStrategy({
            strategy: BACKOFF_STRATEGY.EXPONENTIAL,
            initialDelayMs: 10,
            maxDelayMs: 1000
        });

        assert.equal(exp.nextDelayMs(1), 10);

        assert.equal(exp.nextDelayMs(3), 40);

        const jitter = new BackoffStrategy({
            strategy: BACKOFF_STRATEGY.EXPONENTIAL_JITTER,
            initialDelayMs: 100,
            maxDelayMs: 100
        });

        for (let i = 0; i < 20; i += 1) {

            const d = jitter.nextDelayMs(1);

            assert.ok(d >= 0 && d <= 100);

        }

        console.log("  backoff: OK");
    }

    // --- Circuit breaker ---

    {
        const breaker = new CircuitBreaker({
            name: "test",
            failureThreshold: 2,
            recoveryTimeoutMs: 30,
            successThreshold: 1
        });

        assert.equal(breaker.state, CIRCUIT_STATE.CLOSED);

        breaker.recordFailure();

        assert.equal(breaker.state, CIRCUIT_STATE.CLOSED);

        breaker.recordFailure();

        assert.equal(breaker.state, CIRCUIT_STATE.OPEN);

        assert.equal(breaker.allowRequest(), false);

        await delay(35);

        assert.equal(breaker.state, CIRCUIT_STATE.HALF_OPEN);

        assert.equal(breaker.allowRequest(), true);

        breaker.recordSuccess();

        assert.equal(breaker.state, CIRCUIT_STATE.CLOSED);

        console.log("  circuit breaker: OK");
    }

    // --- Retry scheduler + cancellation ---

    {
        const scheduler = new RetryScheduler();

        let ran = false;

        const jobId = scheduler.schedule({
            delayMs: 200,
            context: { component: "network", operation: "x" },
            execute: () => {

                ran = true;

            }
        });

        assert.equal(scheduler.queueSize, 1);

        assert.equal(scheduler.cancel(jobId), true);

        assert.equal(scheduler.queueSize, 0);

        await delay(250);

        assert.equal(ran, false);

        let completed = false;

        scheduler.schedule({
            delayMs: 15,
            context: { component: "network", operation: "y" },
            execute: () => {

                completed = true;

            }
        });

        await delay(80);

        assert.equal(completed, true);

        console.log("  retry scheduler: OK");
    }

    // --- Escalation ---

    {
        const escalation = new FailureEscalation({ consecutiveFailureLimit: 2 });

        const first = escalation.evaluate(
            "blockchain:poll",
            FAILURE_CATEGORY.RECOVERABLE
        );

        assert.equal(first.escalate, false);

        const second = escalation.evaluate(
            "blockchain:poll",
            FAILURE_CATEGORY.RECOVERABLE
        );

        assert.equal(second.escalate, true);

        assert.equal(second.decision, FAILURE_DECISION.ESCALATE);

        const fatal = escalation.evaluate("system:boot", FAILURE_CATEGORY.FATAL);

        assert.equal(fatal.decision, FAILURE_DECISION.SHUTDOWN);

        console.log("  escalation: OK");
    }

    // --- Manager integration ---

    {
        const manager = createManager();

        const blockchain = manager.decide({
            component: "blockchain",
            operation: "getTransactions",
            error: new Error("temporary delay"),
            attempt: 1
        });

        assert.equal(blockchain.category, FAILURE_CATEGORY.RECOVERABLE);

        assert.equal(blockchain.decision, FAILURE_DECISION.RETRY_LATER);

        assert.ok(blockchain.delayMs >= 0);

        const gameplay = manager.decide({
            component: "gameplay",
            operation: "tick",
            error: new Error("physics glitch"),
            attempt: 1
        });

        assert.equal(gameplay.decision, FAILURE_DECISION.FAIL);

        let executed = false;

        const jobId = manager.scheduleRetry({
            decision: blockchain,
            execute: () => {

                executed = true;

                manager.reportSuccess({
                    component: "blockchain",
                    operation: "getTransactions"
                });

            }
        });

        assert.ok(jobId);

        await delay((blockchain.delayMs ?? 0) + 80);

        assert.equal(executed, true);

        const status = manager.getSafeStatus();

        assert.equal(status.enabled, true);

        assert.ok(status.retryCount >= 1);

        assert.ok(Array.isArray(status.circuitBreakers));

        assert.ok(!JSON.stringify(status).includes("stack"));

        console.log("  manager decide/retry: OK");
    }

    // --- Health integration ---

    {
        const manager = createManager();

        manager.decide({
            component: "network",
            operation: "http",
            code: "429",
            attempt: 1
        });

        const health = new HealthService({
            logger: { error() {} },
            productionConfig: { nodeEnv: "test" }
        });

        health.setFailurePolicyStatus(manager.getSafeStatus());

        const snapshot = health.getHealthSnapshot();

        assert.ok(snapshot.failurePolicy);

        assert.equal(snapshot.failurePolicy.enabled, true);

        assert.ok(snapshot.failurePolicy.retryQueueSize >= 0);

        console.log("  health integration: OK");
    }

    // --- Monitoring integration ---

    {
        const manager = createManager();

        manager.decide({
            component: "blockchain",
            operation: "poll",
            error: new Error("timeout"),
            attempt: 1
        });

        MonitoringManager.resetForTests();

        const monitoring = MonitoringManager.getInstance();

        monitoring.initialize({
            enabled: true,
            intervals: { systemMs: 20 },
            providers: {
                failurePolicy: manager,
                lifecycleState: () => "RUNNING",
                environment: () => "test",
                profile: () => "test",
                version: () => "0.0.0-test"
            }
        });

        await delay(60);

        const snap = monitoring.getSnapshot();

        assert.ok(snap.failure);

        assert.equal(snap.failure.policyEnabled, true);

        monitoring.shutdown();

        console.log("  monitoring integration: OK");
    }

    // --- Load / non-blocking ---

    {
        const manager = createManager({
            circuitFailureThreshold: 100,
            maxAttempts: 10
        });

        const start = Date.now();

        for (let i = 0; i < 500; i += 1) {

            manager.decide({
                component: "network",
                operation: `op_${i % 7}`,
                error: new Error("temporary network"),
                attempt: 1
            });

        }

        const elapsed = Date.now() - start;

        assert.ok(elapsed < 500, `decide loop too slow: ${elapsed}ms`);

        console.log("  performance under load: OK");
    }

    reset();

    console.log("failurePolicy.test.js: all passed");

}

main().catch((error) => {

    console.error(error);

    process.exit(1);

});
