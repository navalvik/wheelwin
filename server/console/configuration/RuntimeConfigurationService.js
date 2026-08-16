/**
 * R17.9G.1 — Runtime configuration mutation service.
 *
 * Persists versioned overrides, writes audit records, and applies adapters so
 * ONLY future game sessions observe new values. Never mutates frozen per-game
 * configuration snapshots after GAME_INITIALIZED.
 */

import { LoggingManager } from "../../logging/LoggingManager.js";
import { LOG_LEVELS } from "../../logging/levels.js";
import { appendRuntimeConfigurationAudit } from "./runtimeConfigurationAuditStore.js";
import {
    readRuntimeConfigurationState,
    writeRuntimeConfigurationState
} from "./runtimeConfigurationStore.js";
import { RUNTIME_CONFIG_EDITABLE_KEYS } from "./runtimeConfigurationKeys.js";
import { validateRuntimeConfigurationPatch } from "./validateRuntimeConfigurationPatch.js";

export class RuntimeConfigurationService {

    /**
     * @param {{
     *   logger?: { info?: Function, warn?: Function, error?: Function },
     *   env?: NodeJS.ProcessEnv,
     *   applyAdapters?: object|null
     * }} [options]
     */
    constructor({
        logger = null,
        env = process.env,
        applyAdapters = null
    } = {}) {

        this._logger = logger;
        this._env = env;
        this._applyAdapters = applyAdapters;
        this._state = null;
        this._initialized = false;

    }

    initialize() {

        this._state = readRuntimeConfigurationState(this._env)
            ?? Object.freeze({
                schemaVersion: 1,
                configVersion: 0,
                values: Object.freeze({}),
                previousValues: Object.freeze({}),
                updatedAt: null,
                updatedBy: null
            });

        this._initialized = true;

        this.applyToRuntime();

        return this._state;

    }

    /**
     * Late-bind apply targets after managers exist.
     * @param {object|null} applyAdapters
     */
    setApplyAdapters(applyAdapters) {

        this._applyAdapters = applyAdapters;

        if (this._initialized) {

            this.applyToRuntime();

        }

    }

    isInitialized() {

        return this._initialized === true;

    }

    getState() {

        return this._state;

    }

    /**
     * Effective override map (persisted values only).
     * @returns {Readonly<Record<string, number>>}
     */
    getOverrides() {

        return this._state?.values ?? Object.freeze({});

    }

    /**
     * Apply current overrides to live adapters (defaults for new sessions).
     */
    applyToRuntime() {

        const adapters = this._applyAdapters;

        if (!adapters || !this._state) {

            return;

        }

        const values = this._state.values ?? {};

        if (Number.isFinite(values.setupTimeoutMs)
            && typeof adapters.setSetupDurationMs === "function") {

            adapters.setSetupDurationMs(values.setupTimeoutMs);

        }

        if (Number.isFinite(values.paymentTimeoutMs)
            && typeof adapters.setPaymentDurationMs === "function") {

            adapters.setPaymentDurationMs(values.paymentTimeoutMs);

        }

        if ((Number.isFinite(values.countdownDurationMs)
                || Number.isFinite(values.brakeDurationMs))
            && typeof adapters.setPhaseTimerOverrides === "function") {

            adapters.setPhaseTimerOverrides({
                countdownDurationMs: values.countdownDurationMs,
                brakeDurationMs: values.brakeDurationMs
            });

        }

        if (Number.isFinite(values.settlementTimeoutMs)
            && typeof adapters.setSettlementTimeoutMs === "function") {

            adapters.setSettlementTimeoutMs(values.settlementTimeoutMs);

        }

        if (typeof adapters.setFinancialOverrides === "function"
            && (Number.isFinite(values.baseStake1Gram)
                || Number.isFinite(values.baseStake2Gram)
                || Number.isFinite(values.ownerFeePercent))) {

            adapters.setFinancialOverrides({
                baseStake1Gram: values.baseStake1Gram,
                baseStake2Gram: values.baseStake2Gram,
                ownerFeePercent: values.ownerFeePercent
            });

        }

    }

    /**
     * @param {unknown} body
     * @param {{ username?: string|null, role?: string|null }} actor
     * @returns {{
     *   ok: boolean,
     *   status?: number,
     *   error?: string,
     *   details?: string[],
     *   state?: object,
     *   changes?: object[],
     *   auditRecords?: object[]
     * }}
     */
    update(body, actor = {}) {

        if (!this._initialized) {

            return {
                ok: false,
                status: 503,
                error: "Runtime configuration service is not initialized"
            };

        }

        const validation = validateRuntimeConfigurationPatch(body);

        if (!validation.ok) {

            return {
                ok: false,
                status: 400,
                error: validation.error,
                details: validation.details
            };

        }

        const patch = validation.patch;
        const previousValues = { ...(this._state.values ?? {}) };
        const nextValues = { ...previousValues, ...patch };

        // Stake consistency when only one stake is patched.
        if (patch.baseStake1Gram !== undefined
            && patch.baseStake2Gram === undefined
            && Number.isFinite(previousValues.baseStake2Gram)
            && patch.baseStake1Gram === previousValues.baseStake2Gram) {

            return {
                ok: false,
                status: 400,
                error: "Validation failed",
                details: ["baseStake1Gram and baseStake2Gram must differ"]
            };

        }

        if (patch.baseStake2Gram !== undefined
            && patch.baseStake1Gram === undefined
            && Number.isFinite(previousValues.baseStake1Gram)
            && patch.baseStake2Gram === previousValues.baseStake1Gram) {

            return {
                ok: false,
                status: 400,
                error: "Validation failed",
                details: ["baseStake1Gram and baseStake2Gram must differ"]
            };

        }

        const changes = [];

        for (const key of RUNTIME_CONFIG_EDITABLE_KEYS) {

            if (!Object.prototype.hasOwnProperty.call(patch, key)) {

                continue;

            }

            const oldValue = previousValues[key] ?? null;
            const newValue = patch[key];

            if (oldValue === newValue) {

                continue;

            }

            changes.push({
                parameter: key,
                oldValue,
                newValue
            });

        }

        if (changes.length === 0) {

            return {
                ok: true,
                status: 200,
                state: this._state,
                changes: [],
                auditRecords: [],
                message: "No changes detected"
            };

        }

        const nextVersion = (Number(this._state.configVersion) || 0) + 1;

        const persisted = writeRuntimeConfigurationState({
            configVersion: nextVersion,
            values: nextValues,
            previousValues,
            updatedBy: actor.username ?? null
        }, this._env);

        this._state = persisted;

        const auditRecords = [];

        for (const change of changes) {

            const record = appendRuntimeConfigurationAudit({
                user: actor.username ?? null,
                role: actor.role ?? null,
                parameter: change.parameter,
                oldValue: change.oldValue,
                newValue: change.newValue,
                configVersion: nextVersion
            }, this._env);

            auditRecords.push(record);

            this._emitAuditLog(record);

        }

        this.applyToRuntime();

        this._logger?.info?.(
            `RUNTIME_CONFIG_CHANGED | version=${nextVersion}`
            + ` | user=${actor.username ?? "unknown"}`
            + ` | changes=${changes.length}`
        );

        return {
            ok: true,
            status: 200,
            state: this._state,
            changes,
            auditRecords,
            message: "Runtime configuration updated for future game sessions"
        };

    }

    /**
     * @param {object} record
     */
    _emitAuditLog(record) {

        const manager = LoggingManager.getInstance();

        if (manager.isInitialized()) {

            manager.audit("RUNTIME_CONFIG_CHANGED", {
                component: "RuntimeConfiguration",
                user: record.user,
                role: record.role,
                parameter: record.parameter,
                oldValue: record.oldValue,
                newValue: record.newValue,
                configVersion: record.configVersion,
                timestamp: record.timestamp
            }, LOG_LEVELS.INFO);

            return;

        }

        this._logger?.info?.(
            `RUNTIME_CONFIG_CHANGED | parameter=${record.parameter}`
            + ` | old=${record.oldValue} | new=${record.newValue}`
            + ` | user=${record.user}`
        );

    }

}
