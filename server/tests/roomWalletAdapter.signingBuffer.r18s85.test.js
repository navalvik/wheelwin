/**
 * R18-S85 — ROOM_WALLETS_JSON keys are byte arrays; @ton/core signing requires Buffer.copy.
 * Mock broadcast only. No live TON send.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { RoomWalletAdapter } from "../payment/roomWallet/RoomWalletAdapter.js";
import { createDummyRoomWalletEntry } from "./helpers/dummyRoomWallet.js";

const WALLET = createDummyRoomWalletEntry(1);
const DESTINATION = "EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM";

function createAdapter(publicKey, secretKey) {
    const broadcasts = [];
    const adapter = new RoomWalletAdapter({
        tonService: {
            async getBalance() {
                return 5_000_000_000n;
            },
            async getSeqno() {
                return 2;
            },
            async broadcastTransaction(boc) {
                broadcasts.push(boc);
                return { hash: "s85-mock-hash" };
            }
        },
        walletResolver: async () => ({
            roomNumber: 1,
            address: WALLET.address,
            publicKey,
            secretKey,
            workchain: 0
        })
    });
    return { adapter, broadcasts };
}

test("Uint8Array Room Wallet keys sign without src.copy", async () => {
    const publicKey = Uint8Array.from(Buffer.from(WALLET.publicKey, "hex"));
    const secretKey = Uint8Array.from(Buffer.from(WALLET.secretKey, "hex"));
    const { adapter, broadcasts } = createAdapter(publicKey, secretKey);

    const result = await adapter.sendTransfer({
        roomNumber: 1,
        destination: DESTINATION,
        amountNano: 2_850_000_000n
    });

    assert.equal(result.ok, true);
    assert.equal(result.txHash, "s85-mock-hash");
    assert.equal(broadcasts.length, 1);
    assert.equal(typeof broadcasts[0], "string");
    assert.notEqual(broadcasts[0].length, 0);
});

test("Buffer Room Wallet keys still sign", async () => {
    const { adapter, broadcasts } = createAdapter(
        Buffer.from(WALLET.publicKey, "hex"),
        Buffer.from(WALLET.secretKey, "hex")
    );

    const result = await adapter.sendTransfer({
        roomNumber: 1,
        destination: DESTINATION,
        amountNano: 140_000_000n
    });

    assert.equal(result.ok, true);
    assert.equal(broadcasts.length, 1);
});
