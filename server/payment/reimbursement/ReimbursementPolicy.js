/**
 * R17.8V.2P.Q — Reimbursement operational policy (no transfer / signing).
 */

import { EVENT_SOURCES } from "../../events/EventSources.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import { DEPLOYMENT_REIMBURSEMENT_STATUS } from "./deploymentReimbursementStates.js";
import {
    getReimbursementDailyLimitTon,
    getReimbursementMaxTransferTon,
    isReimbursementSendAllowed
} from "./ReimbursementWalletConfig.js";
import { tonStringToNanoton, nanotonToTonString } from "./nanoton.js";

export const REIMBURSEMENT_POLICY_RESULT = Object.freeze({
    OK: "OK",
    FEATURE_DISABLED: "FEATURE_DISABLED",
    AMOUNT_INVALID: "AMOUNT_INVALID",
    AMOUNT_EXCEEDS_MAX: "AMOUNT_EXCEEDS_MAX",
    DAILY_LIMIT_REACHED: "DAILY_LIMIT_REACHED"
});

/**
 * UTC calendar day bounds for "today".
 *
 * @param {number} [now]
 * @returns {{ startMs: number, endMs: number }}
 */
export function utcDayBounds(now = Date.now()) {

    const d = new Date(now);

    const startMs = Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth(),
        d.getUTCDate(),
        0,
        0,
        0,
        0
    );

    return {
        startMs,
        endMs: startMs + 24 * 60 * 60 * 1000
    };

}

/**
 * @param {object} record
 * @param {{ startMs: number, endMs: number }} day
 * @returns {boolean}
 */
export function isReimbursementCountedInDailySpend(record, day) {

    const payload = record?.payload ?? record;

    if (!payload || typeof payload !== "object") {

        return false;

    }

    const status = payload.status;
    const amountNano = tonStringToNanoton(payload.amountTon);

    if (amountNano == null || amountNano <= 0n) {

        return false;

    }

    if (
        status === DEPLOYMENT_REIMBURSEMENT_STATUS.PROCESSING
        || status === DEPLOYMENT_REIMBURSEMENT_STATUS.AWAITING_TRANSACTION_HASH
    ) {

        return true;

    }

    if (status === DEPLOYMENT_REIMBURSEMENT_STATUS.CONFIRMED) {

        const at = Number(payload.confirmedAt ?? payload.processedAt ?? payload.createdAt);

        return Number.isFinite(at) && at >= day.startMs && at < day.endMs;

    }

    return false;

}

export class ReimbursementPolicy {

    /**
     * @param {{
     *   repository?: { listActiveReimbursements?: Function, listAll?: Function }|null,
     *   env?: NodeJS.ProcessEnv,
     *   eventBus?: { emit?: Function }|null,
     *   logger?: object|null
     * }} [options]
     */
    constructor({
        repository = null,
        env = process.env,
        eventBus = null,
        logger = null
    } = {}) {

        this._repository = repository;
        this._env = env;
        this._eventBus = eventBus;
        this._logger = logger;

    }

    /**
     * @returns {{ ok: boolean, code: string, reason?: string }}
     */
    validateWalletPolicy() {

        if (!isReimbursementSendAllowed(this._env)) {

            return {
                ok: false,
                code: REIMBURSEMENT_POLICY_RESULT.FEATURE_DISABLED,
                reason: "reimbursement_send_disabled"
            };

        }

        return {
            ok: true,
            code: REIMBURSEMENT_POLICY_RESULT.OK
        };

    }

    /**
     * @param {string} amountTon
     * @returns {{ ok: boolean, code: string, reason?: string, maxTransferTon?: string }}
     */
    validateSingleTransfer(amountTon) {

        const amountNano = tonStringToNanoton(amountTon);

        if (amountNano == null || amountNano <= 0n) {

            return {
                ok: false,
                code: REIMBURSEMENT_POLICY_RESULT.AMOUNT_INVALID,
                reason: "amount_not_positive"
            };

        }

        const maxTon = getReimbursementMaxTransferTon(this._env);
        const maxNano = tonStringToNanoton(maxTon);

        if (maxNano == null || amountNano > maxNano) {

            this._emitBlocked({
                amount: String(amountTon ?? ""),
                reason: "max_transfer_exceeded"
            });

            return {
                ok: false,
                code: REIMBURSEMENT_POLICY_RESULT.AMOUNT_EXCEEDS_MAX,
                reason: `amount_exceeds_max_${maxTon}`,
                maxTransferTon: maxTon
            };

        }

        return {
            ok: true,
            code: REIMBURSEMENT_POLICY_RESULT.OK,
            maxTransferTon: maxTon
        };

    }

    /**
     * @param {{
     *   amountTon: string,
     *   excludeRecordId?: string|null,
     *   now?: number
     * }} input
     * @returns {{
     *   ok: boolean,
     *   code: string,
     *   reason?: string,
     *   spentTon?: string,
     *   dailyLimitTon?: string,
     *   projectedTon?: string
     * }}
     */
    validateDailyLimit({
        amountTon,
        excludeRecordId = null,
        now = Date.now()
    } = {}) {

        const amountNano = tonStringToNanoton(amountTon);

        if (amountNano == null || amountNano <= 0n) {

            return {
                ok: false,
                code: REIMBURSEMENT_POLICY_RESULT.AMOUNT_INVALID,
                reason: "amount_not_positive"
            };

        }

        const dailyLimitTon = getReimbursementDailyLimitTon(this._env);
        const dailyLimitNano = tonStringToNanoton(dailyLimitTon);

        if (dailyLimitNano == null) {

            return {
                ok: false,
                code: REIMBURSEMENT_POLICY_RESULT.DAILY_LIMIT_REACHED,
                reason: "daily_limit_config_invalid",
                dailyLimitTon
            };

        }

        const day = utcDayBounds(now);
        const records = this._listRecords();
        let spentNano = 0n;

        for (const record of records) {

            if (
                excludeRecordId
                && record.recordId === excludeRecordId
            ) {

                continue;

            }

            if (!isReimbursementCountedInDailySpend(record, day)) {

                continue;

            }

            const nano = tonStringToNanoton(record.payload?.amountTon);

            if (nano != null) {

                spentNano += nano;

            }

        }

        const projected = spentNano + amountNano;

        if (projected > dailyLimitNano) {

            this._emitBlocked({
                amount: String(amountTon ?? ""),
                reason: "daily_limit_reached",
                spentTon: nanotonToTonString(spentNano),
                dailyLimitTon
            });

            this._emit(EVENT_TYPES.REIMBURSEMENT_DAILY_LIMIT_REACHED, {
                amount: String(amountTon ?? ""),
                reason: "daily_limit_reached",
                spentTon: nanotonToTonString(spentNano),
                dailyLimitTon,
                timestamp: now
            });

            return {
                ok: false,
                code: REIMBURSEMENT_POLICY_RESULT.DAILY_LIMIT_REACHED,
                reason: "daily_limit_reached",
                spentTon: nanotonToTonString(spentNano),
                dailyLimitTon,
                projectedTon: nanotonToTonString(projected)
            };

        }

        return {
            ok: true,
            code: REIMBURSEMENT_POLICY_RESULT.OK,
            spentTon: nanotonToTonString(spentNano),
            dailyLimitTon,
            projectedTon: nanotonToTonString(projected)
        };

    }

    /**
     * @returns {object[]}
     */
    _listRecords() {

        if (this._repository?.listActiveReimbursements) {

            return this._repository.listActiveReimbursements();

        }

        if (this._repository?.listAll) {

            return this._repository.listAll();

        }

        return [];

    }

    /**
     * @param {object} fields
     */
    _emitBlocked(fields) {

        this._emit(EVENT_TYPES.REIMBURSEMENT_POLICY_BLOCKED, {
            gameId: fields.gameId ?? null,
            amount: fields.amount ?? null,
            reason: fields.reason ?? null,
            timestamp: Date.now()
        });

    }

    /**
     * @param {string} type
     * @param {object} payload
     */
    _emit(type, payload) {

        const safe = Object.freeze({
            gameId: payload?.gameId ?? null,
            amount: payload?.amount ?? null,
            reason: payload?.reason ?? null,
            timestamp: payload?.timestamp ?? Date.now(),
            spentTon: payload?.spentTon ?? null,
            dailyLimitTon: payload?.dailyLimitTon ?? null
        });

        this._logger?.info?.(
            `${type} | amount=${safe.amount ?? "none"} | reason=${safe.reason ?? "none"}`
        );

        try {

            this._eventBus?.emit?.({
                source: EVENT_SOURCES.DEPLOYMENT_REIMBURSEMENT_SERVICE,
                type,
                payload: safe
            });

        } catch {

            // audit emit must never break policy checks

        }

    }

}
