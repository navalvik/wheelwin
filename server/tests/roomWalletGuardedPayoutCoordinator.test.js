import test from "node:test";
import assert from "node:assert/strict";

import { RoomWalletGuardedPayoutCoordinator } from "../payment/roomWallet/RoomWalletGuardedPayoutCoordinator.js";
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";

const INTENTS = Object.freeze({
    WINNER: "rwout_" + "a".repeat(64),
    OWNER: "rwout_" + "b".repeat(64)
});

function fixture() {
    const states = new Map([
        [INTENTS.WINNER, { status: "ACTIVE", state: "PLANNED" }],
        [INTENTS.OWNER, { status: "ACTIVE", state: "PLANNED" }]
    ]);
    const events = [];
    const journal = {
        createSettlementPlan({ gameId, role }) {
            events.push("plan:" + role);
            assert.equal(gameId, "game_10_07");
            if (!INTENTS[role]) throw new Error("ROLE_UNKNOWN");
            return { intentId: INTENTS[role], created: true };
        },
        createRefundPlan() {
            throw new Error("NO_REFUND_AUTHORIZATION");
        },
        load(intentId) {
            const state = states.get(intentId);
            if (!state) throw new Error("UNKNOWN_INTENT");
            return {
                recordId: intentId,
                status: state.status,
                payload: {
                    state: state.state,
                    roomWallet: "0:" + "1".repeat(64),
                    destinationWallet: state.destinationWallet ?? "0:" + "2".repeat(64),
                    transferNano: "999",
                    chainReceipt: state.status === "SETTLED"
                        ? { walletTxHash: "f".repeat(64) } : null
                }
            };
        }
    };
    const executor = {
        async execute({ intentId }) {
            events.push("execute:" + (intentId === INTENTS.WINNER ? "WINNER" : "OWNER"));
            if (states.get(intentId).state === "PLANNED") {
                states.get(intentId).state = "CONFIRMATION_UNKNOWN";
            }
            return { state: states.get(intentId).state, broadcasted: false };
        }
    };
    const guarded = new RoomWalletGuardedPayoutCoordinator({ journal, executor });
    return {
        guarded, states, events,
        confirm(role) {
            states.get(INTENTS[role]).state = "CHAIN_CONFIRMED";
            states.get(INTENTS[role]).status = "SETTLED";
        }
    };
}

test("winner is attempted before owner and uncertain reply never triggers owner", async () => {
    const f = fixture();
    const first = await f.guarded.settleContract({ gameId: "game_10_07" });
    assert.equal(first.code, "GUARDED_WINNER_CONFIRMATION_PENDING");
    assert.deepEqual(f.events, ["plan:WINNER", "plan:OWNER", "execute:WINNER"]);
    const second = await f.guarded.settleContract({ gameId: "game_10_07" });
    assert.equal(second.code, "GUARDED_WINNER_CONFIRMATION_PENDING");
    assert.equal(f.events.includes("execute:OWNER"), false);
});

test("after winner chain confirmation, only owner is attempted; never winner again", async () => {
    const f = fixture();
    await f.guarded.settleContract({ gameId: "game_10_07" });
    f.confirm("WINNER");
    const followup = await f.guarded.settleContract({ gameId: "game_10_07" });
    assert.equal(followup.code, "GUARDED_OWNER_CONFIRMATION_PENDING");
    assert.equal(followup.partial, true);
    assert.deepEqual(f.events.filter(x => x === "execute:WINNER"), ["execute:WINNER"]);
    assert.deepEqual(f.events.filter(x => x === "execute:OWNER"), ["execute:OWNER"]);
});

test("both chain confirmations return complete without new broadcasts", async () => {
    const f = fixture();
    f.confirm("WINNER");
    f.confirm("OWNER");
    const result = await f.guarded.settleContract({ gameId: "game_10_07" });
    assert.equal(result.ok, true);
    assert.equal(result.winnerConfirmed, true);
    assert.equal(result.ownerConfirmed, true);
    assert.equal(result.winner.txHash, "f".repeat(64));
    assert.equal(result.owner.txHash, "f".repeat(64));
    assert.equal(f.events.filter(x => x.startsWith("execute")).length, 0);
});

test("missing authoritative game ID fails closed with zero sends", async () => {
    const f = fixture();
    const result = await f.guarded.settleContract({});
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.broadcastingPermitted, false);
    assert.equal(f.events.length, 0);
});

test("frozen settlement authorization failure never calls sender", async () => {
    const f = fixture();
    f.guarded._journal.createSettlementPlan = () => {
        throw new Error("FROZEN_PLAN_NOT_PERSISTED");
    };
    const result = await f.guarded.settleContract({ gameId: "game_10_07" });
    assert.equal(result.code, "GUARDED_SETTLEMENT_FROZEN_PLAN_UNAVAILABLE");
    assert.equal(result.retryable, false);
    assert.equal(f.events.length, 0);
});

test("refund with no authoritative payer obligation IDs never executes", async () => {
    const f = fixture();
    const result = await f.guarded.refundPayments({
        roomNumber: 1,
        refunds: [{ playerId: "Lena", wallet: "0:" + "3".repeat(64), amountNano: "1000000000" }],
        refundPlan: {
            mode: "RECIPIENT_PAYS_GAS",
            entries: [{
                playerId: "Lena", wallet: "0:" + "3".repeat(64),
                grossRefundNano: "1000000000",
                recipientGasChargeNano: "1000000",
                recipientTransferAmountNano: "999000000"
            }]
        }
    });
    assert.equal(result.code, "GUARDED_REFUND_FROZEN_PLAN_AND_EVIDENCE_REQUIRED");
    assert.equal(result.ok, false);
    assert.equal(f.events.length, 0);
});

test("verified room/game/session debts allow one guarded refund at a time", async () => {
    const f = fixture();
    const roomId = "oj7v", gameId = "game_oj7v";
    const paymentSessionId = "pay_oj7v";
    const roomWallet = "0:" + "1".repeat(64);
    const refunds = ["Olga", "Lena", "Bob"].map((name, index) => ({
        playerId: name,
        wallet: "0:" + String(index + 3).repeat(64),
        amountNano: "1000000000"
    }));
    const entries = refunds.map(target => ({
        playerId: target.playerId, wallet: target.wallet,
        grossRefundNano: "1000000000",
        recipientGasChargeNano: "1000000",
        recipientTransferAmountNano: "999000000"
    }));
    const refundPlan = { mode: "RECIPIENT_PAYS_GAS", entries };
    f.guarded._financialPersistence = {
        loadPaymentSession(id) {
            assert.equal(id, paymentSessionId);
            return { payload: {
                network: "testnet",
                roomId, gameId, paymentSessionId, roomNumber: 1,
                roomWalletAddress: roomWallet,
                recoveryMetadata: { refundPlan }
            }};
        }
    };
    const records = refunds.map((target, i) => ({
        recordId: "rwrefund_" + String(i + 4).repeat(64),
        status: "ACTIVE",
        payload: {
            kind: "ROOM_WALLET_REFUND_OBLIGATION",
            network: "testnet",
            executionAllowed: true,
            state: "REFUND_RECONCILIATION_REQUIRED",
            roomId, gameId, paymentSessionId, roomNumber: 1,
            playerId: target.playerId, recipientWallet: target.wallet,
            fromRoomWallet: roomWallet, grossRefundNano: "1000000000"
        }
    }));
    f.guarded._refundRepository = {
        listRefundObligations({ roomId: id }) {
            assert.equal(id, roomId);
            return records;
        }
    };
    f.guarded._journal.createRefundPlan = ({ obligationId }) => {
        const i = records.findIndex(item => item.recordId === obligationId);
        if (i < 0) throw new Error("NO_CHAIN_BACKED_DEBT");
        const intentId = "rwout_" + String(i + 5).repeat(64);
        f.states.set(intentId, {
            status: "ACTIVE", state: "PLANNED",
            destinationWallet: refunds[i].wallet
        });
        return { intentId };
    };
    const originalLoad = f.guarded._journal.load;
    f.guarded._journal.load = id => {
        const record = originalLoad(id);
        return {
            ...record,
            payload: {
                ...record.payload, roomNumber: 1, roomId, gameId,
                paymentSessionId, roomWallet
            }
        };
    };

    // Olga's original refund could already have been paid and excluded from
    // the pending targets. The frozen refundPlan still covers all 3 players.
    const result = await f.guarded.refundPayments({
        roomId, gameId, paymentSessionId, roomNumber: 1,
        refunds: refunds.slice(1),
        refundPlan
    });
    assert.equal(result.code, "GUARDED_REFUND_CONFIRMATION_PENDING");
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].playerId, "Lena");
    assert.equal(f.events.filter(x => x.startsWith("execute")).length, 1);

    // Same player wallet reused in a DIFFERENT game cannot borrow the debt.
    const otherGame = await f.guarded.refundPayments({
        roomId, gameId: "another_game",
        paymentSessionId, roomNumber: 1,
        refunds: refunds.slice(1), refundPlan
    });
    assert.equal(otherGame.ok, false);
    assert.equal(otherGame.code, "GUARDED_REFUND_PROOF_NOT_AUTHORIZED");
    assert.equal(f.events.filter(x => x.startsWith("execute")).length, 1);
});

test("existing settlement adapter directly routes to protected coordinator", async () => {
    let directCalls = 0;
    const f = fixture();
    const adapter = new RoomWalletSettlementAdapter({
        roomWalletAdapter: {
            async sendTransfer() { directCalls++; throw new Error("DIRECT_SEND_UNSAFE"); },
            async getBalance() { return 3000000000n; }
        },
        guardedPayoutCoordinator: f.guarded
    });
    const settlement = await adapter.settleContract({ gameId: "game_10_07" });
    assert.equal(settlement.code, "GUARDED_WINNER_CONFIRMATION_PENDING");
    const refund = await adapter.refundPayments({ roomNumber: 1, refunds: [] });
    assert.equal(refund.code, "GUARDED_REFUND_FROZEN_PLAN_AND_EVIDENCE_REQUIRED");
    assert.equal(directCalls, 0);
});
