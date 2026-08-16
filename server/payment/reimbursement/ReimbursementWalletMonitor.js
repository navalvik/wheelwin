/**
 * R17.8V.2P.Q — Reimbursement wallet balance monitor (no transfer / signing).
 */

import { EVENT_SOURCES } from "../../events/EventSources.js";
import { EVENT_TYPES } from "../../events/EventTypes.js";
import {
    getReimbursementWalletReserveTon
} from "./ReimbursementWalletConfig.js";
import { nanotonToTonString, tonStringToNanoton } from "./nanoton.js";

export const REIMBURSEMENT_WALLET_MONITOR_RESULT = Object.freeze({
    OK: "OK",
    INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
    BALANCE_UNAVAILABLE: "BALANCE_UNAVAILABLE",
    ADDRESS_MISSING: "ADDRESS_MISSING"
});

export class ReimbursementWalletMonitor {

    /**
     * @param {{
     *   tonService?: { getBalance: Function }|null,
     *   address?: string|null,
     *   getAddress?: Function|null,
     *   env?: NodeJS.ProcessEnv,
     *   eventBus?: { emit?: Function }|null,
     *   logger?: object|null
     * }} [options]
     */
    constructor({
        tonService = null,
        address = null,
        getAddress = null,
        env = process.env,
        eventBus = null,
        logger = null
    } = {}) {

        this._tonService = tonService;
        this._address = address;
        this._getAddress = getAddress;
        this._env = env;
        this._eventBus = eventBus;
        this._logger = logger;

    }

    /**
     * @returns {string|null}
     */
    resolveAddress() {

        if (typeof this._getAddress === "function") {

            const dynamic = this._getAddress();

            if (dynamic) {

                return String(dynamic).trim() || null;

            }

        }

        return this._address ? String(this._address).trim() : null;

    }

    /**
     * @returns {Promise<{ ok: boolean, balanceNano?: bigint, balanceTon?: string, code?: string }>}
     */
    async getBalance() {

        const address = this.resolveAddress();

        if (!address) {

            return {
                ok: false,
                code: REIMBURSEMENT_WALLET_MONITOR_RESULT.ADDRESS_MISSING
            };

        }

        if (!this._tonService?.getBalance) {

            return {
                ok: false,
                code: REIMBURSEMENT_WALLET_MONITOR_RESULT.BALANCE_UNAVAILABLE
            };

        }

        try {

            const balanceNano = await this._tonService.getBalance(address);

            if (typeof balanceNano !== "bigint") {

                return {
                    ok: false,
                    code: REIMBURSEMENT_WALLET_MONITOR_RESULT.BALANCE_UNAVAILABLE
                };

            }

            return {
                ok: true,
                balanceNano,
                balanceTon: nanotonToTonString(balanceNano)
            };

        } catch (error) {

            this._logger?.warn?.(
                `ReimbursementWalletMonitor getBalance failed | ${error?.message ?? error}`
            );

            return {
                ok: false,
                code: REIMBURSEMENT_WALLET_MONITOR_RESULT.BALANCE_UNAVAILABLE
            };

        }

    }

    /**
     * Requires: balance > transferAmount + reserve (strictly greater operational headroom).
     *
     * @param {string} amountTon
     * @returns {Promise<object>}
     */
    async validateAvailableBalance(amountTon) {

        const amountNano = tonStringToNanoton(amountTon);

        if (amountNano == null || amountNano <= 0n) {

            return {
                ok: false,
                code: REIMBURSEMENT_WALLET_MONITOR_RESULT.INSUFFICIENT_BALANCE,
                reason: "amount_invalid"
            };

        }

        const reserveTon = getReimbursementWalletReserveTon(this._env);
        const reserveNano = tonStringToNanoton(reserveTon) ?? 0n;
        const required = amountNano + reserveNano;

        const balance = await this.getBalance();

        if (!balance.ok) {

            return {
                ok: false,
                code: balance.code,
                reason: "balance_unavailable",
                reserveTon
            };

        }

        if (balance.balanceNano < required) {

            this.emitLowBalanceWarning({
                amount: String(amountTon ?? ""),
                balanceTon: balance.balanceTon,
                reserveTon,
                requiredTon: nanotonToTonString(required)
            });

            return {
                ok: false,
                code: REIMBURSEMENT_WALLET_MONITOR_RESULT.INSUFFICIENT_BALANCE,
                reason: "insufficient_balance_with_reserve",
                balanceTon: balance.balanceTon,
                reserveTon,
                requiredTon: nanotonToTonString(required)
            };

        }

        // Soft warning when remaining after transfer is near reserve.
        const remaining = balance.balanceNano - amountNano;

        if (remaining <= reserveNano * 2n) {

            this.emitLowBalanceWarning({
                amount: String(amountTon ?? ""),
                balanceTon: balance.balanceTon,
                reserveTon,
                reason: "approaching_reserve"
            });

        }

        return {
            ok: true,
            code: REIMBURSEMENT_WALLET_MONITOR_RESULT.OK,
            balanceTon: balance.balanceTon,
            reserveTon,
            requiredTon: nanotonToTonString(required)
        };

    }

    /**
     * @param {object} fields
     */
    emitLowBalanceWarning(fields = {}) {

        const safe = Object.freeze({
            gameId: fields.gameId ?? null,
            amount: fields.amount ?? null,
            reason: fields.reason ?? "low_balance",
            timestamp: Date.now(),
            balanceTon: fields.balanceTon ?? null,
            reserveTon: fields.reserveTon ?? null,
            requiredTon: fields.requiredTon ?? null
        });

        this._logger?.warn?.(
            `REIMBURSEMENT_LOW_BALANCE | amount=${safe.amount ?? "none"} | `
                + `balance=${safe.balanceTon ?? "none"} | reason=${safe.reason}`
        );

        try {

            this._eventBus?.emit?.({
                source: EVENT_SOURCES.DEPLOYMENT_REIMBURSEMENT_SERVICE,
                type: EVENT_TYPES.REIMBURSEMENT_LOW_BALANCE,
                payload: safe
            });

        } catch {

            // ignore

        }

    }

}
