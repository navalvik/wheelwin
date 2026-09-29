/**
 * getAddressTransactions — read-only lookup of an arbitrary TON address
 * transaction history. Used by refund reconciliation to inspect a destination
 * player wallet. Delegates to tonService.getTransactions unchanged; never
 * resolves signing material and never broadcasts.
 *
 * Mock transport only. No live TON access.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { RoomWalletAdapter } from "../payment/roomWallet/RoomWalletAdapter.js";
import { createDummyRoomWalletEntry } from "./helpers/dummyRoomWallet.js";

const WALLET = createDummyRoomWalletEntry(1);
const PLAYER_WALLET = "EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM";

test("getAddressTransactions delegates to tonService.getTransactions with the exact address and query", async () => {
    const queries = [];
    const history = [{ transaction_id: { hash: "player-tx-1" } }];
    const adapter = new RoomWalletAdapter({
        tonService: {
            async getBalance() {
                return 1n;
            },
            async getTransactions(address, query) {
                queries.push({ address, query });
                return history;
            }
        },
        walletResolver: async () => ({
            roomNumber: 1,
            address: WALLET.address,
            publicKey: WALLET.publicKey,
            secretKey: WALLET.secretKey
        })
    });

    const result = await adapter.getAddressTransactions(
        PLAYER_WALLET,
        { limit: 40, archival: true }
    );

    assert.equal(result, history);
    assert.deepEqual(queries, [{
        address: PLAYER_WALLET,
        query: { limit: 40, archival: true }
    }]);
});

test("getAddressTransactions returns [] when tonService.getTransactions is unavailable", async () => {
    const broadcasts = [];
    const adapter = new RoomWalletAdapter({
        tonService: {
            async getBalance() {
                return 1n;
            },
            async broadcastTransaction(boc) {
                broadcasts.push(boc);
                return { hash: "must-not-broadcast" };
            }
        },
        walletResolver: async () => ({
            roomNumber: 1,
            address: WALLET.address
        })
    });

    const result = await adapter.getAddressTransactions(PLAYER_WALLET, { limit: 5 });

    assert.deepEqual(result, []);
    assert.equal(broadcasts.length, 0);
});

test("getAddressTransactions does not resolve room wallet identity or signing material", async () => {
    let resolverCalls = 0;
    const adapter = new RoomWalletAdapter({
        tonService: {
            async getTransactions(address) {
                return [{ queried: address }];
            }
        },
        walletResolver: async () => {
            resolverCalls += 1;
            return { roomNumber: 1, address: WALLET.address };
        }
    });

    const result = await adapter.getAddressTransactions(PLAYER_WALLET);

    assert.equal(resolverCalls, 0);
    assert.equal(result.length, 1);
    assert.equal(result[0].queried, PLAYER_WALLET);
});
