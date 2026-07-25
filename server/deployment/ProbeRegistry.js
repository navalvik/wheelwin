/**
 * R7.0G — Registry of health probes.
 */

export class ProbeRegistry {

    constructor() {

        this._probes = new Map();

    }

    register(name, probe) {

        this._probes.set(name, probe);

        return this;

    }

    get(name) {

        return this._probes.get(name) ?? null;

    }

    list() {

        return [...this._probes.keys()];

    }

    /**
     * @param {object} signals
     * @returns {Map<string, object>}
     */
    evaluateAll(signals) {

        const results = new Map();

        for (const [name, probe] of this._probes) {

            results.set(name, probe.evaluate(signals));

        }

        return results;

    }

}
