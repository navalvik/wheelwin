/**
 * R17.9L.25.I.2.A — TEST-ONLY RPC retry for L25 harness read paths.
 * Does not modify production TonService / deposit coordinators.
 */

import { L25_ERROR_CODES, L25TestError } from "./l25Errors.js";

export const L25_RPC_RETRY_POLICY = Object.freeze({
    maxAttempts: 5,
    initialDelayMs: 2_000,
    maxDelayMs: 32_000,
    multiplier: 2
});

function sleep(ms) {

    return new Promise((resolve) => setTimeout(resolve, ms));

}

/**
 * Classify transient TonCenter / network failures that L25 may retry.
 */
export function isL25TransientRpcError(error) {

    if (!error) {

        return false;

    }

    if (error instanceof L25TestError) {

        return error.code === L25_ERROR_CODES.TIMEOUT
            || error.code === L25_ERROR_CODES.PHASE_FAILED
                && /timeout|429|rate.?limit|ECONNRESET|503|502|network/i
                    .test(String(error.message ?? ""));

    }

    const message = String(error?.message ?? error ?? "");
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);

    if (status === 429 || status === 502 || status === 503 || status === 504) {

        return true;

    }

    if (error?.retryable === true) {

        return true;

    }

    return /timeout|timed out|HTTP 429|429|rate.?limit|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|network|503|502|504|Too Many Requests/i
        .test(message);

}

function nextDelayMs(attemptIndex, policy) {

    const raw = policy.initialDelayMs * (policy.multiplier ** attemptIndex);

    return Math.min(policy.maxDelayMs, Math.max(policy.initialDelayMs, raw));

}

/**
 * Retry a read-only L25 RPC operation on transient failures only.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{
 *   operationName?: string,
 *   policy?: typeof L25_RPC_RETRY_POLICY,
 *   logger?: { warn?: Function }
 * }} [options]
 * @returns {Promise<T>}
 */
export async function l25WithRpcRetry(operation, {
    operationName = "rpc",
    policy = L25_RPC_RETRY_POLICY,
    logger = null
} = {}) {

    if (typeof operation !== "function") {

        throw new L25TestError(
            "l25WithRpcRetry requires an operation function",
            L25_ERROR_CODES.PHASE_FAILED
        );

    }

    const maxAttempts = Math.max(1, Number(policy.maxAttempts) || 5);
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {

        try {

            return await operation();

        } catch (error) {

            lastError = error;

            const transient = isL25TransientRpcError(error);

            if (!transient || attempt >= maxAttempts) {

                throw error;

            }

            const delayMs = nextDelayMs(attempt - 1, policy);
            const errorLabel = error?.status
                ?? error?.statusCode
                ?? error?.code
                ?? (error?.message ?? String(error)).slice(0, 120);

            const line = `[L25 RPC RETRY] operation=${operationName} attempt=${attempt}/${maxAttempts} error=${errorLabel} nextRetryMs=${delayMs}`;

            if (typeof logger?.warn === "function") {

                logger.warn(line);

            } else {

                process.stderr.write(`${line}\n`);

            }

            await sleep(delayMs);

        }

    }

    throw lastError;

}

export { sleep as l25Sleep };
