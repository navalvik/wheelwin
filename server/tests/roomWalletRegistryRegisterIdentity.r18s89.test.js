/**
 * r18-s89 — RoomWalletRegistry.register() identity-hardening regression.
 * No live TON. No secrets in assertions or logs.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { Address } from "@ton/core";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";

function v4Address(seedLabel) {
    const seed = createHash("sha256").update(seedLabel).digest();
    const keyPair = keyPairFromSeed(seed);
    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address;
}

function forms(address) {
    return {
        eq: address.toString({ bounceable: true, urlSafe: true }),
        uq: address.toString({ bounceable: false, urlSafe: true }),
        kq: address.toString({ bounceable: true, urlSafe: true, testOnly: true }),
        zq: address.toString({ bounceable: false, urlSafe: true, testOnly: true }),
        eqUnsafe: address.toString({ bounceable: true, urlSafe: false })
    };
}

test("register() canonicalizes address to bounceable URL-safe friendly on storage", () => {
    const addr = v4Address("s89-store");
    const variants = forms(addr);

    const registry = new RoomWalletRegistry({
        entries: [{ roomNumber: 1, address: variants.uq, network: "mainnet" }]
    });

    const record = registry.get(1);
    assert.equal(record.address, variants.eq);
    assert.equal(record.network, "mainnet");
});

test("register() treats EQ and 0Q as the same identity (no duplicate, no overwrite)", () => {
    const addr = v4Address("s89-eq-zq");
    const variants = forms(addr);

    const registry = new RoomWalletRegistry({
        entries: [{ roomNumber: 2, address: variants.eq, network: "mainnet" }]
    });

    const updated = registry.register({ roomNumber: 2, address: variants.zq });

    assert.equal(updated.address, variants.eq);
    assert.equal(registry.size(), 1);
    assert.equal(registry.get(2).address, variants.eq);
});

test("register() treats EQ and UQ as the same identity (no duplicate, no overwrite)", () => {
    const addr = v4Address("s89-eq-uq");
    const variants = forms(addr);

    const registry = new RoomWalletRegistry({
        entries: [{ roomNumber: 3, address: variants.eq, network: "mainnet" }]
    });

    registry.register({ roomNumber: 3, address: variants.uq });

    assert.equal(registry.size(), 1);
    assert.equal(registry.get(3).address, variants.eq);
});

test("register() treats URL-safe and non-URL-safe forms as the same identity", () => {
    const addr = v4Address("s89-safe-unsafe");
    const variants = forms(addr);

    const registry = new RoomWalletRegistry({
        entries: [{ roomNumber: 4, address: variants.eq, network: "mainnet" }]
    });

    registry.register({ roomNumber: 4, address: variants.eqUnsafe });

    assert.equal(registry.size(), 1);
    assert.equal(registry.get(4).address, variants.eq);
});

test("register() accepts { address } object shape and stores canonical", () => {
    const addr = v4Address("s89-object");
    const variants = forms(addr);

    const registry = new RoomWalletRegistry();
    const record = registry.register({
        roomNumber: 5,
        address: { address: variants.uq },
        network: "mainnet"
    });

    assert.equal(record.address, variants.eq);
    assert.equal(registry.get(5).address, variants.eq);
});

test("register() rejects invalid addresses fail-closed", () => {
    const registry = new RoomWalletRegistry();

    assert.throws(
        () => registry.register({ roomNumber: 6, address: "not-an-address" }),
        TypeError
    );
    assert.throws(
        () => registry.register({ roomNumber: 7, address: "" }),
        TypeError
    );
    assert.throws(
        () => registry.register({ roomNumber: 8, address: null }),
        TypeError
    );
    assert.throws(
        () => registry.register({ roomNumber: 9, address: { toString: () => "EQfake" } }),
        TypeError
    );
    assert.throws(
        () => registry.register({ roomNumber: 10, address: { address: 12 } }),
        TypeError
    );
    assert.throws(
        () => registry.register({ roomNumber: 11, address: "[object Object]" }),
        TypeError
    );

    assert.equal(registry.size(), 0);
});

test("register() rejects when roomNumber is already mapped to a different wallet identity", () => {
    const registry = new RoomWalletRegistry({
        entries: [
            {
                roomNumber: 12,
                address: forms(v4Address("s89-room-12-a")).eq,
                network: "mainnet"
            }
        ]
    });

    assert.throws(
        () => registry.register({
            roomNumber: 12,
            address: forms(v4Address("s89-room-12-b")).eq,
            network: "mainnet"
        }),
        (error) => error instanceof Error
            && error.message.includes("room 12 is already mapped to another wallet")
    );
});

test("register() allows different roomNumbers for the same wallet identity", () => {
    const addr = forms(v4Address("s89-multi-room")).eq;

    const registry = new RoomWalletRegistry({
        entries: [{ roomNumber: 13, address: addr, network: "mainnet" }]
    });

    registry.register({ roomNumber: 14, address: addr, network: "mainnet" });

    assert.equal(registry.size(), 2);
    assert.equal(registry.get(13).address, addr);
    assert.equal(registry.get(14).address, addr);
});

test("register() with constructor entries handles friendly-format variants", () => {
    const addr = v4Address("s89-ctor");
    const variants = forms(addr);

    const registry = new RoomWalletRegistry({
        entries: [
            { roomNumber: 15, address: variants.zq, network: "mainnet" },
            { roomNumber: 16, address: variants.uq, network: "mainnet" }
        ]
    });

    assert.equal(registry.size(), 2);
    assert.equal(registry.get(15).address, variants.eq);
    assert.equal(registry.get(16).address, variants.eq);
});

test("register() stored address is canonical even when given raw object { address }", () => {
    const addr = v4Address("s89-raw-object");
    const variants = forms(addr);

    const registry = new RoomWalletRegistry({
        entries: [
            { roomNumber: 17, address: { address: variants.kq }, network: "mainnet" }
        ]
    });

    const record = registry.get(17);
    assert.equal(record.address, variants.eq);
    assert.equal(Address.parse(record.address).toRawString(),
        Address.parse(variants.eq).toRawString());
});
