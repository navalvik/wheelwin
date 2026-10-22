import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { makeNativeRefundV4Boc } from "./fixtures/nativeRefundV4BocFixture.js";
import { verifyWalletV4RefundEd25519 } from "../payment/refund/WalletV4RefundEd25519.js";

const { publicKey } = generateKeyPairSync("ed25519");
const key = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");

test("dummy-signature Wallet V4 fixture is rejected even with a valid Ed25519 key", () => {
    const boc = makeNativeRefundV4Boc().toString("base64");
    assert.equal(verifyWalletV4RefundEd25519({ boc, publicKeyHex: key }), false);
});

test("invalid BOC and invalid trusted key fail closed", () => {
    const boc = makeNativeRefundV4Boc().toString("base64");
    assert.equal(verifyWalletV4RefundEd25519({ boc, publicKeyHex: "00" }), false);
    assert.equal(verifyWalletV4RefundEd25519({ boc: "not-a-boc", publicKeyHex: key }), false);
    assert.equal(verifyWalletV4RefundEd25519({ boc: "", publicKeyHex: key }), false);
    assert.equal(verifyWalletV4RefundEd25519({ boc, publicKeyHex: null }), false);
});
