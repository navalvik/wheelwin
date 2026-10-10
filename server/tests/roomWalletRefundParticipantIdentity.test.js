import assert from "node:assert/strict";
import test from "node:test";

import {
    PaymentSession,
    PAYMENT_PARTICIPANT_STATUS,
    PAYMENT_SESSION_STATUS
} from "../models/PaymentSession.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";

const ROOM_WALLET = "EQDNUDegzGDLTae_mbjwpb9IkcUNoPXnQpNgaZYBpO2srnRU";
const WRONG_ROOM_WALLET = "EQDGQjwaP0OSExa9MfZih61De5TQuUITQPYiYZyfqAFzpvQB";
const PLAYER_A = "EQC9qwKAy72kX1oPtryX-g5y44B2mYZEB2HVdJAeJprla_Le";
const PLAYER_B = "EQAtggW7l5wfQcPyy38Y7mVuXnh0wRHcpFKPIdtCbcRHb8wM";
const IDENTITY_VERSION = "room-wallet-refund-query-id-v1";

function makeSession({
    paymentSessionId = "identity-session",
    roomId = "identity-room",
    roomNumber = 7,
    roomWalletAddress = ROOM_WALLET,
    recoveryMetadata = {},
    status = PAYMENT_SESSION_STATUS.FULLY_PAID,
    p1 = {},
    p2 = {}
} = {}) {
    return new PaymentSession({
        paymentSessionId,
        roomId,
        roomNumber,
        roomWalletAddress,
        network: "testnet",
        status,
        recoveryMetadata,
        participants: [
            {
                playerId: "p1",
                playerIndex: 0,
                wallet: PLAYER_A,
                paymentDestination: roomWalletAddress,
                requiredGram: 1,
                paidAmount: 1,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED,
                ...p1
            },
            {
                playerId: "p2",
                playerIndex: 1,
                wallet: PLAYER_B,
                paymentDestination: roomWalletAddress,
                requiredGram: 1,
                paidAmount: 1,
                status: PAYMENT_PARTICIPANT_STATUS.PAYMENT_CONFIRMED,
                ...p2
            },
            {
                playerId: "p3",
                playerIndex: 2,
                wallet: PLAYER_B,
                paymentDestination: roomWalletAddress,
                requiredGram: 1,
                paidAmount: 0,
                status: PAYMENT_PARTICIPANT_STATUS.AWAITING_PLAYER_CONFIRMATION
            }
        ]
    });
}

function makeHarness({ refundResults = [], records = [], registeredAddress = ROOM_WALLET } = {}) {
    const sentCalls = [];
    const session = makeSession();
    const manager = new PaymentSessionManager({
        logger: { info() {}, warn() {}, error() {} },
        eventBus: {},
        playerManager: {},
        roomManager: {},
        financialPersistence: { listActive: () => records },
        roomWalletPaymentIntakeEnabled: true,
        roomWalletSettlementAdapter: {
            async refundPayments(input) {
                sentCalls.push(input);
                return { ok: true, results: refundResults };
            }
        }
    });
    manager._roomWalletRegistry = {
        get: () => ({ address: registeredAddress }),
        getByAddress: (address) => address === registeredAddress ? { roomNumber: 7, address: registeredAddress } : null
    };
    manager._persistSession = () => {};
    manager._emit = () => {};
    manager._sessionsByRoom.set(session.roomId, session);
    return { manager, session, sentCalls };
}

test("a successful refund result for a different seat is rejected without mutating participants", async () => {
    const { manager, session } = makeHarness({
        refundResults: [{
            ok: true,
            playerId: "p1",
            playerIndex: 1,
            wallet: PLAYER_B,
            txHash: "foreign-seat-hash"
        }]
    });

    const outcome = await manager._performRoomWalletPartialPaymentRefund(session, "test");
    manager._clearRoomWalletRefundRetry(session.roomId, true);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.code, "ROOM_WALLET_REFUND_ATTRIBUTION_CONFLICT");
    assert.equal(session.findParticipant("p1").refunded, false);
    assert.equal(session.findParticipant("p1").refundTxHash, null);
    assert.equal(session.findParticipant("p2").refunded, false);
    assert.equal(session.findParticipant("p2").refundTxHash, null);
});

test("a result for the right player and seat but a different wallet is rejected", async () => {
    const { manager, session } = makeHarness({
        refundResults: [{
            ok: true,
            playerId: "p1",
            playerIndex: 0,
            wallet: PLAYER_B,
            txHash: "foreign-wallet-hash"
        }]
    });

    const outcome = await manager._performRoomWalletPartialPaymentRefund(session, "test");
    manager._clearRoomWalletRefundRetry(session.roomId, true);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.code, "ROOM_WALLET_REFUND_ATTRIBUTION_CONFLICT");
    assert.equal(session.findParticipant("p1").refunded, false);
    assert.equal(session.findParticipant("p1").refundTxHash, null);
});

test("an exact player, seat, and wallet result is applied", async () => {
    const { manager, session } = makeHarness({
        refundResults: [{
            ok: true,
            playerId: "p1",
            playerIndex: 0,
            wallet: PLAYER_A,
            txHash: "valid-refund-hash"
        }]
    });

    await manager._performRoomWalletPartialPaymentRefund(session, "test");
    manager._clearRoomWalletRefundRetry(session.roomId, true);

    assert.equal(session.findParticipant("p1").refunded, true);
    assert.equal(session.findParticipant("p1").refundTxHash, "valid-refund-hash");
});

test("refund is blocked when a historical room number maps to a different source wallet", async () => {
    const { manager, session, sentCalls } = makeHarness({ registeredAddress: WRONG_ROOM_WALLET });

    const outcome = await manager._performRoomWalletPartialPaymentRefund(session, "test");
    manager._clearRoomWalletRefundRetry(session.roomId, true);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.code, "ROOM_WALLET_SOURCE_IDENTITY_MISMATCH");
    assert.equal(sentCalls.length, 0);
});

test("a refund hash already claimed by a different participant session blocks another send", async () => {
    const sharedHash = "historically-double-attributed-hash";
    const other = makeSession({
        paymentSessionId: "other-session",
        roomId: "other-room",
        p1: { refunded: true, refundTxHash: sharedHash }
    });
    const current = makeSession({
        p1: { refunded: true, refundTxHash: sharedHash },
        status: PAYMENT_SESSION_STATUS.REFUND_PENDING,
        recoveryMetadata: {
            refundIdentityVersion: IDENTITY_VERSION,
            refundRequestedAt: Date.now()
        }
    });
    const records = [{ recordId: other.paymentSessionId, payload: other.toPayload() }];
    const sentCalls = [];
    const manager = new PaymentSessionManager({
        logger: { info() {}, warn() {}, error() {} },
        eventBus: {},
        playerManager: {},
        roomManager: {},
        financialPersistence: { listActive: () => records },
        roomWalletPaymentIntakeEnabled: true,
        roomWalletSettlementAdapter: {
            async refundPayments(input) { sentCalls.push(input); return { ok: true, results: [] }; }
        }
    });
    manager._roomWalletRegistry = {
        get: () => ({ address: ROOM_WALLET }),
        getByAddress: () => ({ roomNumber: 7, address: ROOM_WALLET })
    };
    manager._persistSession = () => {};
    manager._emit = () => {};
    manager._sessionsByRoom.set(current.roomId, current);

    const outcome = await manager._performRoomWalletPartialPaymentRefund(current, "test");
    manager._clearRoomWalletRefundRetry(current.roomId, true);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.code, "ROOM_WALLET_REFUND_HASH_IDENTITY_CONFLICT");
    assert.equal(sentCalls.length, 0);
});
