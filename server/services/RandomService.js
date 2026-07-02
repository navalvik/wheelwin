import { randomFillSync, randomInt, randomUUID } from "node:crypto";

const MODES = Object.freeze({
    PRODUCTION: "Production",
    DETERMINISTIC: "Deterministic"
});

const GENERATOR_TYPES = Object.freeze({
    CRYPTO: "crypto",
    SEEDED: "seeded"
});

function normalizeSeed(seed) {

    if (typeof seed === "number") {

        if (!Number.isFinite(seed)) {

            throw new Error("Invalid seed: must be a finite number");

        }

        return seed >>> 0;

    }

    if (typeof seed === "string") {

        if (seed.length === 0) {

            throw new Error("Invalid seed: string seed cannot be empty");

        }

        let hash = 2166136261;

        for (let index = 0; index < seed.length; index += 1) {

            hash ^= seed.charCodeAt(index);

            hash = Math.imul(hash, 16777619);

        }

        return hash >>> 0;

    }

    throw new Error("Invalid seed: must be a number or string");

}

function createSeededGenerator(seed) {

    let state = normalizeSeed(seed);

    return {

        nextFloat() {

            state |= 0;

            state = (state + 0x6d2b79f5) | 0;

            let value = Math.imul(state ^ (state >>> 15), 1 | state);

            value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;

            return ((value ^ (value >>> 14)) >>> 0) / 4294967296;

        }

    };

}

export class RandomService {

    constructor({ logger }) {

        this._logger = logger;

        this._seed = null;

        this._seededGenerator = null;

        this._randomBuffer = Buffer.alloc(4);

        this._initialized = false;

    }

    initialize() {

        this._initialized = true;

        this._logger.info("RandomService Initialized");

    }

    shutdown() {

        this.clearSeed();

        this._initialized = false;

    }

    setSeed(seed) {

        this._assertInitialized();

        const normalizedSeed = normalizeSeed(seed);

        this._seed = seed;

        this._seededGenerator = createSeededGenerator(normalizedSeed);

        this._logger.info("Seed Enabled");

    }

    clearSeed() {

        if (!this._seededGenerator) {

            this._seed = null;

            return;

        }

        this._seed = null;

        this._seededGenerator = null;

        this._logger.info("Seed Cleared");

    }

    getSeed() {

        return this._seed;

    }

    nextFloat() {

        this._assertInitialized();

        if (this._seededGenerator) {

            return this._seededGenerator.nextFloat();

        }

        const buffer = this._randomBuffer;

        randomFillSync(buffer);

        const value = buffer.readUInt32BE(0);

        return value / 4294967296;

    }

    nextInt(min, max) {

        this._assertInitialized();

        this._validateIntRange(min, max);

        if (this._seededGenerator) {

            const range = max - min + 1;

            return min + Math.floor(this._seededGenerator.nextFloat() * range);

        }

        return randomInt(min, max + 1);

    }

    pick(array) {

        this._assertInitialized();

        this._validatePickArray(array);

        const index = this.nextInt(0, array.length - 1);

        return array[index];

    }

    shuffle(array) {

        this._assertInitialized();

        this._validatePickArray(array);

        const copy = array.slice();

        for (let index = copy.length - 1; index > 0; index -= 1) {

            const swapIndex = this.nextInt(0, index);

            const current = copy[index];

            copy[index] = copy[swapIndex];

            copy[swapIndex] = current;

        }

        return copy;

    }

    generateTraceSeed() {

        this._assertInitialized();

        return `trace_seed_${randomUUID()}`;

    }

    getDebugSnapshot() {

        return {
            mode: this._seededGenerator ? MODES.DETERMINISTIC : MODES.PRODUCTION,
            seed: this._seed,
            generatorType: this._seededGenerator
                ? GENERATOR_TYPES.SEEDED
                : GENERATOR_TYPES.CRYPTO
        };

    }

    _validateIntRange(min, max) {

        if (!Number.isInteger(min) || !Number.isInteger(max)) {

            throw new Error("nextInt requires integer min and max values");

        }

        if (min > max) {

            throw new Error("nextInt min cannot be greater than max");

        }

    }

    _validatePickArray(array) {

        if (!Array.isArray(array)) {

            throw new Error("pick and shuffle require an array");

        }

        if (array.length === 0) {

            throw new Error("pick and shuffle require a non-empty array");

        }

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("RandomService is not initialized");

        }

    }

}
