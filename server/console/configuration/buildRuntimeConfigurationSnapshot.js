/**
 * R17.9G — Read-only Runtime Configuration snapshot for Developer Console.
 *
 * Observes existing authoritative loaders / catalogs only.
 * Never mutates gameplay, payments, physics, or wallets.
 * Never returns mnemonics or private keys.
 */

import { OwnerConfiguration } from "../../config/OwnerConfiguration.js";
import { PAYMENT_RULES } from "../../catalog/PaymentRules.js";
import { STAKES } from "../../catalog/Stakes.js";

/**
 * @param {number} ms
 * @returns {number|null}
 */
function msToSeconds(ms) {

    const n = Number(ms);

    if (!Number.isFinite(n) || n < 0) {

        return null;

    }

    return Math.round(n / 1000);

}

/**
 * @param {unknown} address
 * @returns {string|null}
 */
function safeAddress(address) {

    const text = String(address ?? "").trim();

    return text || null;

}

/**
 * Build immutable runtime configuration DTO for GET /console/configuration/runtime.
 *
 * @param {{
 *   runtimeConfig?: {
 *     rooms?: object,
 *     gameplayPhases?: object,
 *     ton?: object
 *   }|null,
 *   env?: NodeJS.ProcessEnv
 * }} [options]
 * @returns {object}
 */
export function buildRuntimeConfigurationSnapshot({
    runtimeConfig = null,
    env = process.env
} = {}) {

    const rooms = runtimeConfig?.rooms ?? {};
    const phases = runtimeConfig?.gameplayPhases ?? {};
    const ton = runtimeConfig?.ton ?? {};

    let ownerWallet = null;

    try {

        if (OwnerConfiguration.isLoaded()) {

            ownerWallet = safeAddress(OwnerConfiguration.getOwnerWallet());

        }

    } catch {

        ownerWallet = null;

    }

    const deployWallet = safeAddress(ton.deployerExpectedAddress);
    const reimbursementWallet = safeAddress(
        env.TON_REIMBURSEMENT_EXPECTED_ADDRESS
    );

    const stakes = Array.isArray(STAKES) ? [...STAKES] : [];
    const feeRate = Number(PAYMENT_RULES.platformFeeRate);

    return Object.freeze({
        schemaVersion: 1,
        readOnly: true,
        generatedAt: Date.now(),
        notes: Object.freeze({
            verifyTimeout:
                "No separate VERIFY_DURATION_MS. VERIFY rides the Setup Timer.",
            countdown:
                "Displayed as READY phase duration (server GameClock READY).",
            mutation: "Editing is not available in R17.9G (read-only)."
        }),
        timers: Object.freeze({
            setupTimeoutMs: Number(rooms.setupDurationMs) || null,
            setupTimeoutSec: msToSeconds(rooms.setupDurationMs),
            verifyTimeoutMs: Number(rooms.setupDurationMs) || null,
            verifyTimeoutSec: msToSeconds(rooms.setupDurationMs),
            verifyTimeoutSource: "setupTimeout",
            paymentTimeoutMs: Number(rooms.paymentSessionDurationMs) || null,
            paymentTimeoutSec: msToSeconds(rooms.paymentSessionDurationMs),
            walletConnectionTimeoutMs:
                Number(rooms.walletConnectionDurationMs) || null,
            walletConnectionTimeoutSec: msToSeconds(
                rooms.walletConnectionDurationMs
            ),
            deployTimeoutMs: Number(rooms.gameContractDeployTimeoutMs) || null,
            deployTimeoutSec: msToSeconds(rooms.gameContractDeployTimeoutMs),
            gameStartAuthorizationMs:
                Number(rooms.gameStartAuthorizationDurationMs) || null,
            gameStartAuthorizationSec: msToSeconds(
                rooms.gameStartAuthorizationDurationMs
            ),
            resultSessionTimeoutMs: Number(rooms.resultSessionDurationMs) || null,
            resultSessionTimeoutSec: msToSeconds(rooms.resultSessionDurationMs),
            countdownDurationMs: Number(phases.readyDurationMs) || null,
            countdownDurationSec: msToSeconds(phases.readyDurationMs),
            preGameReadyDurationMs: Number(phases.preGameReadyDurationMs) || null,
            preGameReadyDurationSec: msToSeconds(phases.preGameReadyDurationMs),
            selfTestDurationMs: Number(phases.selfTestDurationMs) || null,
            selfTestDurationSec: msToSeconds(phases.selfTestDurationMs),
            speedDurationMs: Number(phases.speedDurationMs) || null,
            speedDurationSec: msToSeconds(phases.speedDurationMs),
            brakeDurationMs: Number(phases.brakeDurationMs) || null,
            brakeDurationSec: msToSeconds(phases.brakeDurationMs),
            resultPhaseDurationMs: Number(phases.resultDurationMs) || null,
            resultPhaseDurationSec: msToSeconds(phases.resultDurationMs)
        }),
        financial: Object.freeze({
            currencyLabel: "GRAM",
            baseStakesGram: Object.freeze(stakes),
            baseStake1Gram: stakes.includes(1) ? 1 : null,
            baseStake10Gram: stakes.includes(10) ? 10 : null,
            ownerFeeRate: Number.isFinite(feeRate) ? feeRate : null,
            ownerFeePercent: Number.isFinite(feeRate)
                ? Math.round(feeRate * 1000) / 10
                : null,
            secondSectorMultiplier: Number(PAYMENT_RULES.secondSectorMultiplier)
                || null,
            catalogCurrency: PAYMENT_RULES.currency ?? null
        }),
        wallets: Object.freeze({
            ownerWallet,
            deployWallet,
            reimbursementWallet,
            tonNetwork: ton.network ?? null,
            secrets: Object.freeze({
                ownerMnemonicExposed: false,
                deployerMnemonicConfigured: Boolean(ton.deployerMnemonic),
                reimbursementMnemonicConfigured: Boolean(
                    String(env.TON_REIMBURSEMENT_MNEMONIC ?? "").trim()
                ),
                note: "Mnemonics are never returned by this API."
            })
        })
    });

}
