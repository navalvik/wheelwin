/**
 * R7.0H — Assertion helpers for validation scenarios.
 */

export class ValidationAssertions {

    constructor() {

        this.failures = [];

        this.warnings = [];

        this.passed = 0;

    }

    ok(condition, message) {

        if (condition) {

            this.passed += 1;

            return true;

        }

        this.failures.push(String(message));

        return false;

    }

    equal(actual, expected, message) {

        return this.ok(
            Object.is(actual, expected),
            message ?? `Expected ${expected}, got ${actual}`
        );

    }

    approx(actual, expected, tolerance, message) {

        return this.ok(
            Number.isFinite(actual)
                && Math.abs(actual - expected) <= tolerance,
            message ?? `Expected ~${expected} (±${tolerance}), got ${actual}`
        );

    }

    lessThan(actual, max, message) {

        return this.ok(
            Number.isFinite(actual) && actual < max,
            message ?? `Expected < ${max}, got ${actual}`
        );

    }

    lessOrEqual(actual, max, message) {

        return this.ok(
            Number.isFinite(actual) && actual <= max,
            message ?? `Expected <= ${max}, got ${actual}`
        );

    }

    greaterThan(actual, min, message) {

        return this.ok(
            Number.isFinite(actual) && actual > min,
            message ?? `Expected > ${min}, got ${actual}`
        );

    }

    includes(haystack, needle, message) {

        const text = String(haystack ?? "");

        return this.ok(
            text.includes(needle),
            message ?? `Expected to include "${needle}"`
        );

    }

    notIncludes(haystack, needles, message) {

        const text = String(haystack ?? "");

        const list = Array.isArray(needles) ? needles : [needles];

        for (const needle of list) {

            if (text.toLowerCase().includes(String(needle).toLowerCase())) {

                this.failures.push(
                    message ?? `Sensitive token leaked: "${needle}"`
                );

                return false;

            }

        }

        this.passed += 1;

        return true;

    }

    warn(message) {

        this.warnings.push(String(message));

    }

    get passedCount() {

        return this.passed;

    }

    get failed() {

        return this.failures.length > 0;

    }

    snapshot() {

        return {
            passed: this.passed,
            failures: [...this.failures],
            warnings: [...this.warnings]
        };

    }

}
