import test from "node:test";
import assert from "node:assert/strict";
import { Address } from "@ton/core";
import { isValidPage3WalletAddress, restorePage3WalletAddress } from "./page3WalletAddress.js";

const address = new Address(0, Buffer.alloc(32, 0x2a));
const friendly = (options) => address.toString({ urlSafe: true, ...options });

const mainnetBounceable = friendly({ bounceable: true, testOnly: false });
const mainnetNonBounceable = friendly({ bounceable: false, testOnly: false });
const testnetBounceable = friendly({ bounceable: true, testOnly: true });
const testnetNonBounceable = friendly({ bounceable: false, testOnly: true });

test("Mainnet Page3 accepts checksum-valid EQ and UQ addresses", () => {
    assert.match(mainnetBounceable, /^EQ/);
    assert.match(mainnetNonBounceable, /^UQ/);
    assert.equal(isValidPage3WalletAddress(mainnetBounceable, "mainnet"), true);
    assert.equal(isValidPage3WalletAddress(mainnetNonBounceable, "mainnet"), true);
});

test("Mainnet Page3 rejects test-only 0Q and kQ addresses", () => {
    assert.match(testnetBounceable, /^kQ/);
    assert.match(testnetNonBounceable, /^0Q/);
    assert.equal(isValidPage3WalletAddress(testnetBounceable, "mainnet"), false);
    assert.equal(isValidPage3WalletAddress(testnetNonBounceable, "mainnet"), false);
});

test("Mainnet Page3 rejects bad checksums and malformed wallet strings", () => {
    const badChecksum = `${mainnetBounceable.slice(0, -1)}${mainnetBounceable.endsWith("A") ? "B" : "A"}`;
    assert.equal(isValidPage3WalletAddress(badChecksum, "mainnet"), false);
    assert.equal(isValidPage3WalletAddress("not-a-ton-address", "mainnet"), false);
    assert.equal(isValidPage3WalletAddress(`0:${"a".repeat(64)}`, "mainnet"), false);
});

test("Testnet Page3 keeps its existing raw and friendly format behavior", () => {
    assert.equal(isValidPage3WalletAddress(`0:${"a".repeat(64)}`, "testnet"), true);
    assert.equal(isValidPage3WalletAddress(testnetBounceable, "testnet"), true);
    assert.equal(isValidPage3WalletAddress(mainnetBounceable, "testnet"), true);
});

test("Page3 recovery restores canonical Mainnet identities as accepted friendly addresses", () => {
    const raw = address.toRawString();
    const restored = restorePage3WalletAddress(raw, "mainnet");
    assert.match(restored, /^UQ/);
    assert.equal(isValidPage3WalletAddress(restored, "mainnet"), true);
    assert.equal(restorePage3WalletAddress(testnetNonBounceable, "mainnet"), testnetNonBounceable);
    assert.equal(restorePage3WalletAddress(raw, "testnet"), raw);
    assert.equal(isValidPage3WalletAddress(restorePage3WalletAddress(raw, "testnet"), "testnet"), true);
});
