/**
 * R7.0F — Registry of domain policies + circuit breakers.
 */

export class FailureRegistry {

    constructor() {

        this._policies = new Map();

        this._circuits = new Map();

    }

    registerPolicy(name, policy) {

        this._policies.set(name, policy);

    }

    getPolicy(name) {

        return this._policies.get(name) ?? null;

    }

    registerCircuit(name, breaker) {

        this._circuits.set(name, breaker);

    }

    getCircuit(name) {

        return this._circuits.get(name) ?? null;

    }

    listCircuits() {

        return [...this._circuits.values()].map((breaker) => breaker.getStatus());

    }

    listPolicyNames() {

        return [...this._policies.keys()];

    }

}
