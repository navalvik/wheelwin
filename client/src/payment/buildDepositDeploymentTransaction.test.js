import assert from "node:assert/strict";
import { Cell, contractAddress, beginCell, toNano } from "@ton/core";
import { buildDepositDeploymentTransaction } from "./buildDepositDeploymentTransaction.js";

const VALID_CODE_BOC = beginCell().storeUint(0x46554E44, 32).storeUint(0, 8).endCell().toBoc().toString("base64");
const VALID_DATA_BOC = beginCell().storeUint(1, 64).endCell().toBoc().toString("base64");
const VALID_DEPLOY_VALUE_NANOTONS = toNano("0.05").toString();

function buildValidDepositPackage(overrides = {}) {
    const codeBoc = overrides.codeBoc ?? VALID_CODE_BOC;
    const dataBoc = overrides.dataBoc ?? VALID_DATA_BOC;
    const code = Cell.fromBoc(Buffer.from(codeBoc, "base64"))[0];
    const data = Cell.fromBoc(Buffer.from(dataBoc, "base64"))[0];
    const address = contractAddress(0, { code, data });
    return {
        stateInit: { codeBoc, dataBoc },
        depositAddress: overrides.depositAddress ?? address.toString({ bounceable: true, urlSafe: true }),
        deployValueNanotons: overrides.deployValueNanotons ?? VALID_DEPLOY_VALUE_NANOTONS
    };
}

function buildValidParams(overrides = {}) {
    return {
        depositPackage: overrides.depositPackage ?? buildValidDepositPackage(),
        depositAddress: overrides.depositAddress ?? buildValidDepositPackage().depositAddress,
        isCreator: overrides.isCreator ?? true,
        network: overrides.network ?? "testnet",
        validUntilSeconds: overrides.validUntilSeconds ?? 600,
        nowMs: overrides.nowMs ?? Date.now()
    };

describe("R18-S6 buildDepositDeploymentTransaction", () => {

    it("constructs a valid TonConnect transaction", () => {
        const params = buildValidParams();
        const tx = buildDepositDeploymentTransaction(params);

        assert.ok(tx, "transaction should be constructed");
        assert.ok(typeof tx.validUntil === "number");
        assert.ok(tx.validUntil > Math.floor(Date.now() / 1000));
        assert.ok(Array.isArray(tx.messages));
        assert.strictEqual(tx.messages.length, 1);

        const msg = tx.messages[0];
        assert.ok(typeof msg.address === "string");
        assert.ok(msg.address.startsWith("EQ") || msg.address.startsWith("kQ"));
        assert.ok(typeof msg.amount === "string");
        assert.strictEqual(msg.amount, VALID_DEPLOY_VALUE_NANOTONS);
        assert.ok(msg.stateInit);
        assert.strictEqual(msg.stateInit.code, VALID_CODE_BOC);
        assert.strictEqual(msg.stateInit.data, VALID_DATA_BOC);
    });

    it("derives the correct address from StateInit and matches depositAddress", () => {
        const pkg = buildValidDepositPackage();
        const params = buildValidParams({ depositPackage: pkg });
        const tx = buildDepositDeploymentTransaction(params);
        const msg = tx.messages[0];

        assert.strictEqual(msg.address, pkg.depositAddress,
            "transaction address must match the authoritative depositAddress");
    });

    it("rejects when StateInit-derived address does not match depositAddress", () => {
        const pkg = buildValidDepositPackage({
            depositAddress: "EQBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBXZp"
        });
        const params = buildValidParams({
            depositPackage: pkg,
            depositAddress: pkg.depositAddress
        });

        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /Reconstructed StateInit address does not match authoritative depositAddress/i,
            "must fail closed on address mismatch"
        );
    });

    it("rejects non-creator (isCreator=false)", () => {
        const params = buildValidParams({ isCreator: false });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /Only the Room Creator/i,
            "must reject non-creator"
        );
    });

    it("rejects missing codeBoc", () => {
        const pkg = buildValidDepositPackage();
        delete pkg.stateInit.codeBoc;
        const params = buildValidParams({ depositPackage: pkg });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /StateInit.*required/i,
            "must fail closed on missing codeBoc"
        );
    });

    it("rejects invalid base64 codeBoc", () => {
        const pkg = buildValidDepositPackage({ codeBoc: "not-valid-base64!!!" });
        const params = buildValidParams({ depositPackage: pkg });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /Unable to decode code BOC/i,
            "must fail closed on malformed codeBoc"
        );
    });

    it("rejects missing depositAddress", () => {
        const pkg = buildValidDepositPackage();
        delete pkg.depositAddress;
        const params = buildValidParams({ depositPackage: pkg });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /depositAddress is required/i,
            "must fail closed on missing depositAddress"
        );
    });

    it("rejects missing deployValueNanotons", () => {
        const pkg = buildValidDepositPackage();
        delete pkg.deployValueNanotons;
        const params = buildValidParams({ depositPackage: pkg });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /deployValueNanotons is required/i,
            "must fail closed on missing deployValueNanotons"
        );
    });

    it("rejects unsupported network", () => {
        const params = buildValidParams({ network: "unknownnet" });
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /Unsupported Deposit network/i,
            "must fail closed on unsupported network"
        );
    });

    it("constructs transaction synchronously without external calls", () => {
        const params = buildValidParams();
        const startTime = Date.now();
        const tx = buildDepositDeploymentTransaction(params);
        const elapsed = Date.now() - startTime;

        assert.ok(tx, "transaction should be constructed");
        assert.ok(elapsed < 100, "should complete synchronously (< 100ms)");
    });

    it("rejects missing depositPackage", () => {
        const params = buildValidParams();
        delete params.depositPackage;
        assert.throws(
            () => buildDepositDeploymentTransaction(params),
            /depositPackage is required/i,
            "must fail closed on missing depositPackage"
        );
    });

    it("uses the exact authoritative deployValueNanotons", () => {
        const exactAmount = "50000000";
        const pkg = buildValidDepositPackage({ deployValueNanotons: exactAmount });
        const params = buildValidParams({ depositPackage: pkg });
        const tx = buildDepositDeploymentTransaction(params);
        const msg = tx.messages[0];

        assert.strictEqual(msg.amount, exactAmount,
            "transaction amount must exactly equal the authoritative deployValueNanotons");
    });

});
}
