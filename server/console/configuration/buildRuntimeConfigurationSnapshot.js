/**
 * R17.9G / R17.9G.1 — Runtime Configuration snapshot for Developer Console.
 *
 * Observes authoritative loaders / catalogs + durable overrides.
 * Never returns mnemonics or private keys.
 * Viewer responses redact editable fields.
 */

import { OwnerConfiguration } from "../../config/OwnerConfiguration.js";
import { PAYMENT_RULES } from "../../catalog/PaymentRules.js";
import { STAKES } from "../../catalog/Stakes.js";
import {
    resolveResiduesWalletDestination
} from "../../payment/roomWallet/ResiduesWalletConfig.js";
import {
    DEFAULT_SETTLEMENT_TIMEOUT_MS,
    RUNTIME_CONFIG_EDITABLE_KEYS
} from "./runtimeConfigurationKeys.js";

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
 * @param {number|null|undefined} override
 * @param {number|null|undefined} fallback
 * @returns {number|null}
 */
function pickMs(override, fallback) {

    if (Number.isFinite(Number(override)) && Number(override) > 0) {

        return Number(override);

    }

    if (Number.isFinite(Number(fallback)) && Number(fallback) > 0) {

        return Number(fallback);

    }

    return null;

}

/**
 * Build runtime configuration DTO for GET /console/configuration/runtime.
 *
 * @param {{
 *   runtimeConfig?: {
 *     rooms?: object,
 *     gameplayPhases?: object,
 *     ton?: object
 *   }|null,
 *   env?: NodeJS.ProcessEnv,
 *   overrides?: Record<string, number>|null,
 *   configVersion?: number|null,
 *   canEdit?: boolean,
 *   settlementTimeoutMsDefault?: number|null
 * }} [options]
 * @returns {object}
 */
export function buildRuntimeConfigurationSnapshot({
    runtimeConfig = null,
    env = process.env,
    overrides = null,
    configVersion = null,
    canEdit = false,
    settlementTimeoutMsDefault = DEFAULT_SETTLEMENT_TIMEOUT_MS
} = {}) {

    const rooms = runtimeConfig?.rooms ?? {};
    const phases = runtimeConfig?.gameplayPhases ?? {};
    const ton = runtimeConfig?.ton ?? {};
    const ov = overrides && typeof overrides === "object" ? overrides : {};

    let ownerWallet = null;

    try {

        if (OwnerConfiguration.isLoaded()) {

            ownerWallet = safeAddress(OwnerConfiguration.getOwnerWallet());

        }

    } catch {

        ownerWallet = null;

    }

    const deployWallet = safeAddress(ton.deployerExpectedAddress);
    const residuesDestination = resolveResiduesWalletDestination(env);
    const residuesWallet = residuesDestination.ok
        ? safeAddress(residuesDestination.address)
        : null;
    const reimbursementWallet = residuesWallet;

    const catalogStakes = Array.isArray(STAKES) ? [...STAKES] : [];
    const stake1 = Number.isFinite(Number(ov.baseStake1Gram))
        ? Number(ov.baseStake1Gram)
        : (catalogStakes[0] ?? null);
    const stake2 = Number.isFinite(Number(ov.baseStake2Gram))
        ? Number(ov.baseStake2Gram)
        : (catalogStakes[1] ?? null);

    const catalogFeeRate = Number(PAYMENT_RULES.platformFeeRate);
    const ownerFeePercent = Number.isFinite(Number(ov.ownerFeePercent))
        ? Number(ov.ownerFeePercent)
        : (Number.isFinite(catalogFeeRate)
            ? Math.round(catalogFeeRate * 1000) / 10
            : null);
    const ownerFeeRate = Number.isFinite(ownerFeePercent)
        ? ownerFeePercent / 100
        : (Number.isFinite(catalogFeeRate) ? catalogFeeRate : null);

    const setupTimeoutMs = pickMs(ov.setupTimeoutMs, rooms.setupDurationMs);
    const paymentTimeoutMs = pickMs(
        ov.paymentTimeoutMs,
        rooms.paymentSessionDurationMs
    );
    const countdownDurationMs = pickMs(
        ov.countdownDurationMs,
        phases.readyDurationMs
    );
    const brakeDurationMs = pickMs(ov.brakeDurationMs, phases.brakeDurationMs);
    const settlementTimeoutMs = pickMs(
        ov.settlementTimeoutMs,
        settlementTimeoutMsDefault
    );

    const wallets = Object.freeze({
        ownerWallet,
        deployWallet,
        residuesWallet,
        reimbursementWallet,
        tonNetwork: ton.network ?? null,
        readOnly: true,
        secrets: Object.freeze({
            ownerMnemonicExposed: false,
            deployerMnemonicConfigured: Boolean(ton.deployerMnemonic),
            residuesMnemonicConfigured: Boolean(
                String(env.TON_RESIDUES_MNEMONIC ?? "").trim()
                || String(env.TON_REIMBURSEMENT_MNEMONIC ?? "").trim()
            ),
            reimbursementMnemonicConfigured: Boolean(
                String(env.TON_REIMBURSEMENT_MNEMONIC ?? "").trim()
            ),
            note: "Mnemonics are never returned by this API."
        })
    });

    // Viewer: hide editable values completely; wallets remain visible (read-only).
    if (!canEdit) {

        return Object.freeze({
            schemaVersion: 1,
            readOnly: true,
            canEdit: false,
            generatedAt: Date.now(),
            configVersion: configVersion ?? null,
            applyScope: "next_game_initialization_only",
            notes: Object.freeze({
                access:
                    "Editable Runtime Configuration values require Administrator.",
                wallets: "Wallet addresses are read-only infrastructure pins."
            }),
            timers: null,
            financial: null,
            wallets,
            editable: Object.freeze([])
        });

    }

    const stakes = [stake1, stake2].filter((n) => Number.isFinite(n));

    return Object.freeze({
        schemaVersion: 1,
        readOnly: false,
        canEdit: true,
        generatedAt: Date.now(),
        configVersion: configVersion ?? null,
        applyScope: "next_game_initialization_only",
        notes: Object.freeze({
            verifyTimeout:
                "No separate VERIFY_DURATION_MS. VERIFY rides the Setup Timer.",
            countdown:
                "Displayed as READY phase duration (server GameClock READY).",
            settlementTimeout:
                "SettlementTimeout applies to future settlements only.",
            mutation:
                "Changes apply to the next GAME_INITIALIZED snapshot only."
        }),
        editable: Object.freeze([...RUNTIME_CONFIG_EDITABLE_KEYS]),
        timers: Object.freeze({
            setupTimeoutMs,
            setupTimeoutSec: msToSeconds(setupTimeoutMs),
            verifyTimeoutMs: setupTimeoutMs,
            verifyTimeoutSec: msToSeconds(setupTimeoutMs),
            verifyTimeoutSource: "setupTimeout",
            verifyEditable: false,
            paymentTimeoutMs,
            paymentTimeoutSec: msToSeconds(paymentTimeoutMs),
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
            countdownDurationMs,
            countdownDurationSec: msToSeconds(countdownDurationMs),
            preGameReadyDurationMs: Number(phases.preGameReadyDurationMs) || null,
            preGameReadyDurationSec: msToSeconds(phases.preGameReadyDurationMs),
            selfTestDurationMs: Number(phases.selfTestDurationMs) || null,
            selfTestDurationSec: msToSeconds(phases.selfTestDurationMs),
            speedDurationMs: Number(phases.speedDurationMs) || null,
            speedDurationSec: msToSeconds(phases.speedDurationMs),
            brakeDurationMs,
            brakeDurationSec: msToSeconds(brakeDurationMs),
            settlementTimeoutMs,
            settlementTimeoutSec: msToSeconds(settlementTimeoutMs),
            resultPhaseDurationMs: Number(phases.resultDurationMs) || null,
            resultPhaseDurationSec: msToSeconds(phases.resultDurationMs)
        }),
        financial: Object.freeze({
            currencyLabel: "GRAM",
            baseStakesGram: Object.freeze(stakes),
            baseStake1Gram: stake1,
            baseStake2Gram: stake2,
            // Legacy alias for R17.9G UI compatibility.
            baseStake10Gram: stake2,
            ownerFeeRate,
            ownerFeePercent,
            secondSectorMultiplier: Number(PAYMENT_RULES.secondSectorMultiplier)
                || null,
            catalogCurrency: PAYMENT_RULES.currency ?? null
        }),
        wallets
    });

}
