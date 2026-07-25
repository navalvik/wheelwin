/**
 * R7.0G — Startup probe coordinator.
 */

export class StartupManager {

    /**
     * @param {{ probe: import("./health/StartupProbe.js").StartupProbe }} options
     */
    constructor({ probe }) {

        this._probe = probe;

    }

    evaluate(signals) {

        return this._probe.evaluate(signals);

    }

    isComplete() {

        return this._probe.isComplete();

    }

    getCached() {

        return this._probe.getLastResult();

    }

}
