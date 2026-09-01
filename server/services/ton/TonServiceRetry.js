/**
 * T2.2 — TonService retry and timeout helpers.
 */

import {
    ConnectionError,
    NetworkUnavailableError,
    RPCError,
    TimeoutError,
    TonServiceError
} from "./TonServiceErrors.js";

export const DEFAULT_TON_RETRY_POLICY = Object.freeze({
    maxAttempts: 3,
    initialDelayMs: 250,
    maxDelayMs: 2000,
    multiplier: 2,
    timeoutMs: 10_000
});

export function readHttpStatus(error) {

    const status = Number(
        error?.status
            ?? error?.response?.status
            ?? error?.details?.status
            ?? NaN
    );

    return Number.isFinite(status) ? status : null;

}

export function isInfrastructureFailure(error) {

    if (!error) {

        return false;

    }

    if (
        error instanceof ConnectionError
        || error instanceof NetworkUnavailableError
        || error instanceof TimeoutError
    ) {

        return true;

    }

    if (error instanceof RPCError) {

        return error.retryable === true;

    }

    if (error instanceof TonServiceError) {

        return false;

    }

    const status = readHttpStatus(error);

    if (
        status === 429
        || status === 502
        || status === 503
        || status === 504
    ) {

        return true;

    }

    const message = String(error?.message ?? error).toLowerCase();

    return message.includes("network")
        || message.includes("timeout")
        || message.includes("econn")
        || message.includes("fetch failed")
        || message.includes("http 5")
        || message.includes("http 429")
        || message.includes("status code 429")
        || message.includes("too many requests");

}

export function sleep(ms, signal = null) {

    if (!signal) {

        return new Promise((resolve) => setTimeout(resolve, ms));

    }

    return new Promise((resolve, reject) => {

        if (signal.aborted) {

            reject(new TimeoutError("TON operation cancelled"));

            return;

        }

        const timer = setTimeout(() => {

            cleanup();

            resolve();

        }, ms);

        const onAbort = () => {

            cleanup();

            reject(new TimeoutError("TON operation cancelled"));

        };

        const cleanup = () => {

            clearTimeout(timer);

            signal.removeEventListener("abort", onAbort);

        };

        signal.addEventListener("abort", onAbort, { once: true });

    });

}

export async function executeWithRetry({
    operation,
    retryPolicy = DEFAULT_TON_RETRY_POLICY,
    signal = null,
    shouldRetry = isInfrastructureFailure
}) {

    const maxAttempts = Math.max(1, Number(retryPolicy.maxAttempts) || 1);

    let attempt = 0;

    let delayMs = Number(retryPolicy.initialDelayMs) || 250;

    while (attempt < maxAttempts) {

        attempt += 1;

        try {

            return await runWithTimeout(
                operation,
                Number(retryPolicy.timeoutMs) || DEFAULT_TON_RETRY_POLICY.timeoutMs,
                signal
            );

        } catch (error) {

            const canRetry = attempt < maxAttempts && shouldRetry(error);

            if (!canRetry) {

                throw error;

            }

            await sleep(
                Math.min(
                    delayMs,
                    Number(retryPolicy.maxDelayMs) || DEFAULT_TON_RETRY_POLICY.maxDelayMs
                ),
                signal
            );

            delayMs *= Number(retryPolicy.multiplier) || 2;

        }

    }

    throw new NetworkUnavailableError("TON retry attempts exhausted");

}

async function runWithTimeout(operation, timeoutMs, signal = null) {

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {

        return operation();

    }

    if (signal?.aborted) {

        throw new TimeoutError("TON operation cancelled");

    }

    let timer = null;

    const timeoutPromise = new Promise((_, reject) => {

        timer = setTimeout(() => {

            reject(new TimeoutError("TON request timed out", { timeoutMs }));

        }, timeoutMs);

    });

    const abortPromise = signal
        ? new Promise((_, reject) => {

            if (signal.aborted) {

                reject(new TimeoutError("TON operation cancelled"));

                return;

            }

            signal.addEventListener("abort", () => {

                reject(new TimeoutError("TON operation cancelled"));

            }, { once: true });

        })
        : null;

    try {

        const operationPromise = Promise.resolve().then(operation);

        operationPromise.catch(() => {});

        const racers = [operationPromise, timeoutPromise];

        if (abortPromise) {

            racers.push(abortPromise);

        }

        return await Promise.race(racers);

    } finally {

        if (timer) {

            clearTimeout(timer);

        }

    }

}
