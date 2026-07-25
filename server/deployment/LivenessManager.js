/**
 * R7.0G — Liveness probe coordinator.
 */

export class LivenessManager {

    /**
     * @param {{ probe: import("./health/LivenessProbe.js").LivenessProbe }} options
     */
    constructor({ probe }) {

        this._probe = probe;

        this._lastOk = true;

    }

    evaluate(signals) {

        const result = this._probe.evaluate(signals);

        this._lastOk = result.ok === true;

        return result;

    }

    isLive() {

        return this._lastOk === true;

    }

    getCached() {

        return this._probe.getLastResult();

    }

}
