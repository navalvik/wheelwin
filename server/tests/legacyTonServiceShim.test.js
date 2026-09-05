/**
 * R7.50 — legacyTonServiceShim.getSeqno TupleReader parsing.
 * R18 S48 — seqno RPC uses centralized TonService retry for TonCenter HTTP 429.
 */

import assert from "node:assert/strict";

import { Address, TupleReader } from "@ton/core";

import { TonGameContractAdapter } from "../payment/TonGameContractAdapter.js";
import { createLegacyTonServiceShim } from "../payment/ton/gameContract/legacyTonServiceShim.js";
import { DEFAULT_TON_RETRY_POLICY } from "../services/ton/TonServiceRetry.js";

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

function createSeqnoStack(value) {

    return new TupleReader([
        { type: "int", value: BigInt(value) }
    ]);

}

function createShim(tonClient, retryPolicy = FAST_RETRY_POLICY) {

    return createLegacyTonServiceShim({
        transport: {
            async sendBoc() {
                return { ok: true };
            },
            async getAddressInformation() {
                return { state: "active" };
            }
        },
        tonClient,
        tonConfig: { network: "testnet" },
        retryPolicy
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

console.log("legacyTonServiceShim.getSeqno R7.50 + R18 S48 retry: all passed");
