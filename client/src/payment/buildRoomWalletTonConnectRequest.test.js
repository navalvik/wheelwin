import assert from "node:assert/strict";
import { Address, Cell } from "@ton/core";

import {
    buildRoomWalletTonConnectRequest,
    TON_TESTNET_CHAIN,
    TON_MAINNET_CHAIN,
    payerMatchesConnectedWallet
} from "./buildRoomWalletTonConnectRequest.js";

const payer = new Address(0, Buffer.alloc(32, 1)).toString();
const destination = new Address(0, Buffer.alloc(32, 2)).toString();
const now = 1_800_000_000_000;

const request = buildRoomWalletTonConnectRequest({
    paymentAcceptanceEnabled: true,
    status: "AWAITING_PAYMENT",
    network: "testnet",
    asset: "TON",
    amountAtomic: 1_000_000_000,
    paymentReference: "test-ref_1",
    expiresAt: now + 600_000,
    destinationWalletAddress: destination,
    payerAddress: payer
}, now);

assert.equal(request.network, TON_TESTNET_CHAIN);
assert.equal(request.messages.length, 1);
assert.equal(request.messages[0].amount, "1000000000");
assert.equal(Address.isFriendly(request.messages[0].address), true);
assert.equal(Address.isRaw(request.messages[0].address), false);

const friendly = Address.parseFriendly(request.messages[0].address);
assert.equal(friendly.isTestOnly, true,
    "TonConnect destination must be explicitly marked Testnet");
assert.equal(friendly.isBounceable, false,
    "room wallet destination uses the non-bounceable friendly address");
assert.equal(friendly.address.toRawString(), Address.parse(destination).toRawString());

const memo = Cell.fromBoc(Buffer.from(request.messages[0].payload, "base64"))[0]
    .beginParse()
    .skip(32)
    .loadStringTail();
assert.equal(memo, "WW1:test-ref_1");

assert.throws(() => buildRoomWalletTonConnectRequest({
    paymentAcceptanceEnabled: true,
    status: "AWAITING_PAYMENT",
    network: "testnet",
    asset: "TON",
    amountAtomic: 0,
    paymentReference: "test-ref_1",
    expiresAt: now + 600_000,
    destinationWalletAddress: destination,
    payerAddress: payer
}, now), /No active authoritative TON payment request/);

const mainnetRequest = buildRoomWalletTonConnectRequest({
    paymentAcceptanceEnabled: true,
    status: "AWAITING_PAYMENT",
    network: "mainnet",
    asset: "TON",
    amountAtomic: 2_500_000_000,
    paymentReference: "mainnet-ref-1",
    expiresAt: now + 600_000,
    destinationWalletAddress: destination,
    payerAddress: payer
}, now);
assert.equal(mainnetRequest.network, TON_MAINNET_CHAIN);
assert.equal(mainnetRequest.messages[0].amount, "2500000000");
assert.equal(Address.parseFriendly(mainnetRequest.messages[0].address).isTestOnly, false);
assert.equal(payerMatchesConnectedWallet(payer, {
    account: { address: payer, chain: TON_MAINNET_CHAIN }
}, "mainnet"), true);
assert.equal(payerMatchesConnectedWallet(payer, {
    account: { address: payer, chain: TON_TESTNET_CHAIN }
}, "mainnet"), false);
assert.throws(() => buildRoomWalletTonConnectRequest({
    paymentAcceptanceEnabled: false,
    status: "AWAITING_PAYMENT",
    network: "mainnet",
    asset: "TON",
    amountAtomic: 2_500_000_000,
    paymentReference: "mainnet-ref-1",
    expiresAt: now + 600_000,
    destinationWalletAddress: destination,
    payerAddress: payer
}, now), /No active authoritative TON payment request/);

process.stdout.write("buildRoomWalletTonConnectRequest.test.js: all assertions passed\n");
