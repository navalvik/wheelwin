/**
 * Phase 1 — Explicit asset / denomination mapping.
 *
 * D1 — integer atomic-unit amounts only. No floating-point arithmetic is used
 * anywhere in this module; conversions are integer multiplies.
 *
 * D2 — the display denomination (e.g. `Gram`) is NEVER assumed to equal any
 * particular amount of TON. The amount of atomic units per display unit comes
 * from explicit configuration, and payment execution is rejected when that
 * mapping is missing.
 */

import {
    PaymentConfigurationError,
    PaymentExecutionBlockedError,
    PaymentValidationError
} from "./PaymentErrors.js";

const ASSET_DENOMINATION_SCHEMA_VERSION = 1;

/**
 * @param {unknown} value
 * @returns {asserts value is number}
 */
function assertPositiveSafeInteger(value, field) {

    if (typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value <= 0) {

        throw new PaymentValidationError(
            `${field} must be a positive safe integer`,
            { field, value }
        );

    }

}

export class AssetDenomination {

    constructor({
        asset,
        symbol,
        network,
        atomicUnitsPerUnit
    }) {

        assertPositiveSafeInteger(atomicUnitsPerUnit, "atomicUnitsPerUnit");

        if (typeof asset !== "string" || asset.trim() === "") {

            throw new PaymentValidationError("asset must be a non-empty string");

        }

        if (typeof symbol !== "string" || symbol.trim() === "") {

            throw new PaymentValidationError("symbol must be a non-empty string");

        }

        if (typeof network !== "string" || network.trim() === "") {

            throw new PaymentValidationError("network must be a non-empty string");

        }

        this.asset = asset;

        this.symbol = symbol;

        this.network = network;

        this.atomicUnitsPerUnit = atomicUnitsPerUnit;

        Object.freeze(this);

    }

    /**
     * Integer conversion: display units -> atomic units.
     *
     * @param {number} units
     * @returns {number}
     */
    toAtomicUnits(units) {

        assertPositiveSafeInteger(units, "units");

        const atomic = units * this.atomicUnitsPerUnit;

        if (!Number.isSafeInteger(atomic)) {

            throw new PaymentValidationError(
                "converted atomic amount exceeds safe integer range",
                { units, atomicUnitsPerUnit: this.atomicUnitsPerUnit }
            );

        }

        return atomic;

    }

    /**
     * Integer conversion: atomic units -> display units (exact division only).
     *
     * @param {number} atomicUnits
     * @returns {number}
     */
    toDisplayUnits(atomicUnits) {

        assertPositiveSafeInteger(atomicUnits, "atomicUnits");

        const units = atomicUnits / this.atomicUnitsPerUnit;

        if (!Number.isInteger(units)) {

            throw new PaymentValidationError(
                "atomic amount is not an exact multiple of the denomination",
                { atomicUnits, atomicUnitsPerUnit: this.atomicUnitsPerUnit }
            );

        }

        return units;

    }

    /**
     * True only when an explicit atomic-unit mapping was configured.
     */
    isConfigured() {

        return this.atomicUnitsPerUnit > 0;

    }

    toJSON() {

        return Object.freeze({
            asset: this.asset,
            symbol: this.symbol,
            network: this.network,
            atomicUnitsPerUnit: this.atomicUnitsPerUnit,
            schemaVersion: ASSET_DENOMINATION_SCHEMA_VERSION
        });

    }

}

/**
 * Registry of explicitly configured asset / denomination mappings.
 *
 * The registry is strictly opt-in: if no mapping is configured for the
 * asset/network pair, lookups fail closed and execution is rejected.
 */
export class AssetDenominationRegistry {

    constructor() {

        /** @type {Map<string, AssetDenomination>} key = `${network}::${asset}` */
        this._mappings = new Map();

    }

    /**
     * @param {{ assets?: Array<object> }} [options]
     * @returns {AssetDenominationRegistry}
     */
    static fromConfiguration(options = {}) {

        const registry = new AssetDenominationRegistry();

        const assets = options.assets;

        if (assets !== undefined) {

            if (!Array.isArray(assets)) {

                throw new PaymentConfigurationError(
                    "payment asset configuration must be an array",
                    { assets }
                );

            }

            for (const entry of assets) {

                registry.configure(entry);

            }

        }

        return registry;

    }

    /**
     * @param {object} descriptor
     * @returns {AssetDenomination}
     */
    configure({ asset, symbol, network, atomicUnitsPerUnit }) {

        const mapping = new AssetDenomination({
            asset,
            symbol,
            network,
            atomicUnitsPerUnit
        });

        this._mappings.set(
            `${mapping.network}::${mapping.asset}`,
            mapping
        );

        return mapping;

    }

    /**
     * Explicit lookup. Returns null (never a fallback) when not configured.
     *
     * @param {string} network
     * @param {string} asset
     * @returns {AssetDenomination|null}
     */
    lookup(network, asset) {

        return this._mappings.get(`${network}::${asset}`) ?? null;

    }

    /**
     * Fail-closed lookup used by the payment execution path.
     *
     * @param {string} network
     * @param {string} asset
     * @returns {AssetDenomination}
     */
    requireMapping(network, asset) {

        const mapping = this.lookup(network, asset);

        if (!mapping || !mapping.isConfigured()) {

            throw new PaymentExecutionBlockedError(
                "payment execution rejected: asset/denomination mapping is not "
                    + `configured for ${asset} on ${network}`,
                { network, asset }
            );

        }

        return mapping;

    }

    /**
     * True when an explicit, configured mapping exists.
     *
     * @param {string} network
     * @param {string} asset
     * @returns {boolean}
     */
    isExecutionConfigured(network, asset) {

        const mapping = this.lookup(network, asset);

        return mapping != null && mapping.isConfigured() === true;

    }

    /**
     * @returns {Array<object>}
     */
    listMappings() {

        return [...this._mappings.values()].map((mapping) => mapping.toJSON());

    }

    /**
     * @returns {AssetDenominationRegistry}
     */
    toJSON() {

        return Object.freeze({
            mappings: this.listMappings(),
            schemaVersion: ASSET_DENOMINATION_SCHEMA_VERSION
        });

    }

}
