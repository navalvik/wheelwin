/**
 * Recipient-pays-gas payout policy regression tests (Room Wallet sprint).
 *
 * Business requirement: the game Room Wallet must not continuously consume
 * its own reserve to fund gas for repeated games. Winner/Owner payout gas and
 * player refund gas are economically charged to the payout RECIPIENT by
 * reducing the transfer value; the Room Wallet stays the technical on-chain
 * sender and pays the source-side fee out of the recipient gas charge it
 * retained from the game pot (fee estimate + configurable safety margin).
 *
 * Covered here:
 *   A. Winner recipient-pays-gas accounting.
 *   B. Owner recipient-pays-gas accounting (0.01 GRAM retention preserved).
 *   C. Refund recipient-pays-gas with persistence-before-broadcast recovery.
 *   D. Fee-estimation failure fails closed (no fallback, no broadcast).
 *   E. Gas charge >= payout fails closed (no zero-value payout).
 *   F. Exact recovery reuses the persisted plan (no re-estimation).
 *   G. Partial settlement sends only the missing payout at its frozen value.
 *   H. Seqno sequencing 31 -> confirmed -> 32 still holds.
 *   I. Repeated-game reserve protection (coordination cannot drain reserve).
 *   J. Residual sweep stays SOURCE_PAYS_GAS (regression).
 *   K. Accounting conservation for a complete game.
 *
 * No live blockchain: broadcasts, fee estimation, confirmation polling and
 * block production are simulated deterministically. No wallet secrets: dummy
 * test identities only.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createHash } from "node:crypto";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { RoomWalletAdapter } from "../payment/roomWallet/RoomWalletAdapter.js";
import { RoomWalletSettlementAdapter } from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import { PaymentSessionManager } from "../gameplay/PaymentSessionManager.js";
import { confirmPayoutOnChain } from "../payment/roomWallet/roomWalletTerminalRecoveryChain.js";
import {
    buildResidualSweep,
    ROOM_WALLET_POLICY,
    GRAM_NANO
} from "../payment/roomWallet/RoomWalletFinancialPolicy.js";
import { createDummyRoomWalletEntry } from "./helpers/dummyRoomWallet.js";

// Deterministic fee estimate served by the simulated chain. The four
// source_fees components sum exactly to FEE_TOTAL_NANO.
const FEE_IN_FWD_NANO = 400_000n;
const FEE_STORAGE_NANO = 100_000n;
const FEE_GAS_NANO = 300_000n;
const FEE_FWD_NANO = 200_000n;
const FEE_TOTAL_NANO = FEE_IN_FWD_NANO + FEE_STORAGE_NANO + FEE_GAS_NANO + FEE_FWD_NANO;

// Default policy margin: 20% (2000 bps) with a 0.001 GRAM absolute floor.
// For the stub estimate the floor dominates: charge = fee + floor.
const DEFAULT_MARGIN_BPS = 2_000n;
const DEFAULT_MARGIN_FLOOR_NANO = 1_000_000n;
const STUB_GAS_CHARGE_NANO = FEE_TOTAL_NANO + DEFAULT_MARGIN_FLOOR_NANO;

const WINNER_GROSS_NANO = 2_850_000_000n;
const OWNER_GROSS_NANO = 150_000_000n;
const OWNER_RETAINED_NANO = ROOM_WALLET_POLICY.ownerRetainedNano; // 0.01 GRAM
const OWNER_SHARE_NANO = OWNER_GROSS_NANO - OWNER_RETAINED_NANO;  // 0.14 GRAM
const WINNER_NET_NANO = WINNER_GROSS_NANO - STUB_GAS_CHARGE_NANO;
const OWNER_NET_NANO = OWNER_SHARE_NANO - STUB_GAS_CHARGE_NANO;
const PLAYER_STAKE_NANO = 1_000_000_000n;
const GAME_POT_NANO = 3n * PLAYER_STAKE_NANO;
const INITIAL_RESERVE_NANO = ROOM_WALLET_POLICY.initialRoomReserveNano; // 0.01 GRAM

// Base Unix-seconds clock of the simulated chain and the matching settlement
// request timestamp (milliseconds): transactions mined at exactly
// CHAIN_BASE_UTIME (the pot arrival) are before the cutoff; settlement
// broadcasts (+100s) are after it.
const CHAIN_BASE_UTIME = 1_700_000_000;
const SETTLEMENT_TIMESTAMP_MS = CHAIN_BASE_UTIME * 1000;

// Module-level capture list backing the createTransfer prototype patch
// installed by createSimulatedTonChain (see below).
const rpgCapturedTransfers = [];

const WINNER_WALLET = deriveWalletAddress("rpg-winner");
const OWNER_WALLET = deriveWalletAddress("rpg-owner");
const PLAYER_WALLET = deriveWalletAddress("rpg-player");

/**
 * Deterministic real WalletContractV4 addresses (the fee estimation builds
 * the exact outbound message, so every destination must be a parseable TON
 * address — no synthetic placeholders).
 */
function deriveWalletAddress(seedLabel) {
    const seed = createHash("sha256").update(seedLabel).digest();
    const keyPair = keyPairFromSeed(seed);
    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({ bounceable: true, urlSafe: true });
}

function settlementRequest(overrides = {}) {
    return {
        gameId: "game_recipient_pays_gas",
        roomNumber: 1,
        winnerWallet: WINNER_WALLET,
        ownerWallet: OWNER_WALLET,
        winnerAmountNano: WINNER_GROSS_NANO,
        organizerAmountNano: OWNER_GROSS_NANO,
        // Production requests carry the settlement session start timestamp,
        // which becomes the chain-inspection cutoff: only transactions after
        // the last player inbound count as settlement evidence.
        timestamp: SETTLEMENT_TIMESTAMP_MS,
        ...overrides
    };
}
/**
 * Deterministic in-memory TON chain implementing the tonService surface
 * consumed by RoomWalletAdapter and the settlement inspection chain:
 * getBalance / getSeqno / getTransactions / broadcastTransaction /
 * estimateExternalMessageFee. Broadcasts enter a pending pool;
 * produceBlock() mines them (seqno advance = positive confirmation).
 */
function createSimulatedTonChain({
    initialSeqno = 31,
    balanceNano = INITIAL_RESERVE_NANO,
    feeTotalNano = FEE_TOTAL_NANO
} = {}) {
    const entry = createDummyRoomWalletEntry(1);
    const state = {
        seqno: initialSeqno,
        balanceNano,
        broadcastCount: 0,
        estimateCallCount: 0,
        feeSpentNano: 0n,
        mined: [],
        pending: [],
        events: []
    };

    const identity = {
        roomNumber: 1,
        address: entry.address,
        publicKey: Buffer.from(entry.publicKey, "hex"),
        secretKey: Buffer.from(entry.secretKey, "hex"),
        workchain: 0,
        network: "testnet"
    };

    // Capture the exact signed transfer bodies the adapter builds. Fee
    // estimation also builds one (never broadcast); a broadcast always reads
    // the MOST RECENT capture, which is its own transfer body. The capture
    // list is module-level because the createTransfer patch on the prototype
    // is installed once for the whole test file.
    if (!WalletContractV4.prototype.__rpgCaptureInstalled) {
        const originalCreateTransfer = WalletContractV4.prototype.createTransfer;
        WalletContractV4.prototype.createTransfer = function createTransferCapture(args) {
            rpgCapturedTransfers.push(args);
            return originalCreateTransfer.call(this, args);
        };
        WalletContractV4.prototype.__rpgCaptureInstalled = true;
    }

    const chain = {
        identity,
        state,
        capturedTransfers: rpgCapturedTransfers,

        // Simulate the game pot (or any inbound transfer) arriving.
        // Returns the Unix-seconds utime of the arrival so callers can derive
        // the matching settlement cutoff timestamp.
        receiveTransfer({ from, valueNano }) {
            const utime = CHAIN_BASE_UTIME + state.mined.length;
            state.balanceNano += valueNano;
            state.mined.push({
                transaction_id: {
                    hash: `inbound-${state.mined.length}`,
                    lt: String(500 + state.mined.length)
                },
                utime,
                success: true,
                in_msg: { source: from, value: String(valueNano) }
            });
            return utime;
        },

        // Simulate a payout already confirmed on-chain (recovery evidence).
        preMineTransfer({ hash, destination, valueNano }) {
            state.mined.push({
                transaction_id: { hash, lt: String(900 + state.mined.length) },
                utime: 1_700_000_000 + state.mined.length,
                success: true,
                out_msgs: [{ destination, value: String(valueNano) }]
            });
        },

        produceBlock() {
            // Broadcasts mine immediately (see broadcastTransaction); this
            // hook remains for confirmation-loop sleep ticks and is a no-op.
        },

        tonService: {
            async getBalance() {
                return state.balanceNano;
            },
            async getSeqno() {
                return state.seqno;
            },
            async estimateExternalMessageFee() {
                state.estimateCallCount += 1;
                return {
                    source: "estimateExternalMessageFee",
                    inFwdFeeNano: FEE_IN_FWD_NANO,
                    storageFeeNano: FEE_STORAGE_NANO,
                    gasFeeNano: FEE_GAS_NANO,
                    fwdFeeNano: FEE_FWD_NANO,
                    totalFeeNano: feeTotalNano
                };
            },
            async getTransactions(_address, query = {}) {
                const limit = Number(query.limit ?? 20);
                // Newest-first, like the real TON history endpoints: the most
                // recent transactions are always within the requested limit.
                return state.mined.slice(-limit).reverse();
            },
            async broadcastTransaction() {
                state.broadcastCount += 1;
                const transferArgs = rpgCapturedTransfers[rpgCapturedTransfers.length - 1];
                assert.ok(transferArgs, "broadcast without a captured createTransfer");
                const message = transferArgs.messages[0];
                const destination = message.info.dest
                    .toString({ bounceable: true, urlSafe: true });
                const valueNano = message.info.value.coins;
                const hash = `sim-tx-${state.broadcastCount}-seq${transferArgs.seqno}`;
                state.events.push(`broadcast:${transferArgs.seqno}`);
                // Mine immediately: the refund confirmation path polls the
                // chain with real timers (the internal confirmPayoutOnChain
                // primitive), so the broadcast must be observable on the
                // simulated chain right away. Seqno advance on mining is the
                // authoritative positive-confirmation evidence.
                state.seqno += 1;
                state.balanceNano -= valueNano + feeTotalNano;
                state.feeSpentNano += feeTotalNano;
                state.mined.push({
                    transaction_id: { hash, lt: String(1000 + state.mined.length) },
                    // Monotonic with the mined-log length so per-game cutoffs
                    // (the pot arrival utime) separate each game's evidence.
                    utime: CHAIN_BASE_UTIME + state.mined.length,
                    success: true,
                    out_msgs: [{ destination, value: String(valueNano) }]
                });
                if (!Array.isArray(state.broadcastSeqnos)) {
                    state.broadcastSeqnos = [];
                }
                state.broadcastSeqnos.push(transferArgs.seqno);
                state.events.push(`mined:${hash}`);
                return { hash };
            }
        }
    };

    return chain;
}
/**
 * Real full stack: real RoomWalletAdapter + real RoomWalletSettlementAdapter
 * + the real confirmPayoutOnChain primitive, driven by a deterministic
 * virtual clock (every sleep tick produces a block).
 */
function createRealStackHarness({
    chain,
    seqnoConfirmTimeoutMs = 90_000,
    recipientGasMarginBps = DEFAULT_MARGIN_BPS,
    recipientGasMarginFloorNano = DEFAULT_MARGIN_FLOOR_NANO
} = {}) {
    let virtualNow = 0;
    const now = () => {
        virtualNow += 1_000;
        return virtualNow;
    };
    const produceBlock = () => chain.produceBlock();

    const roomWalletAdapter = new RoomWalletAdapter({
        tonService: chain.tonService,
        walletResolver: async () => chain.identity,
        logger: null,
        now,
        sleep: async () => produceBlock(),
        ...(seqnoConfirmTimeoutMs === 90_000 ? {} : { seqnoConfirmTimeoutMs })
    });

    const confirmPayout = async (args) => confirmPayoutOnChain({
        ...args,
        pollIntervalMs: 0,
        now,
        sleep: async () => produceBlock()
    });

    const settlementAdapter = new RoomWalletSettlementAdapter({
        roomWalletAdapter,
        logger: null,
        confirmPayout,
        ...(recipientGasMarginBps === DEFAULT_MARGIN_BPS ? {} : { recipientGasMarginBps }),
        ...(recipientGasMarginFloorNano === DEFAULT_MARGIN_FLOOR_NANO
            ? {}
            : { recipientGasMarginFloorNano })
    });

    return { roomWalletAdapter, settlementAdapter };
}
/**
 * Runs one complete game: the pot arrives, settlement broadcasts both payouts
 * and both are confirmed. Returns the accounting facts of the game.
 */
async function runCompleteGame({ chain, settlementAdapter, gameIndex } = {}) {
    const balanceBefore = chain.state.balanceNano;
    const potUtime = chain.receiveTransfer({ from: `player-${gameIndex}`, valueNano: GAME_POT_NANO });

    const result = await settlementAdapter.settleContract(settlementRequest({
        gameId: `game_recipient_pays_gas_${gameIndex}`,
        // Cutoff exactly at this game's pot arrival: only this game's
        // settlement broadcasts (mined strictly after the pot) count as
        // evidence — previous games' payouts carry identical amounts and
        // must not be adopted or counted as duplicates.
        timestamp: potUtime * 1000
    }));

    assert.equal(result.ok, true, `game ${gameIndex} settlement must succeed`);
    assert.equal(result.winnerConfirmed, true);
    assert.equal(result.ownerConfirmed, true);

    return {
        balanceBefore,
        winnerNetNano: BigInt(result.payoutPlan.winner.recipientTransferAmountNano),
        ownerNetNano: BigInt(result.payoutPlan.owner.recipientTransferAmountNano),
        winnerGasChargeNano: BigInt(result.payoutPlan.winner.recipientGasChargeNano),
        ownerGasChargeNano: BigInt(result.payoutPlan.owner.recipientGasChargeNano),
        ownerRetainedNano: BigInt(result.payoutPlan.owner.ownerRetainedNano),
        balanceAfter: chain.state.balanceNano,
        feeSpentNano: chain.state.feeSpentNano
    };
}

// ---------------------------------------------------------------------------
// A. Winner recipient-pays-gas
// ---------------------------------------------------------------------------

test("A. winner payout: gross unchanged, net = gross - gas charge, plan carries the evidence", async () => {
    const chain = createSimulatedTonChain({ balanceNano: 10n * GRAM_NANO });
    const { settlementAdapter } = createRealStackHarness({ chain });

    const planResult = await settlementAdapter.planSettlement(settlementRequest());

    assert.equal(planResult.ok, true);
    const plan = planResult.payoutPlan;
    assert.equal(plan.mode, "RECIPIENT_PAYS_GAS");
    assert.equal(plan.feeSource, "estimateExternalMessageFee");

    // Authoritative gross payout is unchanged.
    assert.equal(BigInt(plan.winner.grossPayoutNano), WINNER_GROSS_NANO);

    // Recipient gas charge = fee estimate + configured margin.
    assert.equal(BigInt(plan.winner.feeEvidence.totalNano), FEE_TOTAL_NANO);
    assert.equal(BigInt(plan.winner.recipientGasChargeNano), STUB_GAS_CHARGE_NANO);
    assert.equal(BigInt(plan.marginBps), DEFAULT_MARGIN_BPS);
    assert.equal(BigInt(plan.marginFloorNano), DEFAULT_MARGIN_FLOOR_NANO);

    // Recipient transfer value = gross - gas charge (strictly positive).
    assert.equal(BigInt(plan.winner.recipientTransferAmountNano), WINNER_NET_NANO);
    assert.ok(WINNER_NET_NANO > 0n);

    // On-chain broadcast carries exactly the net value.
    chain.receiveTransfer({ from: "player-a", valueNano: GAME_POT_NANO });
    const result = await settlementAdapter.settleContract(settlementRequest());
    assert.equal(result.ok, true);
    assert.equal(result.winnerNetTransferNano, WINNER_NET_NANO);
    assert.equal(chain.state.broadcastCount, 2);
    assert.equal(chain.state.feeSpentNano, 2n * FEE_TOTAL_NANO);
});

// ---------------------------------------------------------------------------
// B. Owner recipient-pays-gas
// ---------------------------------------------------------------------------

test("B. owner payout: gross share unchanged, 0.01 GRAM retention preserved, net = share - gas charge", async () => {
    const chain = createSimulatedTonChain({ balanceNano: 10n * GRAM_NANO });
    const { settlementAdapter } = createRealStackHarness({ chain });

    const planResult = await settlementAdapter.planSettlement(settlementRequest());
    const plan = planResult.payoutPlan;

    // Gross Owner share and the immutable retention rule are unchanged.
    assert.equal(BigInt(plan.owner.ownerGrossNano), OWNER_GROSS_NANO);
    assert.equal(BigInt(plan.owner.ownerRetainedNano), OWNER_RETAINED_NANO);
    assert.equal(BigInt(plan.owner.ownerShareAfterRetentionNano), OWNER_SHARE_NANO);
    assert.equal(OWNER_SHARE_NANO, ROOM_WALLET_POLICY.ownerPayoutMinimumNano);

    // Owner receives: gross share - retention - recipient gas charge.
    assert.equal(BigInt(plan.owner.grossPayoutNano), OWNER_SHARE_NANO);
    assert.equal(BigInt(plan.owner.recipientGasChargeNano), STUB_GAS_CHARGE_NANO);
    assert.equal(BigInt(plan.owner.recipientTransferAmountNano), OWNER_NET_NANO);
    assert.ok(OWNER_NET_NANO > 0n);

    chain.receiveTransfer({ from: "player-b", valueNano: GAME_POT_NANO });
    const result = await settlementAdapter.settleContract(settlementRequest());
    assert.equal(result.ok, true);
    assert.equal(result.ownerRetainedNano, OWNER_RETAINED_NANO);
    assert.equal(result.ownerNetTransferNano, OWNER_NET_NANO);
    assert.equal(chain.state.broadcastCount, 2);
});
// ---------------------------------------------------------------------------
// C. Refund recipient-pays-gas with persistence-before-broadcast recovery
// ---------------------------------------------------------------------------

test("C. refund: player receives refundable - gas charge; exact net frozen before broadcast and reused on recovery", async () => {
    const chain = createSimulatedTonChain({ balanceNano: INITIAL_RESERVE_NANO });
    const { roomWalletAdapter, settlementAdapter } = createRealStackHarness({ chain });
    chain.receiveTransfer({ from: "player-c", valueNano: PLAYER_STAKE_NANO });

    const refunds = [{
        playerId: "player-bob",
        playerIndex: 1,
        wallet: PLAYER_WALLET,
        amountNano: PLAYER_STAKE_NANO
    }];

    // 1. Plan computed WITHOUT broadcasting (compute-only capability).
    const planResult = await settlementAdapter.planRefunds({
        roomNumber: 1,
        refunds
    });
    assert.equal(planResult.ok, true);
    assert.equal(chain.state.broadcastCount, 0);
    const entry = planResult.refundPlan.entries[0];
    assert.equal(BigInt(entry.grossRefundNano), PLAYER_STAKE_NANO);
    assert.equal(BigInt(entry.recipientGasChargeNano), STUB_GAS_CHARGE_NANO);
    assert.equal(
        BigInt(entry.recipientTransferAmountNano),
        PLAYER_STAKE_NANO - STUB_GAS_CHARGE_NANO
    );

    // 2. refundPayments reuses the frozen plan: no re-estimation, exact net.
    const estimatesBefore = chain.state.estimateCallCount;
    const sent = await settlementAdapter.refundPayments({
        roomNumber: 1,
        refunds,
        refundPlan: planResult.refundPlan,
        cutoffUtime: 0
    });
    assert.equal(sent.ok, true);
    assert.equal(chain.state.estimateCallCount, estimatesBefore, "recovery must not re-estimate");
    assert.equal(chain.state.broadcastCount, 1);
    assert.equal(sent.results[0].code, "REFUND_CONFIRMED");
    assert.equal(sent.results[0].amountNano, PLAYER_STAKE_NANO - STUB_GAS_CHARGE_NANO);
    assert.equal(sent.results[0].grossRefundNano, PLAYER_STAKE_NANO);

    // 3. Idempotent retry with the SAME frozen plan adopts the on-chain
    //    refund instead of broadcasting a duplicate.
    const sentAgain = await settlementAdapter.refundPayments({
        roomNumber: 1,
        refunds,
        refundPlan: planResult.refundPlan,
        cutoffUtime: 0
    });
    assert.equal(sentAgain.ok, true);
    assert.equal(chain.state.broadcastCount, 1, "no second broadcast");
    assert.equal(sentAgain.results[0].code, "REFUND_ADOPTED");

    assert.ok(roomWalletAdapter);
});

test("C2. PaymentSessionManager freezes the refund plan BEFORE the first refund broadcast", async () => {
    const chain = createSimulatedTonChain({ balanceNano: INITIAL_RESERVE_NANO });
    const { settlementAdapter } = createRealStackHarness({ chain });
    chain.receiveTransfer({ from: "player-d", valueNano: PLAYER_STAKE_NANO });

    const persistCalls = [];
    const refundCalls = [];
    const pendingRefunds = [{
        playerId: "player-bob",
        playerIndex: 1,
        wallet: PLAYER_WALLET,
        amountNano: PLAYER_STAKE_NANO
    }];

    // Minimal PaymentSessionManager stub exposing only the plan-freezing
    // machinery (the method touches nothing else on `this`).
    const manager = Object.create(PaymentSessionManager.prototype);
    manager._roomWalletSettlementAdapter = settlementAdapter;
    manager._logger = null;
    manager._persistSession = (session, operation) => persistCalls.push(operation);

    const session = { roomId: "RPG", recoveryMetadata: {} };
    const refundRequestedAt = 1_700_000_000_500;

    const frozenPlan = await manager._ensureRoomWalletRefundPlanFrozen({
        session,
        roomNumber: 1,
        pendingRefunds,
        refundRequestedAt
    });

    // A durable plan exists and was persisted BEFORE any broadcast.
    assert.ok(frozenPlan);
    assert.equal(frozenPlan.mode, "RECIPIENT_PAYS_GAS");
    assert.deepEqual(persistCalls, ["update"]);
    assert.equal(session.recoveryMetadata.refundPlan, frozenPlan);
    assert.equal(chain.state.broadcastCount, 0);

    // The adapter receives the frozen plan and does not re-estimate.
    const estimatesBefore = chain.state.estimateCallCount;
    const result = await settlementAdapter.refundPayments({
        roomNumber: 1,
        refunds: pendingRefunds,
        refundPlan: frozenPlan,
        cutoffUtime: refundRequestedAt
    });
    assert.equal(result.ok, true);
    refundCalls.push(result.results[0].code);
    assert.equal(chain.state.estimateCallCount, estimatesBefore);
    assert.equal(result.results[0].code, "REFUND_CONFIRMED");
    assert.equal(result.results[0].amountNano, PLAYER_STAKE_NANO - STUB_GAS_CHARGE_NANO);
});
// ---------------------------------------------------------------------------
// D. Fee-estimation failure: FAIL CLOSED, no fallback, no broadcast
// ---------------------------------------------------------------------------

test("D. fee-estimation failure fails closed: no source-paid fallback and no broadcast", async () => {
    // Chain without any estimation capability.
    const chain = createSimulatedTonChain({ balanceNano: 10n * GRAM_NANO });
    delete chain.tonService.estimateExternalMessageFee;
    chain.receiveTransfer({ from: "player-e", valueNano: GAME_POT_NANO });

    const { settlementAdapter } = createRealStackHarness({ chain });

    const planResult = await settlementAdapter.planSettlement(settlementRequest());
    assert.equal(planResult.ok, false);
    assert.equal(planResult.retryable, true);
    assert.equal(planResult.code, "PAYOUT_GAS_ESTIMATE_UNAVAILABLE");

    const result = await settlementAdapter.settleContract(settlementRequest());
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.equal(result.code, "PAYOUT_GAS_ESTIMATE_UNAVAILABLE");
    assert.equal(result.payoutPlan, null);
    // NOTHING was broadcast and no source-funded gas fallback happened.
    assert.equal(chain.state.broadcastCount, 0);

    // Refunds fail closed the same way.
    const refundResult = await settlementAdapter.refundPayments({
        roomNumber: 1,
        refunds: [{
            playerId: "player-bob",
            playerIndex: 1,
            wallet: PLAYER_WALLET,
            amountNano: PLAYER_STAKE_NANO
        }]
    });
    assert.equal(refundResult.ok, false);
    assert.equal(refundResult.code, "PAYOUT_GAS_ESTIMATE_UNAVAILABLE");
    assert.equal(chain.state.broadcastCount, 0);
});

// ---------------------------------------------------------------------------
// E. Gas charge >= authoritative payout: FAIL CLOSED, no zero-value payout
// ---------------------------------------------------------------------------

test("E. gas charge greater than or equal to the payout fails closed with no broadcast", async () => {
    const chain = createSimulatedTonChain({ balanceNano: 10n * GRAM_NANO });
    const { settlementAdapter } = createRealStackHarness({ chain });

    // Winner gross (1.5 GRAM) minus... use a tiny gross so the 0.002 GRAM
    // gas charge consumes it entirely.
    const tinyWinnerGrossNano = 1_500_000n; // < STUB_GAS_CHARGE_NANO (2_000_000n)
    const result = await settlementAdapter.settleContract(settlementRequest({
        winnerAmountNano: tinyWinnerGrossNano
    }));

    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.equal(result.code, "RECIPIENT_GAS_EXCEEDS_PAYOUT");
    assert.equal(chain.state.broadcastCount, 0, "no zero-value payout is broadcast");

    // Pure policy view: the entry itself fails closed.
    const policy = await settlementAdapter.planSettlement(settlementRequest({
        winnerAmountNano: tinyWinnerGrossNano
    }));
    assert.equal(policy.ok, false);
    assert.equal(policy.code, "RECIPIENT_GAS_EXCEEDS_PAYOUT");
    assert.equal(policy.role, "WINNER");

    // Equality boundary: charge == payout also fails closed (net would be 0).
    const equalPlan = await settlementAdapter.planSettlement(settlementRequest({
        winnerAmountNano: STUB_GAS_CHARGE_NANO
    }));
    assert.equal(equalPlan.ok, false);
    assert.equal(equalPlan.code, "RECIPIENT_GAS_EXCEEDS_PAYOUT");
});

test("E2. frozen plan tampering fails closed as a non-retryable safety failure", async () => {
    const chain = createSimulatedTonChain({ balanceNano: 10n * GRAM_NANO });
    const { settlementAdapter } = createRealStackHarness({ chain });

    const planResult = await settlementAdapter.planSettlement(settlementRequest());
    const tampered = JSON.parse(JSON.stringify(planResult.payoutPlan));
    // Inflate the winner net value without touching the fee evidence.
    tampered.winner.recipientTransferAmountNano =
        (BigInt(tampered.winner.recipientTransferAmountNano) + 1_000_000n).toString(10);

    const result = await settlementAdapter.settleContract(settlementRequest({
        payoutPlan: tampered
    }));

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.code, "PAYOUT_PLAN_MISMATCH");
    assert.equal(chain.state.broadcastCount, 0);
});
// ---------------------------------------------------------------------------
// F. Exact recovery: reuse the persisted plan, never recompute
// ---------------------------------------------------------------------------

test("F. recovery reuses the exact persisted net amounts and never re-estimates", async () => {
    const chain = createSimulatedTonChain({ balanceNano: 10n * GRAM_NANO });
    const { settlementAdapter } = createRealStackHarness({ chain });

    // 1. Plan frozen once (this is what the settlement lifecycle persists).
    const planResult = await settlementAdapter.planSettlement(settlementRequest());
    assert.equal(planResult.ok, true);
    const frozenPlan = planResult.payoutPlan;
    const estimatesAfterPlan = chain.state.estimateCallCount;
    assert.ok(estimatesAfterPlan > 0);

    // 2. First settlement pass with the frozen plan: no new estimation.
    chain.receiveTransfer({ from: "player-f", valueNano: GAME_POT_NANO });
    const first = await settlementAdapter.settleContract(settlementRequest({
        payoutPlan: frozenPlan
    }));
    assert.equal(first.ok, true);
    assert.equal(chain.state.estimateCallCount, estimatesAfterPlan);

    // 3. Recovery pass on a FRESH chain (simulated restart) with the same
    //    frozen plan: winner already confirmed at the frozen net value,
    //    owner missing — the owner is sent the exact frozen net amount and
    //    the plan is NOT recomputed (zero estimation calls).
    const recoveryChain = createSimulatedTonChain({
        initialSeqno: 32,
        balanceNano: OWNER_NET_NANO + FEE_TOTAL_NANO
    });
    recoveryChain.receiveTransfer({ from: "player-f", valueNano: GAME_POT_NANO });
    recoveryChain.preMineTransfer({
        hash: "pre-confirmed-winner",
        destination: WINNER_WALLET,
        valueNano: WINNER_NET_NANO
    });
    const recoveryHarness = createRealStackHarness({ chain: recoveryChain });

    const recovery = await recoveryHarness.settlementAdapter.settleContract(settlementRequest({
        payoutPlan: frozenPlan
    }));

    assert.equal(recovery.ok, true);
    assert.equal(recovery.code, "SETTLEMENT_BROADCAST");
    assert.equal(recovery.winner?.txHash, "pre-confirmed-winner", "winner not resent");
    assert.equal(recovery.ownerNetTransferNano, OWNER_NET_NANO);
    assert.equal(recoveryChain.state.broadcastCount, 1);
    assert.equal(
        recoveryChain.state.estimateCallCount,
        0,
        "recovery must not recompute a new gas charge"
    );

    // 4. Determinism: computing the plan twice produces byte-identical
    //    persisted values.
    const again = await settlementAdapter.planSettlement(settlementRequest());
    assert.deepEqual(again.payoutPlan, frozenPlan);
});

// ---------------------------------------------------------------------------
// G. Partial settlement: winner confirmed, owner missing
// ---------------------------------------------------------------------------

test("G. partial settlement sends ONLY the missing owner payout at its persisted net value", async () => {
    const chain = createSimulatedTonChain({
        initialSeqno: 32,
        balanceNano: OWNER_NET_NANO + FEE_TOTAL_NANO
    });
    chain.receiveTransfer({ from: "player-g", valueNano: GAME_POT_NANO });
    chain.preMineTransfer({
        hash: "winner-already-paid",
        destination: WINNER_WALLET,
        valueNano: WINNER_NET_NANO
    });
    const { settlementAdapter } = createRealStackHarness({ chain });

    const planResult = await settlementAdapter.planSettlement(settlementRequest());
    assert.equal(planResult.ok, true);
    const frozenPlan = planResult.payoutPlan;
    const estimatesAfterPlan = chain.state.estimateCallCount;

    const result = await settlementAdapter.settleContract(settlementRequest({
        payoutPlan: frozenPlan
    }));

    assert.equal(result.ok, true);
    assert.equal(result.code, "SETTLEMENT_BROADCAST");
    assert.equal(result.winnerConfirmed, true);
    assert.equal(result.ownerConfirmed, true);
    assert.equal(result.winner?.txHash, "winner-already-paid");
    assert.equal(result.ownerNetTransferNano, OWNER_NET_NANO);
    // Exactly one broadcast: the owner payout at the frozen net value, and
    // NO new fee estimation — the frozen plan was reused as-is.
    assert.equal(chain.state.broadcastCount, 1);
    assert.equal(chain.state.estimateCallCount, estimatesAfterPlan);
    // Balance math: pot + pre-gate balance - owner net - owner fee.
    assert.equal(
        chain.state.balanceNano,
        GAME_POT_NANO + (OWNER_NET_NANO + FEE_TOTAL_NANO) - OWNER_NET_NANO - FEE_TOTAL_NANO
    );
});
// ---------------------------------------------------------------------------
// H. Seqno sequencing survives the gas policy change
// ---------------------------------------------------------------------------

test("H. seqno sequencing 31 -> confirmed -> 32 remains intact with recipient-pays-gas", async () => {
    const chain = createSimulatedTonChain({ initialSeqno: 31, balanceNano: 10n * GRAM_NANO });
    const { settlementAdapter, roomWalletAdapter } = createRealStackHarness({ chain });

    chain.receiveTransfer({ from: "player-h", valueNano: GAME_POT_NANO });

    const result = await settlementAdapter.settleContract(settlementRequest());
    assert.equal(result.ok, true);

    // Winner used 31; the owner transfer waited for the winner's on-chain
    // confirmation and used the freshly advanced seqno 32 — never a reuse.
    assert.deepEqual(chain.state.broadcastSeqnos, [31, 32]);
    assert.equal(roomWalletAdapter.getGasReserveNano(), ROOM_WALLET_POLICY.initialRoomReserveNano);
});

// ---------------------------------------------------------------------------
// I. Repeated-game reserve protection
// ---------------------------------------------------------------------------

test("I. repeated coordinated games cannot drain the pre-funded reserve — each pot funds its own gas", async () => {
    // The Room Wallet starts with EXACTLY the pre-funded safety reserve
    // (0.01 GRAM) and nothing else. 25 consecutive games are played.
    const GAME_COUNT = 25;
    const chain = createSimulatedTonChain({ balanceNano: INITIAL_RESERVE_NANO });
    const { settlementAdapter } = createRealStackHarness({ chain });

    let previousBalance = chain.state.balanceNano;

    for (let gameIndex = 1; gameIndex <= GAME_COUNT; gameIndex += 1) {
        const game = await runCompleteGame({ chain, settlementAdapter, gameIndex });

        // The pre-funded reserve is NEVER consumed: after every game the
        // wallet balance is at least the initial reserve, and in fact grows.
        assert.ok(
            game.balanceAfter >= INITIAL_RESERVE_NANO,
            `reserve drained at game ${gameIndex}`
        );
        assert.ok(
            game.balanceAfter > previousBalance,
            `wallet balance must grow when each pot funds its own gas (game ${gameIndex})`
        );

        // Per-game conservation (see test K for the exact identity):
        // pot = winner net + owner net + retention + actual fees + surplus.
        const actualFees = 2n * FEE_TOTAL_NANO;
        const surplus = game.winnerGasChargeNano + game.ownerGasChargeNano - actualFees;
        assert.equal(
            GAME_POT_NANO,
            game.winnerNetNano
                + game.ownerNetNano
                + game.ownerRetainedNano
                + actualFees
                + surplus
        );

        previousBalance = game.balanceAfter;
    }

    // After 25 games the reserve is intact and the wallet has accumulated
    // exactly the retention + gas-charge surplus from every game.
    const perGameRetained = OWNER_RETAINED_NANO + (2n * STUB_GAS_CHARGE_NANO - 2n * FEE_TOTAL_NANO);
    assert.equal(
        chain.state.balanceNano,
        INITIAL_RESERVE_NANO + BigInt(GAME_COUNT) * perGameRetained
    );
    // Total gas actually spent by the wallet was fully covered by the
    // recipient gas charges collected from each game's payouts.
    assert.equal(chain.state.feeSpentNano, BigInt(GAME_COUNT) * 2n * FEE_TOTAL_NANO);
    assert.ok(chain.state.feeSpentNano < BigInt(GAME_COUNT) * 2n * STUB_GAS_CHARGE_NANO);
});
// ---------------------------------------------------------------------------
// J. Residual sweep stays SOURCE_PAYS_GAS (operational transfer regression)
// ---------------------------------------------------------------------------

test("J. residual sweep keeps source-pays-gas semantics: exact 0.49 GRAM recipient value, 0.01 GRAM envelope", async () => {
    const chain = createSimulatedTonChain({ balanceNano: INITIAL_RESERVE_NANO });
    const { roomWalletAdapter } = createRealStackHarness({ chain });

    // Sweep eligibility is unchanged and recipient value is never reduced.
    const eligibility = buildResidualSweep({ balanceNano: ROOM_WALLET_POLICY.residualTriggerNano });
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.transferNano, ROOM_WALLET_POLICY.residualSweepNano);
    assert.equal(eligibility.recipientCreditNano, ROOM_WALLET_POLICY.residualSweepNano);
    assert.equal(ROOM_WALLET_POLICY.residualSweepNano, 490_000_000n);
    assert.equal(ROOM_WALLET_POLICY.residualTriggerNano, 500_000_000n);
    assert.equal(ROOM_WALLET_POLICY.residualRetainedFloorNano, 10_000_000n);

    // A sweep send is gated by the SOURCE-side envelope (0.01 GRAM), not by
    // any recipient-pays-gas deduction: the full 0.49 GRAM reaches the
    // Residues destination and the source wallet pays the fee itself.
    chain.receiveTransfer({
        from: "owner-topup",
        valueNano: ROOM_WALLET_POLICY.residualTriggerNano - INITIAL_RESERVE_NANO
    });
    const balanceBefore = chain.state.balanceNano; // 0.50 GRAM
    assert.equal(balanceBefore, ROOM_WALLET_POLICY.residualTriggerNano);

    const sent = await roomWalletAdapter.sendTransfer({
        roomNumber: 1,
        destination: PLAYER_WALLET, // sweep destination stand-in
        amountNano: ROOM_WALLET_POLICY.residualSweepNano,
        sourceReserveNano: ROOM_WALLET_POLICY.residualRetainedFloorNano
    });

    assert.equal(sent.ok, true);
    assert.equal(sent.amountNano, 490_000_000n, "recipient value is never reduced");
    assert.equal(sent.gasReserveNano, 10_000_000n);
    chain.produceBlock();
    // Source wallet paid 0.49 + actual fee itself: no gas charge was retained.
    assert.equal(
        chain.state.balanceNano,
        balanceBefore - ROOM_WALLET_POLICY.residualSweepNano - FEE_TOTAL_NANO
    );
});

// ---------------------------------------------------------------------------
// K. Accounting conservation for a complete game
// ---------------------------------------------------------------------------

test("K. conservation: pot = winner net + owner net + retention + actual fees + residual remainder", async () => {
    const chain = createSimulatedTonChain({ balanceNano: INITIAL_RESERVE_NANO });
    const { settlementAdapter } = createRealStackHarness({ chain });

    const game = await runCompleteGame({ chain, settlementAdapter, gameIndex: 1 });
    const actualFees = 2n * FEE_TOTAL_NANO;
    const residualRemainder = game.winnerGasChargeNano + game.ownerGasChargeNano - actualFees;

    // Exact arithmetic identity for one complete game.
    assert.equal(
        GAME_POT_NANO,
        game.winnerNetNano
            + game.ownerNetNano
            + game.ownerRetainedNano
            + actualFees
            + residualRemainder
    );

    // The same identity holds against the observed wallet balance: the
    // wallet started with the reserve and kept retention + surplus.
    assert.equal(
        game.balanceAfter,
        INITIAL_RESERVE_NANO + game.ownerRetainedNano + residualRemainder
    );

    // Gross = net + gas charge for each payout (margin included in charge).
    assert.equal(game.winnerNetNano + game.winnerGasChargeNano, WINNER_GROSS_NANO);
    assert.equal(
        game.ownerNetNano + game.ownerGasChargeNano,
        OWNER_GROSS_NANO - OWNER_RETAINED_NANO
    );
});

// Exported for focused debugging probes only (node --test ignores exports).
export { createSimulatedTonChain, createRealStackHarness, settlementRequest };


