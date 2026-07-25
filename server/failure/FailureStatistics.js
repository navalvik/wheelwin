/**
 * R7.0F — In-memory failure statistics.
 */

export class FailureStatistics {

    constructor({ historyLimit = 100 } = {}) {

        this._historyLimit = historyLimit;

        this._total = 0;

        this._byComponent = new Map();

        this._retries = 0;

        this._retrySuccess = 0;

        this._retryFailure = 0;

        this._escalations = 0;

        this._circuitOpens = 0;

        this._circuitRecoveries = 0;

        this._fatal = 0;

        this._recoverable = 0;

        this._history = [];

        this._retryDelayTotal = 0;

    }

    recordFailure({ component, failureType, decision }) {

        this._total += 1;

        this._byComponent.set(
            component,
            (this._byComponent.get(component) ?? 0) + 1
        );

        if (failureType === "FATAL") {

            this._fatal += 1;

        }

        if (failureType === "RECOVERABLE"
            || failureType === "TRANSIENT"
            || failureType === "RATE_LIMITED") {

            this._recoverable += 1;

        }

        this._pushHistory({
            at: Date.now(),
            component,
            failureType,
            decision
        });

    }

    recordRetryScheduled(delayMs = 0) {

        this._retries += 1;

        this._retryDelayTotal += delayMs;

    }

    recordRetrySuccess() {

        this._retrySuccess += 1;

    }

    recordRetryFailure() {

        this._retryFailure += 1;

    }

    recordEscalation() {

        this._escalations += 1;

    }

    recordCircuitOpen() {

        this._circuitOpens += 1;

    }

    recordCircuitRecovery() {

        this._circuitRecoveries += 1;

    }

    snapshot() {

        const byComponent = {};

        for (const [key, value] of this._byComponent) {

            byComponent[key] = value;

        }

        return {
            totalFailures: this._total,
            byComponent,
            retryCount: this._retries,
            retrySuccess: this._retrySuccess,
            retryFailure: this._retryFailure,
            escalations: this._escalations,
            circuitOpens: this._circuitOpens,
            circuitRecoveries: this._circuitRecoveries,
            fatalFailures: this._fatal,
            recoverableFailures: this._recoverable,
            averageRetries: this._total > 0
                ? Number((this._retries / this._total).toFixed(3))
                : 0,
            recent: this._history.slice(-20)
        };

    }

    _pushHistory(entry) {

        this._history.push(entry);

        if (this._history.length > this._historyLimit) {

            this._history.splice(0, this._history.length - this._historyLimit);

        }

    }

}
