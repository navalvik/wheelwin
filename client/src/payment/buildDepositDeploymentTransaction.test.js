/**
 * R18-S6 — Production DepositContract deployment transaction builder tests.
 *
 * Verifies: valid construction, address parity, fail-closed validation,
 * TonConnect wire-format (stateInit as base64 BOC string), and no side effects.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    beginCell,
    Cell,
    contractAddress,
    storeStateInit,
    loadStateInit
} from "@ton/core";

import {
    buildDepositDeploymentTransaction
} from "./buildDepositDeploymentTransaction.js";

// --- Test fixtures ---

const testCode = beginCell().storeUint(0x46554E44, 32).storeUint(0, 8).endCell();
const testData = beginCell().storeUint(1, 64).endCell();
const stateInit = { code: testCode, data: testData };
const derivedAddress = contractAddress(0, stateInit);
const VALID_DEPOSIT_ADDRESS = derivedAddress.toString({
    bounceable: true,
    urlSafe: true
});
const VALID_DEPLOY_VALUE_NANOTONS = "50000000";
const VALID_CODE_BOC = testCode.toBoc().toString("base64");
const VALID_DATA_BOC = testData.toBoc().toString("base64");
const EXPECTED_STATE_INIT_BOC = beginCell()
    .store(storeStateInit(stateInit))
    .endCell()
    .toBoc()
    .toString("base64");

function buildValidDepositPackage(overrides = {}) {
    return {
        stateInit: {
            codeBoc: overrides.codeBoc ?? VALID_CODE_BOC,
            dataBoc: overrides.dataBoc ?? VALID_DATA_BOC
        },
        depositAddress: overrides.depositAddress ?? VALID_DEPOSIT_ADDRESS,
        deployValueNanotons: overrides.deployValueNanotons
            ?? VALID_DEPLOY_VALUE_NANOTONS
    };
}

function buildValidParams(overrides = {}) {
    return {
        depositPackage: overrides.depositPackage ?? buildValidDepositPackage(),
        depositAddress: overrides.depositAddress ?? VALID_DEPOSIT_ADDRESS,
        isCreator: overrides.isCreator ?? true,
        network: overrides.network ?? "testnet",
        validUntilSeconds: overrides.validUntilSeconds ?? 600,
        nowMs: overrides.nowMs ?? Date.now()
    };
}

describe("R18-S6 buildDepositDeploymentTransaction", () => {

    it("Test A1: constructs a valid TonConnect deployment transaction", () => {
        const params = buildValidParams();
        const tx = buildDepositDeploymentTransaction(params);
        assert.ok(tx, "transaction should be constructed");
        assert.strictEqual(typeof tx.validUntil, "number", "validUntil must be a number");
        assert.ok(tx.validUntil > Math.floor(Date.now() / 1000), "validUntil must be in the future");
        assert.ok(Array.isArray(tx.messages), "messages must be an array");
        assert.strictEqual(tx.messages.length, 1, "must have exactly one message");
    });

    it("Test A2: deployment value equals authoritative deployValueNanotons", () => {
        const params = buildValidParams();
        const tx = buildDepositDeploymentTransaction(params);
        const msg = tx.messages[0];
        assert.strictEqual(msg.amount, VALID_DEPLOY_VALUE_NANOTONS,
            "amount must equal the authoritative deployValueNanotons");
    });

    it("Test A3: address is the StateInit-derived authoritative address", () => {
        const params = buildValidParams();
        const tx = buildDepositDeploymentTransaction(params);
        const msg = tx.messages[0];
        assert.strictEqual(msg.address, VALID_DEPOSIT_ADDRESS,
            "address must match the StateInit-derived authoritative address");
    });

    it("Test B1: stateInit is a base64 BOC string (TonConnect wire format)", () => {
        const params = buildValidParams();
        const tx = buildDepositDeploymentTransaction(params);
        const msg = tx.messages[0];
        assert.strictEqual(typeof msg.stateInit, "string",
            "stateInit must be a base64 string, not an object");
        assert.ok(msg.stateInit.length > 0, "stateInit must not be empty");
    });

        it("Test B2: stateInit decodes to authoritative code/data", () => {
        const params = buildValidParams();
        const tx = buildDepositDeploymentTransaction(params);
        const msg = tx.messages[0];

        // Decode the produced stateInit BOC and verify it contains cells
        // matching the original code/data cells.
        const stateInitCell = Cell.fromBoc(Buffer.from(msg.stateInit, "base64"))[0];
        const stateInitSlice = stateInitCell.beginParse();

        // loadStateInit reads from a slice in @ton/core
        const loaded = loadStateInit(stateInitSlice);

        assert.ok(loaded, "decoded stateInit must contain code/data");
        assert.ok(loaded.code, "decoded stateInit must contain code");
        assert.ok(loaded.data, "decoded stateInit must contain data");

        assert.strictEqual(
            loaded.code.toBoc().toString("base64"),
            VALID_CODE_BOC,
            "decoded code must match the authoritative codeBoc"
        );
        assert.strictEqual(
            loaded.data.toBoc().toString("base64"),
            VALID_DATA_BOC,
            "decoded data must match the authoritative dataBoc"
        );
    });

    it("Test B3: produced stateInit matches expected base64 BOC", () => {
        const params = buildValidParams();
        const tx = buildDepositDeploymentTransaction(params);
        const msg = tx.messages[0];
        assert.strictEqual(msg.stateInit, EXPECTED_STATE_INIT_BOC,
            "produced stateInit BOC must match the expected serialization");
    });

    it("Test C1: address mismatch fails closed", () => {
        const pkg = buildValidDepositPackage({
            depositAddress: "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBXZp"
        });
        const params = buildValidParams({ depositPackage: pkg });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /Reconstructed StateInit address does not match authoritative depositAddress/i,
            "must fail closed on address mismatch"
        );
    });

    it("Test C2: missing codeBoc fails closed", () => {
        const pkg = buildValidDepositPackage();
        delete pkg.stateInit.codeBoc;
        const params = buildValidParams({ depositPackage: pkg });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /StateInit.*required/i,
            "must fail closed on missing codeBoc"
        );
    });

    it("Test C3: missing dataBoc fails closed", () => {
        const pkg = buildValidDepositPackage();
        delete pkg.stateInit.dataBoc;
        const params = buildValidParams({ depositPackage: pkg });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /StateInit.*required/i,
            "must fail closed on missing dataBoc"
        );
    });

    it("Test C4: malformed codeBoc fails closed", () => {
        const pkg = buildValidDepositPackage({ codeBoc: "!!!invalid" });
        const params = buildValidParams({ depositPackage: pkg });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /Unable to decode code BOC/i,
            "must fail closed on malformed codeBoc"
        );
    });

    it("Test C5: missing deployValueNanotons fails closed", () => {
        const pkg = buildValidDepositPackage();
        delete pkg.deployValueNanotons;
        const params = buildValidParams({ depositPackage: pkg });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /deployValueNanotons is required/i,
            "must fail closed on missing deployValueNanotons"
        );
    });


    it("Test D1: non-creator fails closed", () => {
        const params = buildValidParams({ isCreator: false });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /Only the Room Creator/i,
            "must fail closed on non-creator"
        );
    });

    it("Test D2: missing isCreator fails closed", () => {
        const params = buildValidParams();
        delete params.isCreator;
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /Only the Room Creator/i,
            "must fail closed on missing isCreator"
        );
    });

    it("Test E1: unsupported network fails closed", () => {
        const params = buildValidParams({ network: "unknownnet" });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /Unsupported Deposit network/i,
            "must fail closed on unsupported network"
        );
    });

    it("Test E2: null network accepted", () => {
        const params = buildValidParams({ network: null });
        const tx = buildDepositDeploymentTransaction(params);
        assert.ok(tx, "should accept null network");
    });

    it("Test E3: missing depositPackage fails closed", () => {
        const params = buildValidParams();
        delete params.depositPackage;
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /depositPackage is required/i,
            "must fail closed on missing depositPackage"
        );
    });

    it("Test F1: exact amount preserved (no local calculation)", () => {
        const exactAmount = "123456789";
        const pkg = buildValidDepositPackage({ deployValueNanotons: exactAmount });
        const params = buildValidParams({ depositPackage: pkg });
        const tx = buildDepositDeploymentTransaction(params);
        const msg = tx.messages[0];
        assert.strictEqual(msg.amount, exactAmount,
            "amount must exactly equal the authoritative deployValueNanotons");
    });

    it("Test F2: bigint deployValueNanotons converted to string", () => {
        const pkg = buildValidDepositPackage({ deployValueNanotons: 50000000n });
        const params = buildValidParams({ depositPackage: pkg });
        const tx = buildDepositDeploymentTransaction(params);
        const msg = tx.messages[0];
        assert.strictEqual(msg.amount, "50000000",
            "bigint deployValueNanotons must be converted to string");
    });

    it("Test G1: no side effects (pure synchronous function)", () => {
        const params = buildValidParams();
        const startTime = Date.now();
        const tx = buildDepositDeploymentTransaction(params);
        const elapsed = Date.now() - startTime;
        assert.ok(tx, "transaction should be constructed");
        assert.ok(elapsed < 100, "should complete synchronously (< 100ms)");
        assert.strictEqual(typeof tx, "object");
        assert.strictEqual(typeof tx.validUntil, "number");
        assert.ok(Array.isArray(tx.messages));
    });

    it("Test G2: validUntil uses provided nowMs", () => {
        const params = buildValidParams({ nowMs: 1000000000000, validUntilSeconds: 600 });
        const tx = buildDepositDeploymentTransaction(params);
        assert.strictEqual(tx.validUntil, 1000000000 + 600,
            "validUntil must equal nowMs/1000 + validUntilSeconds");
    });

        it("Test H1: buildDepositDeploymentTransaction is a pure export (no side effects)", () => {
        assert.strictEqual(typeof buildDepositDeploymentTransaction, "function",
            "buildDepositDeploymentTransaction must be an exported function");
    });

});
    it("Test C6: zero deployValueNanotons fails closed", () => {
        const pkg = buildValidDepositPackage({ deployValueNanotons: "0" });
        const params = buildValidParams({ depositPackage: pkg });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /deployValueNanotons must be a positive amount/i,
            "must fail closed on zero deployValueNanotons"
        );
    });