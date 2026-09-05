/**
 * T2.2 — TonService retry and timeout helpers.
 */

import { getTonDeployDebug } from "../../diagnostics/DeployPipelineForensics.js";
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
        || message.includes("too many requests")
        // @ton/ton 16.3.x HttpApi.doCall: HTTP 200 + { ok:false, code:429 }
        || message.includes("ratelimit exceed")
        || (
            message.includes("received error:")
            && message.includes("429")
        );

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

function truncateRetryMessage(error) {

    const text = String(error?.message ?? error ?? "").replace(/\s+/g, " ").trim();

    if (text.length <= 160) {

        return text || null;

    }

    return `${text.slice(0, 160)}…`;

}

function attachDeployCorrelation(event) {

    let debug = null;

    try {

        debug = getTonDeployDebug();

    } catch {

        debug = null;

    }

    return {
        ...event,
        roomId: event.roomId ?? debug?.roomId ?? null,
        gameId: event.gameId ?? debug?.gameId ?? null,
        deployOperation: event.deployOperation ?? debug?.operation ?? null
    };

}

/**
 * Single-line Railway-visible retry observability. No bodies, headers, or secrets.
 *
 * @param {object} event
 * @returns {string}
 */
export function formatTonRpcRetryLog(event) {

    const kind = event?.kind === "final"
        ? "TON_RPC_RETRY_FINAL"
        : "TON_RPC_RETRY_ATTEMPT";

    const fields = [
        `operation=${event?.operation ?? "rpc"}`,
        `attempt=${event?.attempt ?? null}`,
        `maxAttempts=${event?.maxAttempts ?? null}`
    ];

    if (event?.kind === "final") {

        fields.push(`success=${event?.success === true}`);

    }

    if (typeof event?.retryable === "boolean") {

        fields.push(`retryable=${event.retryable}`);

    }

    if (typeof event?.willRetry === "boolean") {

        fields.push(`willRetry=${event.willRetry}`);

    }

    if (event?.status != null) {

        fields.push(`status=${event.status}`);

    }

    if (event?.errorName) {

        fields.push(`errorName=${event.errorName}`);

    }

    if (event?.errorMessage) {

        fields.push(`errorMessage=${event.errorMessage}`);

    }

    if (event?.willRetry === true && Number.isFinite(Number(event?.delayMs))) {

        fields.push(`delayMs=${Number(event.delayMs)}`);

    }

    if (event?.roomId) {

        fields.push(`roomId=${event.roomId}`);

    }

    if (event?.gameId) {

        fields.push(`gameId=${event.gameId}`);

    }

    if (event?.deployOperation) {

        fields.push(`deployOperation=${event.deployOperation}`);

    }

    return `[${kind}] ${fields.join(" | ")}`;

}

function emitTonRpcRetryObservability(event, sink) {

    const payload = Object.freeze(attachDeployCorrelation(event));
    const line = formatTonRpcRetryLog(payload);

    if (typeof sink === "function") {

        sink(payload, line);

        return;

    }

    console.log(line);

}

export async function executeWithRetry({
    operation,
    retryPolicy = DEFAULT_TON_RETRY_POLICY,
    signal = null,
    shouldRetry = isInfrastructureFailure,
    operationName = "rpc",
    onRetryObservability = null
}) {

    const maxAttempts = Math.max(1, Number(retryPolicy.maxAttempts) || 1);

    let attempt = 0;

    let delayMs = Number(retryPolicy.initialDelayMs) || 250;

    while (attempt < maxAttempts) {

        attempt += 1;

        try {

            const result = await runWithTimeout(
                operation,
                Number(retryPolicy.timeoutMs) || DEFAULT_TON_RETRY_POLICY.timeoutMs,
                signal
            );

            if (attempt > 1) {

                emitTonRpcRetryObservability({
                    kind: "final",
                    operation: operationName,
                    attempt,
                    maxAttempts,
                    success: true,
                    retryable: true,
                    willRetry: false,
                    status: null,
                    errorName: null,
                    errorMessage: null,
                    delayMs: null
                }, onRetryObservability);

            }

            return result;

        } catch (error) {

            const retryable = shouldRetry(error);
            const canRetry = attempt < maxAttempts && retryable;
            const status = readHttpStatus(error);
            const nextDelayMs = Math.min(
                delayMs,
                Number(retryPolicy.maxDelayMs) || DEFAULT_TON_RETRY_POLICY.maxDelayMs
            );

            emitTonRpcRetryObservability({
                kind: "attempt",
                operation: operationName,
                attempt,
                maxAttempts,
                success: false,
                retryable,
                willRetry: canRetry,
                status,
                errorName: error?.name ?? null,
                errorMessage: truncateRetryMessage(error),
                delayMs: canRetry ? nextDelayMs : null
            }, onRetryObservability);

            if (!canRetry) {

                emitTonRpcRetryObservability({
                    kind: "final",
                    operation: operationName,
                    attempt,
                    maxAttempts,
                    success: false,
                    retryable,
                    willRetry: false,
                    status,
                    errorName: error?.name ?? null,
                    errorMessage: truncateRetryMessage(error),
                    delayMs: null
                }, onRetryObservability);

                throw error;

            }

            await sleep(
                nextDelayMs,
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
