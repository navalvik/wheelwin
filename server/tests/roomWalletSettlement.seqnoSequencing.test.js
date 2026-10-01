/**
 * Sequential Room Wallet settlement seqno-safety regression tests.
 *
 * Production incident (game_8b040e1c-1007-463f-bde7-8056c6dd3124, room "iHud",
 * Room Wallet number 1): the winner payout (4270000000 nano) and the owner
 * payout (220000000 nano) were broadcast almost simultaneously as TWO
 * independent external messages using the SAME Room Wallet seqno (31). The
 * wallet accepted the first message and silently dropped the second, so Bob
 * was paid and the Owner was not. Recovery then failed repeatedly with
 * INSUFFICIENT_ROOM_WALLET_BALANCE because the retry still required funding
 * for the already-completed winner payout.
 *
 * These tests prove the fixed behaviour:
 *  1. two independent outbound transfers can never use the same seqno;
 *  2. the owner payout is submitted only after the winner payout is
 *     positively confirmed on-chain (existing confirmPayoutOnChain primitive);
 *  3. winner-confirmed / owner-missing recovery resends ONLY the owner payout;
 *  4. recovery preflight requires only the owner payout plus the source
 *     wallet gas reserve — never the already-paid winner amount;
 *  5. recovery uses a fresh authoritative seqno;
 *  6. a second transfer is refused (fail-closed) while a previous broadcast
 *     from the same wallet is unconfirmed;
 *  7. WALLET_REUSED / DUPLICATE_PAYOUT fail-closed evidence guards hold.
 *
 * No live network: broadcasts, confirmation polling and block production are
 * simulated deterministically. No wallet secrets: dummy test identities only.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { RoomWalletAdapter } from "../payment/roomWallet/RoomWalletAdapter.js";
import {
    ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES,
    RoomWalletSettlementAdapter
} from "../payment/roomWallet/RoomWalletSettlementAdapter.js";
import { confirmPayoutOnChain } from "../payment/roomWallet/roomWalletTerminalRecoveryChain.js";
import {
    GRAM_NANO,
    ROOM_WALLET_POLICY
} from "../payment/roomWallet/RoomWalletFinancialPolicy.js";
import { createDummyRoomWalletEntry } from "./helpers/dummyRoomWallet.js";

// Exact production settlement amounts (payout economics are NOT changed).
const PRODUCTION_GAME_ID = "game_8b040e1c-1007-463f-bde7-8056c6dd3124";
const WINNER_AMOUNT_NANO = 4_270_000_000n;
const OWNER_GROSS_NANO = 230_000_000n;
const OWNER_PAYOUT_NANO = 220_000_000n;
const OWNER_RETAINED_NANO = ROOM_WALLET_POLICY.ownerRetainedNano;

// Deterministic recipient-pays-gas stub estimate served by the simulated
// chain (components sum exactly to STUB_FEE_TOTAL_NANO). With the default
// policy margin (20%, floor 1000000) the frozen recipient gas charge is
// STUB_GAS_CHARGE_NANO and the on-chain transfer value is gross minus that
// charge. The authoritative gross amounts above are unchanged.
const STUB_FEE_TOTAL_NANO = 1_000_000n;
const STUB_GAS_CHARGE_NANO = 2_000_000n;
const WINNER_NET_NANO = WINNER_AMOUNT_NANO - STUB_GAS_CHARGE_NANO;
const OWNER_NET_NANO = OWNER_PAYOUT_NANO - STUB_GAS_CHARGE_NANO;

function deriveWalletAddress(seedLabel) {
    const seed = createHash("sha256").update(seedLabel).digest();
    const keyPair = keyPairFromSeed(seed);
    return WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey
    }).address.toString({ bounceable: true, urlSafe: true });
}

const WINNER_WALLET = deriveWalletAddress("seqno-fix-winner");
const OWNER_WALLET = deriveWalletAddress("seqno-fix-owner");

function productionSettlementRequest() {
    return {
        gameId: PRODUCTION_GAME_ID,
        roomNumber: 1,
        winnerWallet: WINNER_WALLET,
        ownerWallet: OWNER_WALLET,
        winnerAmountNano: WINNER_AMOUNT_NANO,
        organizerAmountNano: OWNER_GROSS_NANO
    };
}

/**
 * Deterministic in-memory TON chain implementing the exact tonService surface
 * consumed by RoomWalletAdapter and the settlement inspection chain:
 * getBalance / getSeqno / getTransactions / broadcastTransaction.
 *
 * Broadcasts enter a pending pool. `produceBlock()` mines all pending
 * transactions: the wallet seqno advances (authoritative confirmation of the
 * accepted external message) and the transaction becomes visible to
 * getTransactions. Tests call produceBlock through the injected sleep hooks,
 * so every confirmation is an explicit, observable chain event.
 */
function createSimulatedTonChain({
    initialSeqno = 31,
    balanceNano = 5n * GRAM_NANO,
    gasPerTransferNano = ROOM_WALLET_POLICY.initialRoomReserveNano
} = {}) {
    const entry = createDummyRoomWalletEntry(1);
    const state = {
        seqno: initialSeqno,
        balanceNano,
        broadcastCount: 0,
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

    const capturedTransfers = [];
    // Captures associated with an actual broadcastTransaction call. Fee
    // estimation builds the same signed transfer body WITHOUT broadcasting,
    // so those captures are deliberately excluded from the broadcast view.
    const broadcastCaptures = [];
    let originalCreateTransfer = null;

    const chain = {
        identity,
        state,

        installTransferSpy() {
            originalCreateTransfer = WalletContractV4.prototype.createTransfer;
            WalletContractV4.prototype.createTransfer = function createTransferSpy(args) {
                capturedTransfers.push(args);
                return originalCreateTransfer.call(this, args);
            };
        },

        uninstallTransferSpy() {
            if (originalCreateTransfer) {
                WalletContractV4.prototype.createTransfer = originalCreateTransfer;
                originalCreateTransfer = null;
            }
        },

        broadcastSeqnos() {
            return broadcastCaptures.map((transfer) => transfer.seqno);
        },

        capturedTransferValue(index) {
            return broadcastCaptures[index - 1].messages[0].info.value.coins;
        },

        capturedTransferDestination(index) {
            return broadcastCaptures[index - 1].messages[0].info.dest
                .toString({ bounceable: true, urlSafe: true });
        },

        produceBlock() {
            while (state.pending.length > 0) {
                const pendingTx = state.pending.shift();
                state.seqno += 1;
                state.mined.push(pendingTx.tx);
                state.balanceNano -= pendingTx.valueNano + gasPerTransferNano;
                state.events.push(`mined:${pendingTx.hash}`);
            }
        },

        preMineTransfer({ hash, destination, valueNano }) {
            state.mined.push({
                transaction_id: { hash, lt: String(900 + state.mined.length) },
                utime: 1_700_000_000 + state.mined.length,
                success: true,
                out_msgs: [{ destination, value: String(valueNano) }]
            });
        },

        tonService: {
            async getBalance() {
                return state.balanceNano;
            },
            async estimateExternalMessageFee() {
                return {
                    source: "estimateExternalMessageFee",
                    inFwdFeeNano: 400_000n,
                    storageFeeNano: 100_000n,
                    gasFeeNano: 300_000n,
                    fwdFeeNano: 200_000n,
                    totalFeeNano: STUB_FEE_TOTAL_NANO
                };
            },
            async getSeqno() {
                return state.seqno;
            },
            async getTransactions(_address, query = {}) {
                const limit = Number(query.limit ?? 20);
                return state.mined.slice(0, limit);
            },
            async broadcastTransaction() {
                state.broadcastCount += 1;
                // The broadcast's transfer body is the MOST RECENT capture:
                // _sendTransferLocked builds the signed message immediately
                // before broadcasting (fee-estimation captures never reach
                // this point because they never broadcast).
                const transferArgs = capturedTransfers[capturedTransfers.length - 1];
                broadcastCaptures.push(transferArgs);
                assert.ok(transferArgs, "broadcast without a captured createTransfer");
                const message = transferArgs.messages[0];
                const destination = message.info.dest
                    .toString({ bounceable: true, urlSafe: true });
                const valueNano = message.info.value.coins;
                const hash = `sim-tx-${state.broadcastCount}-seq${transferArgs.seqno}`;
                state.events.push(`broadcast:${transferArgs.seqno}`);
                state.pending.push({
                    hash,
                    seqnoUsed: transferArgs.seqno,
                    valueNano,
                    tx: {
                        transaction_id: { hash, lt: String(1000 + state.mined.length) },
                        utime: 1_700_000_000 + 100 + state.mined.length,
                        success: true,
                        out_msgs: [{ destination, value: String(valueNano) }]
                    }
                });
                return { hash };
            }
        }
    };

    return chain;
}

/**
 * Real full stack: real RoomWalletAdapter + real RoomWalletSettlementAdapter
 * + the real confirmPayoutOnChain primitive, all driven by a deterministic
 * virtual clock. Every sleep() tick produces a block, so confirmations are
 * observed without real waiting and without weakening the matching logic.
 */
function createRealStackHarness({ chain, seqnoConfirmTimeoutMs = 90_000 } = {}) {
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

    const confirmPayout = async (args) => {
        chain.state.events.push(`confirm:${args.amountNano}`);
        const result = await confirmPayoutOnChain({
            ...args,
            pollIntervalMs: 0,
            now,
            sleep: async () => produceBlock()
        });
        chain.state.events.push(`confirmed:${args.amountNano}:${result.ok === true}`);
        return result;
    };

    const settlementAdapter = new RoomWalletSettlementAdapter({
        roomWalletAdapter,
        logger: null,
        confirmPayout
    });

    return { roomWalletAdapter, settlementAdapter };
}

test("PRODUCTION EVIDENCE: owner payout must not reuse winner seqno 31 and waits for winner confirmation", async () => {
    const chain = createSimulatedTonChain({
        initialSeqno: 31,
        balanceNano: 5n * GRAM_NANO
    });
    chain.installTransferSpy();

    try {
        const { settlementAdapter } = createRealStackHarness({ chain });

        const result = await settlementAdapter.settleContract(productionSettlementRequest());

        // 1. Two independent external transactions were produced.
        const seqnos = chain.broadcastSeqnos();
        assert.equal(seqnos.length, 2);

        // 2. The winner payout used the authoritative seqno 31.
        assert.equal(seqnos[0], 31);

        // 3. The second transaction MUST NOT reuse seqno 31: it waited for the
        //    authoritative confirmation and used the freshly advanced seqno.
        assert.notEqual(seqnos[1], 31);
        assert.equal(seqnos[1], 32);

        // 4. The owner broadcast happened strictly AFTER the winner transfer
        //    was mined (positively observed on-chain).
        const events = chain.state.events;
        const winnerBroadcastIndex = events.indexOf("broadcast:31");
        const winnerMinedIndex = events.indexOf("mined:sim-tx-1-seq31");
        const ownerBroadcastIndex = events.indexOf("broadcast:32");
        assert.ok(winnerBroadcastIndex !== -1);
        assert.ok(winnerMinedIndex > winnerBroadcastIndex);
        assert.ok(ownerBroadcastIndex > winnerMinedIndex);

        // 5. Winner payout was positively confirmed before the owner payout
        //    was submitted (confirm:winner event precedes broadcast:32).
        const winnerConfirmIndex = events.indexOf(`confirm:${WINNER_NET_NANO}`);
        assert.ok(winnerConfirmIndex !== -1);
        assert.ok(winnerConfirmIndex < ownerBroadcastIndex);
        assert.equal(events.includes(`confirmed:${WINNER_NET_NANO}:true`), true);

        // 6. Settlement completes only after both payouts are confirmed.
        assert.equal(result.ok, true);
        assert.equal(result.code, "SETTLEMENT_BROADCAST");
        assert.equal(result.winnerConfirmed, true);
        assert.equal(result.ownerConfirmed, true);
        assert.equal(result.winnerConfirmation?.observed, true);
        assert.equal(result.ownerConfirmation?.observed, true);

        // 7. Payout economics unchanged at the accounting level: the winner's
        //    authoritative gross amount and the owner's gross share minus the
        //    retained 0.01 Gram stay exactly as before. The on-chain transfer
        //    value is gross minus the frozen recipient gas charge
        //    (RECIPIENT_PAYS_GAS); the Room Wallet remains the sender and the
        //    game economics fund the source-side fee.
        assert.equal(result.winnerAmountNano, WINNER_AMOUNT_NANO);
        assert.equal(result.ownerGrossNano, OWNER_GROSS_NANO);
        assert.equal(result.ownerPayoutNano, OWNER_PAYOUT_NANO);
        assert.equal(result.ownerRetainedNano, OWNER_RETAINED_NANO);
        assert.equal(result.payoutPlan?.mode, "RECIPIENT_PAYS_GAS");
        assert.equal(BigInt(result.payoutPlan.winner.grossPayoutNano), WINNER_AMOUNT_NANO);
        assert.equal(BigInt(result.payoutPlan.owner.ownerGrossNano), OWNER_GROSS_NANO);
        assert.equal(BigInt(result.payoutPlan.owner.ownerRetainedNano), OWNER_RETAINED_NANO);
        assert.equal(BigInt(result.payoutPlan.winner.recipientGasChargeNano), STUB_GAS_CHARGE_NANO);
        assert.equal(BigInt(result.payoutPlan.owner.recipientGasChargeNano), STUB_GAS_CHARGE_NANO);
        assert.equal(chain.capturedTransferValue(1), WINNER_NET_NANO);
        assert.equal(chain.capturedTransferValue(2), OWNER_NET_NANO);
        assert.equal(chain.capturedTransferDestination(1), WINNER_WALLET);
        assert.equal(chain.capturedTransferDestination(2), OWNER_WALLET);

        // 8. Owner payout is positively confirmed on-chain too.
        assert.equal(events.includes(`confirmed:${OWNER_NET_NANO}:true`), true);
    } finally {
        chain.uninstallTransferSpy();
    }
});

test("PRODUCTION EVIDENCE: concurrent transfers cannot interleave the same seqno", async () => {
    const chain = createSimulatedTonChain({
        initialSeqno: 31,
        balanceNano: 5n * GRAM_NANO
    });
    chain.installTransferSpy();

    try {
        const { roomWalletAdapter } = createRealStackHarness({ chain });

        // Both transfers are started without awaiting the first one: the
        // per-address queue must serialize them behind the confirmation gate.
        const firstPromise = roomWalletAdapter.sendTransfer({
            roomNumber: 1,
            destination: WINNER_WALLET,
            amountNano: WINNER_AMOUNT_NANO
        });
        const secondPromise = roomWalletAdapter.sendTransfer({
            roomNumber: 1,
            destination: OWNER_WALLET,
            amountNano: OWNER_PAYOUT_NANO
        });

        const [first, second] = await Promise.all([firstPromise, secondPromise]);

        assert.equal(first.ok, true);
        assert.equal(first.seqno, 31);
        assert.equal(second.ok, true);
        assert.equal(second.seqno, 32);
        assert.deepEqual(chain.broadcastSeqnos(), [31, 32]);
    } finally {
        chain.uninstallTransferSpy();
    }
});

test("RECOVERY: winner already confirmed, owner missing — ONLY the owner payout is sent with a fresh seqno", async () => {
    const chain = createSimulatedTonChain({
        // The winner payout already consumed seqno 31; the chain is at 32.
        initialSeqno: 32,
        // Post-winner Room Wallet balance funds ONLY the owner net payout
        // plus its estimated source-side fee budget (the winner payout was
        // pre-mined at the legacy gross amount and is adopted as evidence).
        balanceNano: OWNER_NET_NANO + STUB_FEE_TOTAL_NANO
    });
    chain.preMineTransfer({
        hash: "pre-confirmed-winner",
        destination: WINNER_WALLET,
        valueNano: WINNER_AMOUNT_NANO
    });
    chain.installTransferSpy();

    try {
        const { settlementAdapter } = createRealStackHarness({ chain });

        const result = await settlementAdapter.settleContract(productionSettlementRequest());

        // The winner payout was NOT resent.
        assert.equal(chain.state.broadcastCount, 1);
        assert.deepEqual(chain.broadcastSeqnos(), [32]);
        assert.equal(chain.capturedTransferValue(1), OWNER_NET_NANO);
        assert.equal(chain.capturedTransferDestination(1), OWNER_WALLET);

        // The owner payout used a fresh authoritative seqno.
        assert.equal(result.ok, true);
        assert.equal(result.code, "SETTLEMENT_BROADCAST");
        assert.equal(result.winnerConfirmed, true);
        assert.equal(result.ownerConfirmed, true);
        assert.equal(result.winner?.txHash, "pre-confirmed-winner");
        assert.equal(result.ownerPayoutNano, OWNER_PAYOUT_NANO);
        assert.equal(result.ownerRetainedNano, OWNER_RETAINED_NANO);
        assert.equal(result.ownerNetTransferNano, OWNER_NET_NANO);
    } finally {
        chain.uninstallTransferSpy();
    }
});

test("RECOVERY: preflight requires only owner net payout plus fee budget, never the winner amount", async () => {
    const chain = createSimulatedTonChain({
        initialSeqno: 32,
        // One nano short of the owner NET payout + its estimated fee budget.
        balanceNano: OWNER_NET_NANO + STUB_FEE_TOTAL_NANO - 1n
    });
    chain.preMineTransfer({
        hash: "pre-confirmed-winner",
        destination: WINNER_WALLET,
        valueNano: WINNER_AMOUNT_NANO
    });
    chain.installTransferSpy();

    try {
        const { settlementAdapter } = createRealStackHarness({ chain });

        const result = await settlementAdapter.settleContract(productionSettlementRequest());

        // Fail-closed with the partial (owner-only) requirement exposed.
        assert.equal(result.ok, false);
        assert.equal(result.code, ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.INSUFFICIENT_ROOM_WALLET_BALANCE);
        assert.equal(result.preflight.remainingOnly, true);
        assert.equal(result.preflight.winnerPayoutAlreadyOnChain, true);
        assert.equal(result.preflight.excludedWinnerAmountNano, WINNER_AMOUNT_NANO);
        assert.equal(
            result.preflight.requiredNano,
            OWNER_NET_NANO + STUB_FEE_TOTAL_NANO
        );
        assert.equal(result.preflight.shortfallNano, 1n);

        // The already-confirmed winner was not resent and nothing was sent.
        assert.equal(chain.state.broadcastCount, 0);
        assert.deepEqual(chain.broadcastSeqnos(), []);
    } finally {
        chain.uninstallTransferSpy();
    }
});

test("SEQNO HOLD: a second transfer is refused while the first is unconfirmed, then released after confirmation", async () => {
    const chain = createSimulatedTonChain({
        initialSeqno: 31,
        balanceNano: 5n * GRAM_NANO
    });
    chain.installTransferSpy();

    try {
        let virtualNow = 0;
        const now = () => {
            virtualNow += 1_000;
            return virtualNow;
        };

        // This adapter's sleep does NOT produce blocks: the chain stays at
        // seqno 31 while the first transfer is unconfirmed.
        const adapter = new RoomWalletAdapter({
            tonService: chain.tonService,
            walletResolver: async () => chain.identity,
            logger: null,
            seqnoConfirmTimeoutMs: 5_000,
            now,
            sleep: async () => {}
        });

        const first = await adapter.sendTransfer({
            roomNumber: 1,
            destination: WINNER_WALLET,
            amountNano: 1_000_000_000n
        });
        assert.equal(first.ok, true);
        assert.equal(first.seqno, 31);

        const second = await adapter.sendTransfer({
            roomNumber: 1,
            destination: OWNER_WALLET,
            amountNano: 1_000_000_000n
        });

        // Fail-closed: the possibly-reused seqno was never signed.
        assert.equal(second.ok, false);
        assert.equal(second.code, "SEQNO_CONFIRMATION_TIMEOUT");
        assert.equal(second.pendingSeqno, 31);
        assert.equal(chain.state.broadcastCount, 1);
        assert.deepEqual(chain.broadcastSeqnos(), [31]);

        // Once the chain confirms the first transfer, the hold releases and
        // the next send uses the fresh authoritative seqno.
        chain.produceBlock();
        const third = await adapter.sendTransfer({
            roomNumber: 1,
            destination: OWNER_WALLET,
            amountNano: 1_000_000_000n
        });
        assert.equal(third.ok, true);
        assert.equal(third.seqno, 32);
        assert.deepEqual(chain.broadcastSeqnos(), [31, 32]);
    } finally {
        chain.uninstallTransferSpy();
    }
});

test("SEQNO HOLD: fails closed when the chain seqno read is unavailable", async () => {
    const chain = createSimulatedTonChain({
        initialSeqno: 31,
        balanceNano: 5n * GRAM_NANO
    });
    chain.installTransferSpy();

    try {
        const tonServiceWithoutSeqno = {
            getBalance: chain.tonService.getBalance.bind(chain.tonService),
            getTransactions: chain.tonService.getTransactions.bind(chain.tonService),
            broadcastTransaction: chain.tonService.broadcastTransaction.bind(chain.tonService)
        };

        const adapter = new RoomWalletAdapter({
            tonService: tonServiceWithoutSeqno,
            walletResolver: async () => chain.identity,
            logger: null
        });

        // Without a readable seqno the first send falls back to the fresh
        // wallet behaviour (seqno 0 with StateInit) and is allowed.
        const first = await adapter.sendTransfer({
            roomNumber: 1,
            destination: WINNER_WALLET,
            amountNano: 1_000_000_000n
        });
        assert.equal(first.ok, true);
        assert.equal(first.seqno, 0);

        // A second send cannot prove the first message was accepted — it must
        // not risk reusing seqno 0 and therefore fails closed.
        const second = await adapter.sendTransfer({
            roomNumber: 1,
            destination: OWNER_WALLET,
            amountNano: 1_000_000_000n
        });
        assert.equal(second.ok, false);
        assert.equal(second.code, "SEQNO_CONFIRMATION_UNAVAILABLE");
        assert.equal(second.pendingSeqno, 0);
        assert.equal(chain.state.broadcastCount, 1);
    } finally {
        chain.uninstallTransferSpy();
    }
});

/**
 * Settlement-adapter level harness. Mocked Room Wallet adapter with full
 * observation capability, mocked chain history that reflects what the mock
 * actually sent, and a mocked confirmation primitive recording call order.
 */
function createMockSettlementHarness({
    inspectHistory = null,
    sendTransfer = null,
    confirmPayout = null,
    balanceNano = 100n * GRAM_NANO
} = {}) {
    const events = [];
    const sent = { winner: false, owner: false };
    const roomWalletAddress = deriveWalletAddress("seqno-fix-mock-room-wallet");

    const payout = (hash, amountNano, destination) => Object.freeze({
        hash,
        lt: "100",
        utime: 1_700_000_000,
        destination,
        amountNano,
        success: true,
        bounced: false
    });

    const defaultInspectHistory = async ({ winnerAmountNano, ownerAmountNano }) => ({
        reused: false,
        laterCount: 0,
        winnerPayout: sent.winner
            ? payout("mock-winner-hash", winnerAmountNano, WINNER_WALLET)
            : null,
        ownerPayout: sent.owner
            ? payout("mock-owner-hash", ownerAmountNano, OWNER_WALLET)
            : null,
        winnerPayoutCount: sent.winner ? 1 : 0,
        ownerPayoutCount: sent.owner ? 1 : 0
    });

    const defaultConfirmPayout = async (args) => {
        const role = args.destination === WINNER_WALLET ? "winner" : "owner";
        events.push(`confirm:${role}`);
        return { ok: true, hash: `confirmed-${role}` };
    };

    const adapter = new RoomWalletSettlementAdapter({
        roomWalletAdapter: {
            getGasReserveNano() {
                return ROOM_WALLET_POLICY.initialRoomReserveNano;
            },
            async estimateOutboundTransferFee({ amountNano }) {
                return {
                    ok: true,
                    feeSource: "estimateExternalMessageFee",
                    amountNano,
                    inFwdFeeNano: 400_000n,
                    storageFeeNano: 100_000n,
                    gasFeeNano: 300_000n,
                    fwdFeeNano: 200_000n,
                    totalNano: STUB_FEE_TOTAL_NANO
                };
            },
            async getBalance() {
                return balanceNano;
            },
            async canFundTransfer({ amountNano }) {
                const gasReserveNano = ROOM_WALLET_POLICY.initialRoomReserveNano;
                const requiredNano = amountNano + gasReserveNano;
                return {
                    ok: balanceNano >= requiredNano,
                    balanceNano,
                    amountNano,
                    gasReserveNano,
                    requiredNano,
                    shortfallNano: balanceNano >= requiredNano
                        ? 0n
                        : requiredNano - balanceNano
                };
            },
            async getWalletAddress() {
                return roomWalletAddress;
            },
            async getTransactions() {
                return [];
            },
            async sendTransfer(input) {
                const role = input.destination === WINNER_WALLET ? "winner" : "owner";
                events.push(`send:${role}`);
                if (typeof sendTransfer === "function") {
                    return sendTransfer(input, { events, sent });
                }
                if (role === "winner") {
                    sent.winner = true;
                    return { ok: true, code: "SENT", txHash: "mock-winner-hash" };
                }
                sent.owner = true;
                return { ok: true, code: "SENT", txHash: "mock-owner-hash" };
            }
        },
        inspectHistory: inspectHistory ?? defaultInspectHistory,
        confirmPayout: confirmPayout ?? defaultConfirmPayout
    });

    return { adapter, events, sent };
}

test("settlement sequence: winner is confirmed before the owner payout is submitted", async () => {
    const { adapter, events } = createMockSettlementHarness();

    const result = await adapter.settleContract(productionSettlementRequest());

    assert.equal(result.ok, true);
    assert.equal(result.code, "SETTLEMENT_BROADCAST");
    assert.equal(result.winnerConfirmed, true);
    assert.equal(result.ownerConfirmed, true);
    assert.deepEqual(events, ["send:winner", "confirm:winner", "send:owner", "confirm:owner"]);
});

test("winner payout not confirmed on-chain: retryable state, owner payout is never attempted", async () => {
    const { adapter, events } = createMockSettlementHarness({
        confirmPayout: async () => ({ ok: false, code: "PAYOUT_NOT_CONFIRMED" })
    });

    const result = await adapter.settleContract(productionSettlementRequest());

    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.equal(result.partial, true);
    assert.equal(result.code, ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.WINNER_PAYOUT_UNCONFIRMED);
    // The owner transfer was NOT broadcast: settlement never proceeds past an
    // unconfirmed winner payout.
    assert.deepEqual(events, ["send:winner"]);
});

test("owner payout not confirmed on-chain: retryable partial state after owner broadcast", async () => {
    const { adapter, events } = createMockSettlementHarness({
        confirmPayout: async (args) => (
            args.destination === WINNER_WALLET
                ? { ok: true, hash: "confirmed-winner" }
                : { ok: false, code: "PAYOUT_NOT_CONFIRMED" }
        )
    });

    const result = await adapter.settleContract(productionSettlementRequest());

    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.equal(result.partial, true);
    assert.equal(result.code, ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.OWNER_PAYOUT_UNCONFIRMED);
    assert.deepEqual(events, ["send:winner", "send:owner"]);
});

test("owner payout failure after a confirmed winner keeps the partial retryable state", async () => {
    const { adapter, events } = createMockSettlementHarness({
        sendTransfer: (input) => (
            input.destination === WINNER_WALLET
                ? { ok: true, code: "SENT", txHash: "mock-winner-hash" }
                : { ok: false }
        )
    });

    const result = await adapter.settleContract(productionSettlementRequest());

    assert.equal(result.ok, false);
    assert.equal(result.partial, true);
    assert.equal(result.retryable, true);
    assert.equal(
        result.code,
        ROOM_WALLET_SETTLEMENT_RETRYABLE_CODES.OWNER_PAYOUT_FAILED_AFTER_WINNER
    );
    assert.deepEqual(events, ["send:winner", "confirm:winner", "send:owner"]);
});

test("winner already on chain: only the owner payout is sent and only the owner payout is confirmed", async () => {
    let inspectCalls = 0;
    const { adapter, events } = createMockSettlementHarness({
        inspectHistory: async ({ winnerAmountNano, ownerAmountNano }) => {
            inspectCalls += 1;
            const winnerPayout = Object.freeze({
                hash: "winner-existing",
                lt: "100",
                utime: 1_700_000_000,
                destination: WINNER_WALLET,
                amountNano: winnerAmountNano,
                success: true,
                bounced: false
            });
            if (inspectCalls === 1) {
                return {
                    reused: false,
                    laterCount: 0,
                    winnerPayout,
                    ownerPayout: null,
                    winnerPayoutCount: 1,
                    ownerPayoutCount: 0
                };
            }
            return {
                reused: false,
                laterCount: 1,
                winnerPayout,
                ownerPayout: Object.freeze({
                    hash: "owner-new",
                    lt: "101",
                    utime: 1_700_000_100,
                    destination: OWNER_WALLET,
                    amountNano: ownerAmountNano,
                    success: true,
                    bounced: false
                }),
                winnerPayoutCount: 1,
                ownerPayoutCount: 1
            };
        }
    });

    const result = await adapter.settleContract(productionSettlementRequest());

    assert.equal(result.ok, true);
    assert.equal(result.code, "SETTLEMENT_BROADCAST");
    assert.equal(result.winnerConfirmed, true);
    assert.equal(result.ownerConfirmed, true);
    assert.equal(result.winner?.txHash, "winner-existing");
    assert.equal(result.owner?.txHash, "owner-new");
    // The confirmed winner payout was neither resent nor re-confirmed.
    assert.deepEqual(events, ["send:owner", "confirm:owner"]);
});

test("duplicate owner payout evidence after recovery fails closed", async () => {
    let inspectCalls = 0;
    const { adapter } = createMockSettlementHarness({
        inspectHistory: async ({ winnerAmountNano, ownerAmountNano }) => {
            inspectCalls += 1;
            const winnerPayout = Object.freeze({
                hash: "winner-existing",
                lt: "100",
                utime: 1_700_000_000,
                destination: WINNER_WALLET,
                amountNano: winnerAmountNano,
                success: true,
                bounced: false
            });
            const ownerPayout = Object.freeze({
                hash: "owner-existing",
                lt: "101",
                utime: 1_700_000_050,
                destination: OWNER_WALLET,
                amountNano: ownerAmountNano,
                success: true,
                bounced: false
            });
            if (inspectCalls === 1) {
                return {
                    reused: false,
                    laterCount: 1,
                    winnerPayout,
                    ownerPayout: null,
                    winnerPayoutCount: 1,
                    ownerPayoutCount: 0
                };
            }
            return {
                reused: false,
                laterCount: 2,
                winnerPayout,
                ownerPayout,
                winnerPayoutCount: 1,
                ownerPayoutCount: 2
            };
        }
    });

    const result = await adapter.settleContract(productionSettlementRequest());

    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.code, "DUPLICATE_PAYOUT");
    assert.equal(result.ownerPayoutCount, 2);
});

test("adapter boundaries validate the injected confirmation primitives", () => {
    assert.throws(
        () => new RoomWalletSettlementAdapter({
            roomWalletAdapter: {
                async sendTransfer() {},
                async getBalance() {}
            },
            confirmPayout: null
        }),
        /confirmPayout must be a function/
    );

    assert.throws(
        () => new RoomWalletAdapter({
            tonService: {},
            walletResolver: async () => {},
            seqnoConfirmTimeoutMs: 0
        }),
        /seqnoConfirmTimeoutMs/
    );

    assert.throws(
        () => new RoomWalletAdapter({
            tonService: {},
            walletResolver: async () => {},
            seqnoConfirmPollMs: -1
        }),
        /seqnoConfirmPollMs/
    );
});
