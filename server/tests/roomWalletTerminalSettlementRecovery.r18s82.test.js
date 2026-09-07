/**
 * R18-S82 — Operator recovery of terminal FAILED Room-Wallet settlements.
 * Deterministic mocks only. No chain broadcast in this file.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EVENT_TYPES } from "../events/EventTypes.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { SETTLEMENT_SESSION_STATUS, canTransitionSettlementStatus } from "../payment/SettlementSessionStates.js";
import { RoomWalletRegistry } from "../payment/roomWallet/RoomWalletRegistry.js";
import {
    OPERATOR_RECOVERY_CODES,
    RoomWalletTerminalSettlementRecovery
} from "../payment/roomWallet/RoomWalletTerminalSettlementRecovery.js";
import {
    SEALED_TERMINAL_SETTLEMENT_EVIDENCE,
    UHQU_GAME_ID
} from "../payment/roomWallet/sealedTerminalSettlementEvidence.js";

const UHQU = SEALED_TERMINAL_SETTLEMENT_EVIDENCE[UHQU_GAME_ID];
const WINNER_NANO = 2_850_000_000n;
const OWNER_NANO = 140_000_000n;

function createLogger() {
    return { info() {}, warn() {}, error() {}, debug() {} };
}

function createPersistence() {
    const dataDir = mkdtempSync(join(tmpdir(), "ww-s82-"));
    const persistence = new TonFinancialPersistence({ dataDir, logger: createLogger() });
    persistence.initialize();
    return persistence;
}

function createHarness({
    inspect = null,
    adapter = null,
    roomOccupied = null,
    persist = true,
    events = []
} = {}) {
    const adapterCalls = [];
    const defaultAdapter = {
        async preflight() {
            return { ok: true, requiredNano: 3_010_000_000n };
        },
        async settleContract(request) {
            adapterCalls.push(request);
            return {
                ok: true,
                winner: { ok: true, txHash: "winner-hash" },
                owner: { ok: true, txHash: "owner-hash" }
            };
        }
    };
    const recovery = new RoomWalletTerminalSettlementRecovery({
        logger: createLogger(),
        eventBus: {
            emit(envelope) {
                events.push(envelope);
            }
        },
        financialPersistence: persist ? createPersistence() : null,
        settlementAdapter: adapter ?? defaultAdapter,
        tonService: {},
        roomManager: {
            getRoomByNumber(roomNumber) {
                return roomOccupied && Number(roomNumber) === 1 ? roomOccupied : null;
            }
        },
        ownerConfiguration: {
            getOwnerWallet() {
                return UHQU.ownerWallet;
            }
        },
        registry: new RoomWalletRegistry({
            entries: [{ roomNumber: 1, address: UHQU.roomWalletAddress }]
        }),
        inspectHistory: inspect ?? (async () => ({
            reused: false,
            laterCount: 0,
            winnerPayout: null,
            ownerPayout: null,
            winnerPayoutCount: 0,
            ownerPayoutCount: 0,
            balanceNano: 3_489_554_338n,
            seqno: 2
        })),
        confirmPayout: async ({ expectedHash, amountNano }) => ({
            ok: true,
            hash: expectedHash,
            amountNano
        }),
        confirmTimeoutMs: 10,
        confirmPollMs: 1
    });

    return { recovery, adapterCalls, events };
}

function uhquPins(extra = {}) {
    return {
        gameId: UHQU_GAME_ID,
        roomNumber: 1,
        roomWalletAddress: UHQU.roomWalletAddress,
        ...extra
    };
}

test("ordinary settlement cannot reopen SETTLEMENT_FAILED", () => {
    assert.equal(
        canTransitionSettlementStatus(
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_CONFIRMED
        ),
        false
    );
    assert.equal(
        canTransitionSettlementStatus(
            SETTLEMENT_SESSION_STATUS.SETTLEMENT_FAILED,
            SETTLEMENT_SESSION_STATUS.READY
        ),
        false
    );
});

test("UhqU reconstruction uses winnerAmount 2.85 and organizerAmount 0.15", async () => {
    const { recovery, adapterCalls } = createHarness();
    const result = await recovery.recover(uhquPins());
    assert.equal(result.ok, true);
    assert.equal(result.code, OPERATOR_RECOVERY_CODES.CONFIRMED);
    assert.equal(adapterCalls.length, 1);
    assert.equal(adapterCalls[0].winnerAmount, 2.85);
    assert.equal(adapterCalls[0].organizerAmount, 0.15);
    assert.equal(adapterCalls[0].prizeAmount, undefined);
    assert.equal(adapterCalls[0].roomNumber, 1);
    assert.equal(adapterCalls[0].winnerWallet, UHQU.winnerWallet);
    assert.equal(adapterCalls[0].ownerWallet, UHQU.ownerWallet);
    assert.equal(result.ownerPayoutNano, OWNER_NANO);
    assert.equal(result.retainedNano, 10_000_000n);
    assert.equal(result.originalSettlementFailed, true);
});

test("wrong gameId is rejected", async () => {
    const { recovery, adapterCalls } = createHarness();
    const result = await recovery.recover({
        ...uhquPins(),
        gameId: "game_other"
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, OPERATOR_RECOVERY_CODES.EVIDENCE_MISSING);
    assert.equal(adapterCalls.length, 0);
});

test("wrong room number is rejected", async () => {
    const { recovery, adapterCalls } = createHarness();
    const result = await recovery.recover({ ...uhquPins(), roomNumber: 2 });
    assert.equal(result.ok, false);
    assert.equal(result.code, OPERATOR_RECOVERY_CODES.PIN_MISMATCH);
    assert.equal(adapterCalls.length, 0);
});

test("wrong Room Wallet is rejected", async () => {
    const { recovery, adapterCalls } = createHarness();
    const result = await recovery.recover({
        ...uhquPins(),
        roomWalletAddress: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c"
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, OPERATOR_RECOVERY_CODES.PIN_MISMATCH);
    assert.equal(adapterCalls.length, 0);
});

test("active newer Room #1 game blocks recovery", async () => {
    const { recovery, adapterCalls } = createHarness({
        roomOccupied: { roomId: "Next", roomNumber: 1 }
    });
    const result = await recovery.recover(uhquPins());
    assert.equal(result.ok, false);
    assert.equal(result.code, OPERATOR_RECOVERY_CODES.ROOM_OCCUPIED);
    assert.equal(adapterCalls.length, 0);
});

test("Room Wallet reuse after UhqU blocks recovery", async () => {
    const { recovery, adapterCalls } = createHarness({
        inspect: async () => ({
            reused: true,
            laterCount: 1,
            winnerPayout: null,
            ownerPayout: null,
            winnerPayoutCount: 0,
            ownerPayoutCount: 0,
            balanceNano: 3_489_554_338n,
            seqno: 3
        })
    });
    const result = await recovery.recover(uhquPins());
    assert.equal(result.ok, false);
    assert.equal(result.code, OPERATOR_RECOVERY_CODES.WALLET_REUSED);
    assert.equal(adapterCalls.length, 0);
});

test("existing winner and owner payouts are adopted without a second send", async () => {
    const { recovery, adapterCalls, events } = createHarness({
        inspect: async () => ({
            reused: false,
            laterCount: 2,
            winnerPayout: { hash: "onchain-winner", amountNano: WINNER_NANO },
            ownerPayout: { hash: "onchain-owner", amountNano: OWNER_NANO },
            winnerPayoutCount: 1,
            ownerPayoutCount: 1,
            balanceNano: 400_000_000n,
            seqno: 4
        })
    });
    const result = await recovery.recover(uhquPins());
    assert.equal(result.ok, true);
    assert.equal(adapterCalls.length, 0);
    assert.equal(result.winnerTxHash, "onchain-winner");
    assert.equal(result.ownerTxHash, "onchain-owner");
    assert.equal(events[0].type, EVENT_TYPES.SETTLEMENT_CONFIRMED);
});

test("existing winner payout without owner is partial and does not confirm", async () => {
    const { recovery, adapterCalls, events } = createHarness({
        inspect: async () => ({
            reused: false,
            laterCount: 1,
            winnerPayout: { hash: "partial-winner", amountNano: WINNER_NANO },
            ownerPayout: null,
            winnerPayoutCount: 1,
            ownerPayoutCount: 0,
            balanceNano: 600_000_000n,
            seqno: 3
        })
    });
    const result = await recovery.recover(uhquPins());
    assert.equal(result.ok, false);
    assert.equal(result.code, OPERATOR_RECOVERY_CODES.PARTIAL);
    assert.equal(adapterCalls.length, 0);
    assert.equal(events.length, 0);
});

test("existing owner payout without winner is partial", async () => {
    const { recovery, events } = createHarness({
        inspect: async () => ({
            reused: false,
            laterCount: 1,
            winnerPayout: null,
            ownerPayout: { hash: "partial-owner", amountNano: OWNER_NANO },
            winnerPayoutCount: 0,
            ownerPayoutCount: 1,
            balanceNano: 3_000_000_000n,
            seqno: 3
        })
    });
    const result = await recovery.recover(uhquPins());
    assert.equal(result.code, OPERATOR_RECOVERY_CODES.PARTIAL);
    assert.equal(events.length, 0);
});

test("insufficient balance blocks recovery", async () => {
    const { recovery, adapterCalls } = createHarness({
        adapter: {
            async preflight() {
                return { ok: false, requiredNano: 3_010_000_000n, balanceNano: 1n };
            },
            async settleContract() {
                throw new Error("should not send");
            }
        }
    });
    const result = await recovery.recover(uhquPins());
    assert.equal(result.ok, false);
    assert.equal(result.code, OPERATOR_RECOVERY_CODES.INSUFFICIENT_BALANCE);
    assert.equal(adapterCalls.length, 0);
});

test("operator cannot supply arbitrary destination or amount", async () => {
    const { recovery, adapterCalls } = createHarness();
    const result = await recovery.recover({
        ...uhquPins(),
        winnerWallet: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",
        winnerAmount: 9
    });
    assert.equal(result.code, OPERATOR_RECOVERY_CODES.OPERATOR_OVERRIDE_FORBIDDEN);
    assert.equal(adapterCalls.length, 0);
});

test("partial adapter result does not emit SETTLEMENT_CONFIRMED", async () => {
    const { recovery, events } = createHarness({
        adapter: {
            async preflight() {
                return { ok: true };
            },
            async settleContract() {
                return {
                    ok: false,
                    partial: true,
                    code: "OWNER_PAYOUT_FAILED_AFTER_WINNER",
                    winner: { ok: true, txHash: "w1" },
                    owner: { ok: false }
                };
            }
        }
    });
    const result = await recovery.recover(uhquPins());
    assert.equal(result.code, OPERATOR_RECOVERY_CODES.PARTIAL);
    assert.equal(events.length, 0);
});

test("only both confirmed transfers allow SETTLEMENT_CONFIRMED", async () => {
    let confirmCalls = 0;
    const events = [];
    const { recovery } = createHarness({
        events,
        adapter: {
            async preflight() {
                return { ok: true };
            },
            async settleContract() {
                return {
                    ok: true,
                    winner: { ok: true, txHash: "w-ok" },
                    owner: { ok: true, txHash: "o-ok" }
                };
            }
        }
    });
    recovery._confirmPayout = async ({ expectedHash }) => {
        confirmCalls += 1;
        if (expectedHash === "o-ok") {
            return { ok: false, code: "PAYOUT_NOT_CONFIRMED" };
        }
        return { ok: true, hash: expectedHash };
    };
    const result = await recovery.recover(uhquPins());
    assert.equal(result.code, OPERATOR_RECOVERY_CODES.PARTIAL);
    assert.equal(confirmCalls, 2);
    assert.equal(events.length, 0);
});

test("recovery is idempotent after confirmation", async () => {
    const { recovery, adapterCalls } = createHarness();
    const first = await recovery.recover(uhquPins());
    assert.equal(first.ok, true);
    const second = await recovery.recover(uhquPins());
    assert.equal(second.ok, true);
    assert.equal(second.code, OPERATOR_RECOVERY_CODES.ALREADY_CONFIRMED);
    assert.equal(second.idempotent, true);
    assert.equal(adapterCalls.length, 1);
});

test("Residual Sweep remains gated by confirmation event only", async () => {
    const events = [];
    const { recovery } = createHarness({ events });
    await recovery.recover(uhquPins());
    assert.equal(events.length, 1);
    assert.equal(events[0].type, EVENT_TYPES.SETTLEMENT_CONFIRMED);
    assert.equal(events[0].payload.roomNumber, 1);
    assert.equal(events[0].payload.operatorRecovery, true);
});

test("persisted non-failed settlement is not recoverable on this path", async () => {
    const persistence = createPersistence();
    persistence.createSettlementRecord({
        gameId: UHQU_GAME_ID,
        roomId: "UhqU",
        winnerWallet: UHQU.winnerWallet,
        ownerWallet: UHQU.ownerWallet,
        winnerAmount: 2.85,
        prizeAmount: 2.85,
        organizerAmount: 0.15,
        status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED
    }, {
        gameId: UHQU_GAME_ID,
        roomId: "UhqU",
        status: SETTLEMENT_SESSION_STATUS.SETTLEMENT_COMPLETED
    });
    const recovery = new RoomWalletTerminalSettlementRecovery({
        logger: createLogger(),
        financialPersistence: persistence,
        settlementAdapter: { async settleContract() { throw new Error("no"); } },
        ownerConfiguration: { getOwnerWallet() { return UHQU.ownerWallet; } },
        registry: new RoomWalletRegistry({
            entries: [{ roomNumber: 1, address: UHQU.roomWalletAddress }]
        }),
        inspectHistory: async () => ({ reused: false, winnerPayout: null, ownerPayout: null, winnerPayoutCount: 0, ownerPayoutCount: 0 })
    });
    const result = await recovery.recover(uhquPins());
    assert.equal(result.code, OPERATOR_RECOVERY_CODES.NOT_TERMINAL_FAILED);
});
