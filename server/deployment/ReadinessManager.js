/**
 * R7.0G — Readiness probe coordinator.
 */

export class ReadinessManager {

    /**
     * @param {{ probe: import("./health/ReadinessProbe.js").ReadinessProbe }} options
     */
    constructor({ probe }) {

        this._probe = probe;

        this._lastOk = false;

        this._previousOk = null;

    }

    evaluate(signals) {

        const result = this._probe.evaluate(signals);

        this._previousOk = this._lastOk;

        this._lastOk = result.ok === true;

        return result;

    }

    isReady() {

        return this._lastOk === true;

    }

    didTransition() {

        return this._previousOk != null && this._previousOk !== this._lastOk;

    }

    getCached() {

        return this._probe.getLastResult();

    }

}
