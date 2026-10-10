import assert from "node:assert/strict";
import test from "node:test";
import { beginCell } from "@ton/core";

import {
    deriveRoomWalletRefundQueryId,
    normalizeRoomWalletRefundQueryId,
    roomWalletRefundQueryIdsMatch
} from "../payment/roomWallet/roomWalletRefundIdentity.js";
import { quarantineDuplicateRefundTxHashClaims } from "../payment/roomWallet/roomWalletRefundClaims.js";
import {
    extractInbound,
    extractOutboundTransfers
} from "../payment/roomWallet/roomWalletTerminalRecoveryChain.js";

const ROOM_WALLET = "EQDNUDegzGDLTae_mbjwpb9IkcUNoPXnQpNgaZYBpO2srnRU";
const PLAYER_A = "EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le";
const PLAYER_B = "EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM";

test("refund query id is stable for one obligation and differs between sessions", () => {
    const input = {
        paymentSessionId: "pay_36c10d03",
        playerId: "player-0",
        playerIndex: 0,
        wallet: PLAYER_A
    };
    const first = deriveRoomWalletRefundQueryId(input);
    const restarted = deriveRoomWalletRefundQueryId({ ...input });
    const otherSession = deriveRoomWalletRefundQueryId({
        ...input,
        paymentSessionId: "pay_378334bf"
    });

    assert.match(first, /^\d+$/);
    assert.equal(first, restarted);
    assert.notEqual(first, otherSession);
    assert.equal(normalizeRoomWalletRefundQueryId(first), first);
    assert.equal(roomWalletRefundQueryIdsMatch(first, restarted), true);
    assert.equal(roomWalletRefundQueryIdsMatch(first, otherSession), false);
});

test("refund query id rejects missing, malformed, negative and over-uint64 values", () => {
    assert.equal(normalizeRoomWalletRefundQueryId(null), null);
    assert.equal(normalizeRoomWalletRefundQueryId("not-a-number"), null);
    assert.equal(normalizeRoomWalletRefundQueryId("-1"), null);
    assert.equal(normalizeRoomWalletRefundQueryId((1n << 64n).toString()), null);
    assert.equal(normalizeRoomWalletRefundQueryId("0"), "0");
});

test("transaction history extracts the exact 64-bit query id from outbound and inbound message bodies", () => {
    const queryId = "18374686479671623681";
    const body = beginCell().storeUint(BigInt(queryId), 64).endCell().toBoc().toString("base64");
    const outbound = extractOutboundTransfers({
        transaction_id: { hash: "outbound-hash", lt: "42" },
        utime: 1_791_630_911,
        success: true,
        out_msgs: [{
            destination: PLAYER_A,
            value: "998599864",
            msg_data: { body }
        }]
    });
    const inbound = extractInbound({
        transaction_id: { hash: "inbound-hash", lt: "43" },
        utime: 1_791_630_911,
        success: true,
        in_msg: {
            source: ROOM_WALLET,
            value: "998599864",
            msg_data: { body }
        }
    });

    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].queryId, queryId);
    assert.equal(inbound.queryId, queryId);
});

test("legacy empty-body transfer has no refund query id", () => {
    const outbound = extractOutboundTransfers({
        transaction_id: { hash: "legacy-hash", lt: "42" },
        utime: 1_791_630_911,
        success: true,
        out_msgs: [{
            destination: PLAYER_A,
            value: "998599864",
            msg_data: { body: "te6cckEBAQEAAgAAAEysuc0=" }
        }]
    });

    assert.equal(outbound[0].queryId, null);
});

test("duplicate refund hash claims quarantine every claimant without choosing an owner", () => {
    const sharedHash = "duplicate-full-transaction-hash";
    const first = {
        paymentSessionId: "pay_rgft",
        roomId: "RGFT",
        recoveryMetadata: {},
        participants: [{
            playerId: "player-a",
            playerIndex: 0,
            wallet: PLAYER_A,
            refunded: true,
            refundTxHash: sharedHash
        }]
    };
    const second = {
        paymentSessionId: "pay_snvo",
        roomId: "sNvb",
        recoveryMetadata: {},
        participants: [{
            playerId: "player-b",
            playerIndex: 0,
            wallet: PLAYER_B,
            refunded: true,
            refundTxHash: sharedHash
        }]
    };
    const unique = {
        paymentSessionId: "pay_unique",
        roomId: "unique",
        recoveryMetadata: {},
        participants: [{
            playerId: "player-c",
            playerIndex: 0,
            wallet: PLAYER_B,
            refunded: true,
            refundTxHash: "unique-hash"
        }]
    };

    const affected = quarantineDuplicateRefundTxHashClaims([first, second, unique], {
        now: () => 1_791_630_911_000
    });

    assert.deepEqual(affected, [first, second]);
    for (const session of [first, second]) {
        assert.equal(session.participants[0].refunded, false);
        assert.equal(session.participants[0].refundTxHash, null);
        assert.equal(
            session.recoveryMetadata.refundAttributionQuarantine.status,
            "MANUAL_RECONCILIATION_REQUIRED"
        );
        assert.equal(
            session.recoveryMetadata.refundAttributionQuarantine.reason,
            "DUPLICATE_TRANSACTION_HASH"
        );
        const [conflict] = session.recoveryMetadata.refundAttributionQuarantine.conflicts;
        assert.equal(conflict.transactionHash, sharedHash);
        assert.equal(conflict.claims.length, 2);
        assert.equal(conflict.claims.every((claim) => claim.transactionHash === sharedHash), true);
    }
    assert.equal(unique.participants[0].refunded, true);
    assert.equal(unique.participants[0].refundTxHash, "unique-hash");
    assert.equal(unique.recoveryMetadata.refundAttributionQuarantine, undefined);
});
