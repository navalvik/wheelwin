/**
 * R7.50 — legacyTonServiceShim.getSeqno TupleReader parsing.
 */

import assert from "node:assert/strict";

import { Address, TupleReader } from "@ton/core";

import { createLegacyTonServiceShim } from "../payment/ton/gameContract/legacyTonServiceShim.js";

const DEPLOYER = "EQB83s9XMOMseDFxyXxj4hrC0sS4FB4xhdNiUPkl_3zx3PDQ";

function createShim(tonClient) {

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
        tonConfig: { network: "testnet" }
    });

}

{
    const stack = new TupleReader([
        { type: "int", value: 1n }
    ]);

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
    const stack = new TupleReader([
        { type: "int", value: 7n }
    ]);

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

console.log("legacyTonServiceShim.getSeqno R7.50: all passed");
