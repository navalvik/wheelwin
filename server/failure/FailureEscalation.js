/**
 * R7.0F — Escalation rules for persistent failures.
 */

import { FAILURE_DECISION, FAILURE_CATEGORY } from "./failureTypes.js";

export class FailureEscalation {

    constructor({ consecutiveFailureLimit = 5 } = {}) {

        this._consecutiveFailureLimit = consecutiveFailureLimit;

        this._streaks = new Map();

        this._escalationCount = 0;

    }

    /**
     * @param {string} key component:operation
     * @param {string} category
     * @returns {{ escalate: boolean, decision: string|null, reason: string|null }}
     */
    evaluate(key, category) {

        if (category === FAILURE_CATEGORY.FATAL) {

            this._escalationCount += 1;

            return {
                escalate: true,
                decision: FAILURE_DECISION.SHUTDOWN,
                reason: "fatal_escalation"
            };

        }

        const streak = (this._streaks.get(key) ?? 0) + 1;

        this._streaks.set(key, streak);

        if (streak >= this._consecutiveFailureLimit) {

            this._escalationCount += 1;

            return {
                escalate: true,
                decision: FAILURE_DECISION.ESCALATE,
                reason: "consecutive_failure_limit"
            };

        }

        return { escalate: false, decision: null, reason: null };

    }

    reset(key) {

        this._streaks.delete(key);

    }

    get escalationCount() {

        return this._escalationCount;

    }

}
