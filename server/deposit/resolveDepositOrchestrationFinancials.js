/**
 * R17.9L.23 — Authoritative TON nanoton financial parameters for Deposit orchestration.
 *
 * DepositContract stakes/fees are TON nanoton (coins). They are NOT derived from
 * PaymentSession decimal GRM requiredGram. Mapping is explicit via env profile keys.
 */

import { isAllowedBaseStake } from "../models/PlayerProfileRules.js";
import {
    DepositOrchestratorError,
    DEPOSIT_ORCHESTRATOR_ERROR_CODES
} from "./DepositOrchestratorErrors.js";

const NANOTON_PATTERN = /^\d+$/;

function parsePositiveBigInt(raw, label) {

    if (raw == null) {

        return null;

    }

    if (typeof raw === "bigint") {

        return raw > 0n ? raw : null;

    }

    const text = String(raw).trim();

    if (!NANOTON_PATTERN.test(text)) {

        return null;

    }

    try {

        const value = BigInt(text);

        return value > 0n ? value : null;

    } catch {

        return null;

    }

}

function parseStakeNanotonMap(env) {

    const raw = env?.TON_DEPOSIT_STAKE_NANOTON_BY_PROFILE ?? null;

    if (!raw || typeof raw !== "string" || !raw.trim()) {

        return null;

    }

    let parsed;

    try {

        parsed = JSON.parse(raw);

    } catch {

        return null;

    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {

        return null;

    }

    const map = new Map();

    for (const [key, value] of Object.entries(parsed)) {

        const stake = parsePositiveBigInt(value, `stake:${key}`);

        if (!stake) {

            return null;

        }

        map.set(String(key), stake);

    }

    return map.size > 0 ? map : null;

}

function profileKey(baseStake, sectorCount) {

    return `${baseStake}:${sectorCount === 2 ? 2 : 1}`;

}

function resolveDepositTimeoutMs({
    env = process.env,
    runtimeOverrides = null,
    paymentDurationMs = null
} = {}) {

    const fromRuntime = Number(runtimeOverrides?.paymentTimeoutMs);

    if (Number.isFinite(fromRuntime) && fromRuntime > 0) {

        return fromRuntime;

    }

    const fromEnv = Number(env?.TON_DEPOSIT_TIMEOUT_MS);

    if (Number.isFinite(fromEnv) && fromEnv > 0) {

        return fromEnv;

    }

    const fromPayment = Number(paymentDurationMs);

    if (Number.isFinite(fromPayment) && fromPayment > 0) {

        return fromPayment;

    }

    return null;

}

/**
 * @returns {{
 *   creationFeePerSeat: bigint,
 *   depositTimeoutMs: number,
 *   network: string,
 *   resolveExpectedStakeNano: (identity: object) => bigint
 * }}
 */
export function resolveDepositOrchestrationFinancials({
    env = process.env,
    network = "testnet",
    runtimeOverrides = null,
    paymentDurationMs = null,
    stakeNanotonByProfile = null
} = {}) {

    const creationFeePerSeat = parsePositiveBigInt(
        env?.TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO,
        "creationFeePerSeat"
    );

    if (!creationFeePerSeat) {

        throw new DepositOrchestratorError(
            "TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO is required",
            DEPOSIT_ORCHESTRATOR_ERROR_CODES.FINANCIAL_CONFIG_UNAVAILABLE,
            { envKey: "TON_DEPOSIT_CREATION_FEE_PER_SEAT_NANO" }
        );

    }

    const depositTimeoutMs = resolveDepositTimeoutMs({
        env,
        runtimeOverrides,
        paymentDurationMs
    });

    if (!depositTimeoutMs) {

        throw new DepositOrchestratorError(
            "Deposit timeout is not configured",
            DEPOSIT_ORCHESTRATOR_ERROR_CODES.FINANCIAL_CONFIG_UNAVAILABLE,
            {
                sources: [
                    "runtimeOverrides.paymentTimeoutMs",
                    "TON_DEPOSIT_TIMEOUT_MS",
                    "paymentDurationMs"
                ]
            }
        );

    }

    const stakeMap = stakeNanotonByProfile instanceof Map
        ? stakeNanotonByProfile
        : parseStakeNanotonMap(env);

    if (!stakeMap) {

        throw new DepositOrchestratorError(
            "TON_DEPOSIT_STAKE_NANOTON_BY_PROFILE is required",
            DEPOSIT_ORCHESTRATOR_ERROR_CODES.FINANCIAL_CONFIG_UNAVAILABLE,
            { envKey: "TON_DEPOSIT_STAKE_NANOTON_BY_PROFILE" }
        );

    }

    const normalizedNetwork = String(network ?? "testnet").trim().toLowerCase();

    const resolveExpectedStakeNano = (identity) => {

        const baseStake = Number(identity?.baseStake);

        if (!isAllowedBaseStake(baseStake)) {

            throw new DepositOrchestratorError(
                "Player baseStake is not an allowed deposit profile",
                DEPOSIT_ORCHESTRATOR_ERROR_CODES.FINANCIAL_PROFILE_MISMATCH,
                { baseStake: identity?.baseStake }
            );

        }

        const sectorCount = identity?.sectorCount === 2 ? 2 : 1;
        const key = profileKey(baseStake, sectorCount);
        const stake = stakeMap.get(key);

        if (!stake) {

            throw new DepositOrchestratorError(
                "No nanoton stake mapping for player profile",
                DEPOSIT_ORCHESTRATOR_ERROR_CODES.FINANCIAL_CONFIG_UNAVAILABLE,
                { profileKey: key }
            );

        }

        return stake;

    };

    return Object.freeze({
        creationFeePerSeat,
        depositTimeoutMs,
        network: normalizedNetwork,
        resolveExpectedStakeNano
    });

}

export function resolveContractExpiresAtUnix(depositTimeoutMs, nowMs = Date.now()) {

    const timeoutMs = Number(depositTimeoutMs);

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {

        throw new DepositOrchestratorError(
            "depositTimeoutMs must be positive",
            DEPOSIT_ORCHESTRATOR_ERROR_CODES.FINANCIAL_CONFIG_UNAVAILABLE,
            { depositTimeoutMs }
        );

    }

    return BigInt(Math.floor(nowMs / 1000) + Math.ceil(timeoutMs / 1000));

}

export { profileKey, parsePositiveBigInt, parseStakeNanotonMap };
