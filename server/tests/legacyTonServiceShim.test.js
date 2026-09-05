/**
 * R7.50 — legacyTonServiceShim.getSeqno TupleReader parsing.
 * R18 S48 — seqno RPC uses centralized TonService retry for TonCenter HTTP 429.
 */

import assert from "node:assert/strict";

import { Address, TupleReader } from "@ton/core";

import { TonGameContractAdapter } from "../payment/TonGameContractAdapter.js";
import { createLegacyTonServiceShim } from "../payment/ton/gameContract/legacyTonServiceShim.js";
import {
    beginTonDeployDebug,
    pushTonDeployDebugStage
} from "../diagnostics/DeployPipelineForensics.js";
import {
    DEFAULT_TON_RETRY_POLICY,
    formatTonRpcRetryLog,
    isInfrastructureFailure
} from "../services/ton/TonServiceRetry.js";

const DEPLOYER = "EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ";

const FAST_RETRY_POLICY = Object.freeze({
    maxAttempts: DEFAULT_TON_RETRY_POLICY.maxAttempts,
    initialDelayMs: 1,
    maxDelayMs: 5,
    multiplier: 1,
    timeoutMs: 1000
});

function createTonCenter429() {

    const error = new Error("TonCenter HTTP 429");

    error.status = 429;
    error.statusText = "Too Many Requests";
    error.responseBody = '{"ok":false,"result":"Ratelimit exceed","code":429}';

    return error;

}

/**
 * @ton/ton 16.3.0 HttpApi.doCall when axios returns HTTP 200 and
 * `data.ok === false` (TonCenter rate-limit body).
 */
function createTonClientReceivedError429() {

    return new Error(
        'Received error: {"ok":false,"result":"Ratelimit exceed","code":429}'
    );

}

function createAxios429() {

    const error = new Error("Request failed with status code 429");

    error.name = "AxiosError";
    error.status = 429;
    error.response = {
        status: 429,
        data: { ok: false, result: "Ratelimit exceed", code: 429 }
    };

    return error;

}

function createSeqnoStack(value) {

    return new TupleReader([
        { type: "int", value: BigInt(value) }
    ]);

}

function createShim(
    tonClient,
    retryPolicy = FAST_RETRY_POLICY,
    transport = null,
    onRetryObservability = null
) {

    return createLegacyTonServiceShim({
        transport: transport ?? {
            async sendBoc() {
                return { ok: true };
            },
            async getAddressInformation() {
                return { state: "active", balance: "500000000" };
            }
        },
        tonClient,
        tonConfig: { network: "testnet" },
        retryPolicy,
        onRetryObservability
    });

}

{
    const stack = createSeqnoStack(1);

    const tonClient = {
        async runMethod(address, method) {

            assert.equal(method, "seqno");
            assert.ok(address instanceof Address);

            return { stack };

        }
    };

    const shim = createShim(tonClient);
    const seqno = await shim.getSeqno(DEPLOYER);

    assert.equal(seqno, 1);
    console.log("  getSeqno TupleReader → 1: OK");
}

{
    // Regression: array index [0] must NOT be used (returns undefined → 0).
    const stack = createSeqnoStack(7);

    assert.equal(stack[0], undefined);

    const tonClient = {
        async runMethod() {
            return { stack };
        }
    };

    const shim = createShim(tonClient);
    const seqno = await shim.getSeqno(DEPLOYER);

    assert.equal(seqno, 7);
    assert.notEqual(seqno, 0);
    console.log("  getSeqno ignores stack[0] array path: OK");
}

{
    // Empty stack must throw — never silently return 0.
    const emptyStack = new TupleReader([]);

    const tonClient = {
        async runMethod() {
            return { stack: emptyStack };
        }
    };

    const shim = createShim(tonClient);

    await assert.rejects(
        () => shim.getSeqno(DEPLOYER),
        (error) => error instanceof Error
    );

    console.log("  getSeqno empty stack throws (no silent 0): OK");
}

{
    let calls = 0;

    const tonClient = {
        async runMethod() {

            calls += 1;

            if (calls === 1) {

                throw createTonCenter429();

            }

            return { stack: createSeqnoStack(11) };

        }
    };

    const shim = createShim(tonClient);
    const seqno = await shim.getSeqno(DEPLOYER);

    assert.equal(seqno, 11);
    assert.equal(calls, 2);
    console.log("  getSeqno retries once after HTTP 429 then succeeds: OK");
}

{
    let calls = 0;

    const tonClient = {
        async runMethod() {

            calls += 1;

            if (calls <= 2) {

                throw createTonCenter429();

            }

            return { stack: createSeqnoStack(22) };

        }
    };

    const shim = createShim(tonClient);
    const seqno = await shim.getSeqno(DEPLOYER);

    assert.equal(seqno, 22);
    assert.equal(calls, 3);
    console.log("  getSeqno retries twice after HTTP 429 then succeeds: OK");
}

{
    let calls = 0;

    const tonClient = {
        async runMethod() {

            calls += 1;
            throw createTonCenter429();

        }
    };

    const shim = createShim(tonClient);

    await assert.rejects(
        () => shim.getSeqno(DEPLOYER),
        (error) => {

            assert.equal(error.message, "TonCenter HTTP 429");
            assert.equal(error.status, 429);
            assert.equal(
                error.responseBody,
                '{"ok":false,"result":"Ratelimit exceed","code":429}'
            );
            return true;

        }
    );

    assert.equal(calls, FAST_RETRY_POLICY.maxAttempts);
    assert.equal(calls, DEFAULT_TON_RETRY_POLICY.maxAttempts);
    console.log("  getSeqno persistent HTTP 429 stops at retry limit: OK");
}

{
    let calls = 0;
    const permanent = new Error("BOC was not accepted");

    const tonClient = {
        async runMethod() {

            calls += 1;
            throw permanent;

        }
    };

    const shim = createShim(tonClient);

    await assert.rejects(
        () => shim.getSeqno(DEPLOYER),
        (error) => error === permanent
    );

    assert.equal(calls, 1);
    console.log("  getSeqno does not retry non-retryable errors: OK");
}

{
    let calls = 0;
    const stack = createSeqnoStack(4);

    const tonClient = {
        async runMethod(address, method) {

            calls += 1;
            assert.equal(method, "seqno");
            assert.ok(address instanceof Address);

            if (calls === 1) {

                throw createTonCenter429();

            }

            return { stack };

        }
    };

    const adapter = new TonGameContractAdapter({
        tonConfig: {
            network: "testnet",
            deployerMnemonic: null
        },
        transport: {
            async sendBoc() {
                return { ok: true };
            },
            async getAddressInformation() {
                return { state: "active" };
            }
        },
        tonClient
    });

    const seqno = await adapter._service().getSeqno(DEPLOYER);

    assert.equal(seqno, 4);
    assert.equal(calls, 2);
    assert.equal(adapter._service(), adapter._service());
    console.log("  TonGameContractAdapter legacy shim seqno retry compatible: OK");
}

{
    assert.equal(
        isInfrastructureFailure(createTonClientReceivedError429()),
        true
    );
    assert.equal(isInfrastructureFailure(createAxios429()), true);
    assert.equal(isInfrastructureFailure(createTonCenter429()), true);
    assert.equal(
        isInfrastructureFailure(
            new Error('Received error: {"ok":false,"exit_code":0}')
        ),
        false
    );
    console.log("  isInfrastructureFailure @ton/ton HttpApi 429 shape: OK");
}

{
    let calls = 0;

    const tonClient = {
        async runMethod() {

            calls += 1;

            if (calls <= 2) {

                throw createTonClientReceivedError429();

            }

            return { stack: createSeqnoStack(5) };

        }
    };

    const shim = createShim(tonClient);
    const seqno = await shim.getSeqno(DEPLOYER);

    assert.equal(seqno, 5);
    assert.equal(calls, 3);
    console.log("  getSeqno retries @ton/ton Received-error 429 then succeeds: OK");
}

{
    let calls = 0;

    const tonClient = {
        async runMethod() {

            calls += 1;
            throw createTonClientReceivedError429();

        }
    };

    const shim = createShim(tonClient);

    await assert.rejects(
        () => shim.getSeqno(DEPLOYER),
        (error) => error.message.includes("Ratelimit exceed")
    );

    assert.equal(calls, FAST_RETRY_POLICY.maxAttempts);
    console.log("  getSeqno @ton/ton 429 stops at retry limit: OK");
}

{
    let calls = 0;

    const transport = {
        async sendBoc() {
            return { ok: true };
        },
        async getAddressInformation() {

            calls += 1;

            if (calls === 1) {

                throw createTonCenter429();

            }

            return { state: "active", balance: "500000000" };

        }
    };

    const shim = createShim({ async runMethod() {} }, FAST_RETRY_POLICY, transport);
    const account = await shim.getAccount(DEPLOYER);

    assert.equal(account.balance, "500000000");
    assert.equal(calls, 2);
    console.log("  getAccount retries TonCenter HTTP 429 then succeeds: OK");
}

{
    let calls = 0;

    const transport = {
        async sendBoc() {
            return { ok: true };
        },
        async getAddressInformation() {

            calls += 1;
            throw createTonCenter429();

        }
    };

    const shim = createShim({ async runMethod() {} }, FAST_RETRY_POLICY, transport);

    await assert.rejects(
        () => shim.getAccount(DEPLOYER),
        (error) => error.status === 429 && error.message === "TonCenter HTTP 429"
    );

    assert.equal(calls, FAST_RETRY_POLICY.maxAttempts);
    console.log("  getAccount persistent HTTP 429 stops at retry limit: OK");
}

{
    const adapter = new TonGameContractAdapter({
        tonConfig: { network: "testnet", deployerMnemonic: null },
        transport: {
            async sendBoc() {
                return { ok: true };
            },
            async getAddressInformation() {
                return { state: "active", balance: "1" };
            }
        },
        tonClient: {
            async runMethod() {
                return { stack: createSeqnoStack(0) };
            }
        }
    });

    const service = adapter._service();

    assert.equal(typeof service.getBalance, "undefined");
    assert.equal(typeof service.getAccount, "function");
    assert.equal(typeof service.getSeqno, "function");
    console.log("  Production _service() is legacy shim (no getBalance): OK");
}

{
    const events = [];
    beginTonDeployDebug({
        roomId: "7dhz",
        gameId: "game_52d95bb4-6e79-4c99-8621-133c0e4c8c5c"
    });
    pushTonDeployDebugStage("WALLET_CREATED", { operation: "DEPLOY" });

    let calls = 0;
    const shim = createShim(
        {
            async runMethod() {
                calls += 1;
                throw createAxios429();
            }
        },
        FAST_RETRY_POLICY,
        null,
        (event) => events.push(event)
    );

    await assert.rejects(
        () => shim.getSeqno(DEPLOYER),
        (error) => error.name === "AxiosError" && error.status === 429
    );

    assert.equal(calls, DEFAULT_TON_RETRY_POLICY.maxAttempts);
    const attempts = events.filter((item) => item.kind === "attempt");
    const finals = events.filter((item) => item.kind === "final");
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts.map((item) => item.attempt), [1, 2, 3]);
    assert.equal(attempts.every((item) => item.operation === "getSeqno"), true);
    assert.equal(attempts.every((item) => item.retryable === true), true);
    assert.equal(attempts[0].willRetry, true);
    assert.equal(attempts[1].willRetry, true);
    assert.equal(attempts[2].willRetry, false);
    assert.equal(attempts.every((item) => item.status === 429), true);
    assert.equal(attempts.every((item) => item.errorName === "AxiosError"), true);
    assert.equal(attempts.every((item) => item.roomId === "7dhz"), true);
    assert.equal(
        attempts.every((item) => item.gameId === "game_52d95bb4-6e79-4c99-8621-133c0e4c8c5c"),
        true
    );
    assert.equal(attempts.every((item) => item.deployOperation === "DEPLOY"), true);
    assert.equal(finals.length, 1);
    assert.equal(finals[0].success, false);
    assert.equal(finals[0].attempt, 3);
    assert.equal(finals[0].status, 429);
    const line = formatTonRpcRetryLog(attempts[0]);
    assert.match(line, /^\[TON_RPC_RETRY_ATTEMPT\] /);
    assert.match(line, /operation=getSeqno/);
    assert.equal(line.includes("X-API-Key"), false);
    console.log("  getSeqno Axios 429 logs attempts 1-3 then FINAL failure: OK");
}

{
    const events = [];
    let calls = 0;
    const shim = createShim(
        {
            async runMethod() {
                calls += 1;
                if (calls === 1) {
                    throw createAxios429();
                }
                return { stack: createSeqnoStack(9) };
            }
        },
        FAST_RETRY_POLICY,
        null,
        (event) => events.push(event)
    );

    const seqno = await shim.getSeqno(DEPLOYER);

    assert.equal(seqno, 9);
    assert.equal(calls, 2);
    assert.equal(events.filter((item) => item.kind === "attempt").length, 1);
    assert.equal(events[0].attempt, 1);
    assert.equal(events[0].willRetry, true);
    assert.equal(events[1].kind, "final");
    assert.equal(events[1].success, true);
    assert.equal(events[1].attempt, 2);
    console.log("  getSeqno Axios 429 then success logs FINAL success: OK");
}

{
    const events = [];
    let calls = 0;
    const permanent = new Error("BOC was not accepted");
    const shim = createShim(
        {
            async runMethod() {
                calls += 1;
                throw permanent;
            }
        },
        FAST_RETRY_POLICY,
        null,
        (event) => events.push(event)
    );

    await assert.rejects(() => shim.getSeqno(DEPLOYER), (error) => error === permanent);

    assert.equal(calls, 1);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, "attempt");
    assert.equal(events[0].retryable, false);
    assert.equal(events[0].willRetry, false);
    assert.equal(events[1].kind, "final");
    assert.equal(events[1].success, false);
    assert.equal(events[1].retryable, false);
    console.log("  getSeqno non-retryable error logs one attempt and FINAL: OK");
}

console.log("legacyTonServiceShim.getSeqno R7.50 + R18 S48/S50 retry: all passed");
