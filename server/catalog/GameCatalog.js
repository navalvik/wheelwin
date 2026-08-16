import { COLORS } from "./Colors.js";
import { ICONS } from "./Icons.js";
import { INPUT_RULES } from "./InputRules.js";
import { PAYMENT_RULES } from "./PaymentRules.js";
import { STAKES } from "./Stakes.js";
import { TIMERS } from "./Timers.js";
import { WHEEL_RULES } from "./WheelRules.js";
import { WINNER_RULES } from "./WinnerRules.js";

export const CATALOG_VERSION = "1.0";

function deepFreeze(value) {

    if (value === null || typeof value !== "object") {

        return value;

    }

    Object.freeze(value);

    for (const key of Object.keys(value)) {

        deepFreeze(value[key]);

    }

    return value;

}

function assertNoDuplicates(items, getKey, label) {

    const seen = new Set();

    for (const item of items) {

        const key = getKey(item);

        if (seen.has(key)) {

            throw new Error(`Duplicate ${label}: ${key}`);

        }

        seen.add(key);

    }

}

function validateStakes(stakes) {

    for (const stake of stakes) {

        if (!Number.isFinite(stake) || stake <= 0) {

            throw new Error(`Invalid stake value: ${stake}`);

        }

    }

    assertNoDuplicates(stakes, (stake) => String(stake), "stake");

}

function validateWheelRules(wheelRules) {

    if (!Number.isInteger(wheelRules.minSectors) || wheelRules.minSectors <= 0) {

        throw new Error("Invalid wheel minSectors");

    }

    if (!Number.isInteger(wheelRules.maxSectors) || wheelRules.maxSectors <= 0) {

        throw new Error("Invalid wheel maxSectors");

    }

    if (wheelRules.minSectors > wheelRules.maxSectors) {

        throw new Error("Wheel minSectors cannot exceed maxSectors");

    }

    if (!Number.isFinite(wheelRules.defaultRotation)) {

        throw new Error("Invalid wheel defaultRotation");

    }

    const { height, width } = wheelRules.defaultTriangleRatio;

    if (!Number.isFinite(height) || height <= 0) {

        throw new Error("Invalid wheel defaultTriangleRatio.height");

    }

    if (!Number.isFinite(width) || width <= 0) {

        throw new Error("Invalid wheel defaultTriangleRatio.width");

    }

}

export class GameCatalog {

    constructor({ logger }) {

        this._logger = logger;

        this._colors = null;

        this._icons = null;

        this._stakes = null;

        this._timers = null;

        this._wheelRules = null;

        this._inputRules = null;

        this._winnerRules = null;

        this._paymentRules = null;

        this._catalogVersion = CATALOG_VERSION;

        this._initialized = false;

    }

    initialize() {

        if (this._initialized) {

            return;

        }

        assertNoDuplicates(COLORS, (color) => color.id, "color");

        assertNoDuplicates(ICONS, (icon) => icon.id, "icon");

        validateStakes(STAKES);

        validateWheelRules(WHEEL_RULES);

        this._colors = deepFreeze([...COLORS]);

        this._icons = deepFreeze([...ICONS]);

        this._stakes = deepFreeze([...STAKES]);

        this._timers = deepFreeze({ ...TIMERS });

        this._wheelRules = deepFreeze({ ...WHEEL_RULES });

        this._inputRules = deepFreeze({ ...INPUT_RULES });

        this._winnerRules = deepFreeze({ ...WINNER_RULES });

        this._paymentRules = deepFreeze({
            ...PAYMENT_RULES,
            contributionByStake: { ...PAYMENT_RULES.contributionByStake }
        });

        this._initialized = true;

    }

    configurePhaseTimers(timers) {

        if (!timers || typeof timers !== "object") {

            throw new Error("GameCatalog.configurePhaseTimers requires timers");

        }

        this._timers = deepFreeze({ ...timers });

    }

    /**
     * R17.9G.1 — Replace allowed stake catalog for future game sessions.
     * Does not mutate configurations already frozen at GAME_INITIALIZED.
     */
    configureStakes(stakes) {

        this._assertInitialized();

        if (!Array.isArray(stakes) || stakes.length === 0) {

            throw new Error("GameCatalog.configureStakes requires a non-empty array");

        }

        validateStakes(stakes);

        this._stakes = deepFreeze([...stakes]);

    }

    /**
     * R17.9G.1 — Replace payment rules for future contract snapshots.
     */
    configurePaymentRules(paymentRules) {

        this._assertInitialized();

        if (!paymentRules || typeof paymentRules !== "object") {

            throw new Error("GameCatalog.configurePaymentRules requires paymentRules");

        }

        this._paymentRules = deepFreeze({
            ...paymentRules,
            contributionByStake: {
                ...(paymentRules.contributionByStake ?? {})
            }
        });

    }

    getColors() {

        this._assertInitialized();

        return this._colors;

    }

    getIcons() {

        this._assertInitialized();

        return this._icons;

    }

    getStakes() {

        this._assertInitialized();

        return this._stakes;

    }

    getTimers() {

        this._assertInitialized();

        return this._timers;

    }

    getWheelRules() {

        this._assertInitialized();

        return this._wheelRules;

    }

    getInputRules() {

        this._assertInitialized();

        return this._inputRules;

    }

    getWinnerRules() {

        this._assertInitialized();

        return this._winnerRules;

    }

    getPaymentRules() {

        this._assertInitialized();

        return this._paymentRules;

    }

    getCatalogVersion() {

        return this._catalogVersion;

    }

    getDebugSnapshot() {

        this._assertInitialized();

        return {
            catalogVersion: this._catalogVersion,
            colors: this._colors.map((color) => color.id),
            icons: this._icons.map((icon) => icon.id),
            stakes: [...this._stakes],
            wheelRules: this._wheelRules,
            timers: this._timers,
            inputRules: this._inputRules,
            winnerRules: this._winnerRules,
            paymentRules: this._paymentRules
        };

    }

    _assertInitialized() {

        if (!this._initialized) {

            throw new Error("GameCatalog is not initialized");

        }

    }

}
