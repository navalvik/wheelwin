import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RoomPayoutCalculator } from "../../payment/ledger/RoomPayoutCalculator.js";
import { TestnetWinnerPayoutCoordinator } from "../../payment/runtime/TestnetWinnerPayoutCoordinator.js";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { MainnetFinancialLedger } from "../payment/MainnetFinancialLedger.js";
import { MainnetPayoutLifecycle } from "../payment/MainnetPayoutLifecycle.js";
import { MainnetPaymentRuntime } from "../payment/MainnetPaymentRuntime.js";
import { MainnetWinnerPayoutCoordinator } from "../payment/MainnetWinnerPayoutCoordinator.js";
import { MainnetWalletPoolRegistry } from "../wallet/MainnetWalletPoolRegistry.js";

const ROOM = "winner-payout-parity-room";
const GAME = "winner-payout-parity-game";
const PLAYERS = ["Olga", "Lena", "Bob"];
const TESTNET_WALLETS = ["a", "b", "c"].map(value => `0:${value.repeat(64)}`);
const TESTNET_ROOM_WALLET = `0:${"e".repeat(64)}`;
const TESTNET_OWNER = `0:${"d".repeat(64)}`;
const MAINNET_WALLETS = ["1", "2", "3"].map(value => `0:${value.repeat(64)}`);
const MAINNET_OWNER = `0:${"4".repeat(64)}`;
const MAINNET_PAYER_AMOUNTS = [1_000_000_001, 1_000_000_002, 1_000_000_004];
const NOW = 1_800_000_000_000;

function testnetHarness({ settledCount = 3, principalDelta = 0, winnerId = "Lena",
    winnerWallet = TESTNET_WALLETS[1], dataDir = null } = {}) {
    const intents = PLAYERS.map((playerId, index) => ({
        roomId: ROOM, playerId, amountAtomic: MAINNET_PAYER_AMOUNTS[index],
        asset: "TON", network: "testnet", state: index < settledCount ? "SETTLED" : "PENDING",
        transactionId: index < settledCount ? `tn-in-${index + 1}` : null,
        expectedSender: TESTNET_WALLETS[index]
    }));
    const principal = intents.slice(0, settledCount).reduce((sum, item) => sum + item.amountAtomic, 0);
    const plans = new Map();
    const paymentRuntime = {
        networkDataDir: dataDir,
        paymentService: { listPaymentIntentsForRoom: () => intents },
        ledger: {
            getConfirmedPrincipalAtomic: () => principal + principalDelta,
            planPayout(args) {
                if (plans.has(args.payoutId)) return { replay: true, plan: plans.get(args.payoutId) };
                const plan = RoomPayoutCalculator.computePlan({
                    ...args, principalAtomic: principal, asset: "TON", network: "testnet",
                    networkFees: { winner: { feeAtomic: 0 }, owner: { feeAtomic: 0 } }, nowMs: NOW
                }).toJSON();
                plans.set(args.payoutId, plan);
                return { replay: false, plan };
            }
        },
        walletPool: { getReservationForRoom: () => ({ reservedByRoomId: ROOM,
            roomNumber: 7, walletId: "tn-room-wallet", address: TESTNET_ROOM_WALLET }) },
        refundStore: { list: () => [] },
        outcomeStore: { claim() {}, get: () => null, list: () => [] }
    };
    const coordinator = new TestnetWinnerPayoutCoordinator({ paymentRuntime,
        roomManager: { getRoom: () => ({ players: PLAYERS }) },
        playerManager: { getIdentity: playerId => ({ wallet: playerId === "Lena"
            ? winnerWallet : TESTNET_WALLETS[PLAYERS.indexOf(playerId)] }) },
        contextResolver: { resolveRoomByGameId: () => ROOM },
        winnerEngine: { getResult: () => ({ winnerPlayerId: winnerId }) },
        ownerWalletProvider: () => TESTNET_OWNER
    });
    return { coordinator, paymentRuntime, plans };
}

function mainnetHarness(t, { settledCount = 3, winnerId = "Lena",
    winnerWallet = MAINNET_WALLETS[1], receiptAmountDelta = 0, roomNumber = 2 } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-winner-plan-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const catalog = JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
        walletId: `mn-wallet-${index + 1}`, roomNumber: index + 1,
        address: `0:${String(index + 101).padStart(64, "0")}`, network: "mainnet"
    })));
    const config = loadMainnetRuntimeConfig({ TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "synthetic-offline-key",
        MAINNET_ROOM_WALLET_DATA_DIR: dataDir,
        MAINNET_ROOM_WALLETS_JSON: catalog });
    const paymentRuntime = new MainnetPaymentRuntime({ config, nowProvider: () => NOW });
    const walletPool = new MainnetWalletPoolRegistry({ config });
    walletPool.initialize({ snapshotDir: join(dataDir, "wallet-registry") });
    const reserved = roomNumber === 1
        ? { ...config.walletCatalog[0], reservedByRoomId: ROOM, reservedAt: NOW }
        : walletPool.reserve({ roomId: ROOM, network: "mainnet",
            walletId: `mn-wallet-${roomNumber}`, now: NOW }).wallet;
    walletPool.persistSnapshot(join(dataDir, "wallet-registry"));
    const payments = PLAYERS.map((playerId, index) => ({ playerId,
        paymentReference: `mn-pay-${index + 1}`,
        expectedSender: MAINNET_WALLETS[index],
        amountAtomic: String(MAINNET_PAYER_AMOUNTS[index]) }));
    paymentRuntime.incomingLedger.createRoomPaymentIntents({ roomId: ROOM,
        wallet: { ...reserved, network: "mainnet", globalId: -239 },
        players: payments, createdAt: NOW - 10_000, expiresAt: NOW + 60_000 });
    for (let index = 0; index < settledCount; index += 1) {
        const intent = paymentRuntime.incomingLedger.listRoomIntents(ROOM)[index];
        const transactionId = `mn-in-${index + 1}`;
        const receiptAmount = String(BigInt(intent.amountAtomic) + BigInt(receiptAmountDelta));
        const observation = { network: "mainnet", globalId: -239, roomId: ROOM, transactionId,
            payloadFingerprint: String(index + 1).repeat(64), sourceAddress: intent.expectedSender,
            destinationAddress: reserved.address, amountAtomic: receiptAmount, asset: "TON",
            transactionTime: NOW, observedAt: NOW + 1 };
        const receipt = { network: "mainnet", globalId: -239, roomId: ROOM, transactionId,
            paymentReference: intent.paymentReference, playerId: intent.playerId,
            status: "CONFIRMED", reason: null, amountAtomic: receiptAmount,
            sourceAddress: intent.expectedSender, destinationAddress: reserved.address,
            transactionTime: NOW, asset: "TON", updatedAt: NOW + 1 };
        paymentRuntime.incomingLedger.recordTransfer({ observation, receipt,
            settleReference: intent.paymentReference });
    }
    const observations = [];
    const outgoingObserver = {
        async findOutgoingTransfer() { observations.push("find"); },
        async verifyIndexedRecipientCredit() { observations.push("verify"); }
    };
    const adapter = {
        async sendTransfer() { observations.push("send"); throw new Error("offline test: broadcast forbidden"); },
        async estimateOutboundTransferFee() { observations.push("estimate"); throw new Error("offline test: fee lookup forbidden"); }
    };
    paymentRuntime.payoutLifecycle = new MainnetPayoutLifecycle({
        financialLedger: paymentRuntime.financialLedger, adapter, outgoingObserver,
        independentVerifier: { async verifyTransfer() { observations.push("independent"); } },
        nowProvider: () => NOW
    });
    const coordinatorWalletPool = roomNumber === 1
        ? { network: "mainnet", getReservationForRoom: roomId => roomId === ROOM ? reserved : null }
        : walletPool;
    const coordinator = new MainnetWinnerPayoutCoordinator({ paymentRuntime, walletPool: coordinatorWalletPool,
        roomManager: { getRoom: () => ({ players: PLAYERS }) },
        playerManager: { getIdentity: playerId => ({ wallet: playerId === "Lena"
            ? winnerWallet : MAINNET_WALLETS[PLAYERS.indexOf(playerId)] }) },
        contextResolver: { resolveRoomByGameId: () => ROOM },
        winnerEngine: { getResult: () => ({ winnerPlayerId: winnerId }) },
        ownerWalletProvider: () => MAINNET_OWNER });
    return { config, paymentRuntime, walletPool, coordinator, observations, reserved };
}

function payoutPlanFromTestnet(harness) {
    return harness.plans.values().next().value;
}

test("Mainnet winner coordinator accepts either live-operation state but still validates its runtime", t => {
    const disabled = mainnetHarness(t);
    assert.equal(disabled.paymentRuntime.liveOperationsEnabled, false);
    assert.ok(disabled.coordinator instanceof MainnetWinnerPayoutCoordinator);

    disabled.paymentRuntime.liveOperationsEnabled = true;
    const enabled = new MainnetWinnerPayoutCoordinator({
        paymentRuntime: disabled.paymentRuntime,
        walletPool: disabled.walletPool,
        roomManager: { getRoom: () => ({ players: PLAYERS }) },
        playerManager: { getIdentity: playerId => ({ wallet: MAINNET_WALLETS[PLAYERS.indexOf(playerId)] }) },
        contextResolver: { resolveRoomByGameId: () => ROOM },
        winnerEngine: { getResult: () => ({ winnerPlayerId: "Lena" }) },
        ownerWalletProvider: () => MAINNET_OWNER
    });
    assert.ok(enabled instanceof MainnetWinnerPayoutCoordinator);

    assert.throws(() => new MainnetWinnerPayoutCoordinator({
        paymentRuntime: { ...disabled.paymentRuntime, liveOperationsEnabled: "true" },
        walletPool: disabled.walletPool,
        roomManager: { getRoom: () => ({ players: PLAYERS }) },
        playerManager: { getIdentity: () => ({ wallet: MAINNET_WALLETS[0] }) },
        contextResolver: { resolveRoomByGameId: () => ROOM },
        winnerEngine: { getResult: () => ({ winnerPlayerId: "Lena" }) },
        ownerWalletProvider: () => MAINNET_OWNER
    }), /MAINNET_WINNER_PAYOUT_COORDINATOR_CONFIG_INVALID/);
    assert.throws(() => new MainnetWinnerPayoutCoordinator({
        paymentRuntime: { ...disabled.paymentRuntime, globalId: -3 },
        walletPool: disabled.walletPool,
        roomManager: { getRoom: () => ({ players: PLAYERS }) },
        playerManager: { getIdentity: () => ({ wallet: MAINNET_WALLETS[0] }) },
        contextResolver: { resolveRoomByGameId: () => ROOM },
        winnerEngine: { getResult: () => ({ winnerPlayerId: "Lena" }) },
        ownerWalletProvider: () => MAINNET_OWNER
    }), /MAINNET_WINNER_PAYOUT_COORDINATOR_CONFIG_INVALID/,
    "Mainnet identity validation remains enforced when live operations are enabled");
});

test("paired Testnet/Mainnet 3/3 result creates one matching durable payout plan", async t => {
    const tn = testnetHarness();
    const mn = mainnetHarness(t);
    const tnResult = await tn.coordinator.onGameResult({ gameId: GAME });
    const mnResult = mn.coordinator.onGameResult({ gameId: GAME });
    const tnPlan = payoutPlanFromTestnet(tn);
    const mnPlan = mn.paymentRuntime.financialLedger.getPayout(mnResult.payoutId);

    assert.equal(tnResult.status, "PAYOUT_PLANNED_EXECUTOR_UNAVAILABLE");
    assert.equal(mnResult.status, "PAYOUT_PLANNED_EXECUTOR_UNAVAILABLE");
    assert.ok(mnPlan);
    assert.equal(mnPlan.principalAtomic, tnPlan.principalAtomic);
    assert.equal(mnPlan.allocation.winnerAtomic,
        tnPlan.transfers.find(item => item.recipientRole === "WINNER").grossAtomic);
    assert.equal(mnPlan.allocation.ownerAtomic,
        tnPlan.transfers.find(item => item.recipientRole === "OWNER").grossAtomic);
    assert.equal(mnPlan.allocation.reserveAtomic, tnPlan.gasReserveAtomic);
    assert.equal(mnPlan.winner.state, "PENDING");
    assert.equal(mnPlan.owner.state, "PENDING");
    assert.deepEqual(mn.observations, [], "planning never estimates, signs, sends, or confirms transfers");
});

test("Mainnet accepts an existing wallet #1 reservation for payout while the pool quarantines it from new rooms", async t => {
    const mn = mainnetHarness(t, { roomNumber: 1 });
    const result = await mn.coordinator.onGameResult({ gameId: GAME });
    const payout = mn.paymentRuntime.financialLedger.getPayout(result.payoutId);
    assert.equal(payout.roomNumber, 1);
    assert.equal(payout.sourceWalletAddress, mn.reserved.address);
    assert.equal(payout.principalAtomic, 3_000_000_007);

    assert.equal(mn.walletPool.isQuarantined(1), true);
    assert.equal(mn.walletPool.listAvailableWallets().some(wallet => wallet.roomNumber === 1), false);
    assert.equal(mn.walletPool.listAvailableWallets().some(wallet => wallet.roomNumber === 2), true);
    assert.throws(() => mn.walletPool.reserve({ roomId: "another-room", network: "mainnet",
        walletId: "mn-wallet-1", now: NOW + 1 }), /wallet quarantined/);
});

test("paired incomplete 2/3 payments reject the result without a payout plan", async t => {
    const tn = testnetHarness({ settledCount: 2 });
    const mn = mainnetHarness(t, { settledCount: 2 });
    await assert.rejects(() => tn.coordinator.onGameResult({ gameId: GAME }),
        /PAYOUT_THREE_SETTLED_PAYMENTS_REQUIRED/);
    assert.throws(() => mn.coordinator.onGameResult({ gameId: GAME }),
        /PAYOUT_THREE_SETTLED_PAYMENTS_REQUIRED/);
    assert.equal(tn.plans.size, 0);
    assert.equal(mn.paymentRuntime.financialLedger.listPayouts().length, 0);
});

test("winner, receipt total, and winner wallet mismatches fail closed", async t => {
    const tnWinner = testnetHarness({ winnerId: "not-seated" });
    const mnWinner = mainnetHarness(t, { winnerId: "not-seated" });
    await assert.rejects(() => tnWinner.coordinator.onGameResult({ gameId: GAME }), /PAYOUT_WINNER_UNVERIFIED/);
    assert.throws(() => mnWinner.coordinator.onGameResult({ gameId: GAME }), /PAYOUT_WINNER_UNVERIFIED/);

    const tnTotal = testnetHarness({ principalDelta: 1 });
    const mnTotal = mainnetHarness(t, { receiptAmountDelta: 1 });
    await assert.rejects(() => tnTotal.coordinator.onGameResult({ gameId: GAME }), /PAYOUT_LEDGER_PRINCIPAL_MISMATCH/);
    assert.throws(() => mnTotal.coordinator.onGameResult({ gameId: GAME }), /PAYOUT_LEDGER_PRINCIPAL_MISMATCH/);

    const tnWallet = testnetHarness({ winnerWallet: `0:${"9".repeat(64)}` });
    const mnWallet = mainnetHarness(t, { winnerWallet: `0:${"9".repeat(64)}` });
    await assert.rejects(() => tnWallet.coordinator.onGameResult({ gameId: GAME }), /PAYOUT_WINNER_WALLET_MISMATCH/);
    assert.throws(() => mnWallet.coordinator.onGameResult({ gameId: GAME }), /PAYOUT_WINNER_WALLET_MISMATCH/);
});

test("duplicate result and coordinator restart reuse one persisted pending plan", t => {
    const mn = mainnetHarness(t);
    const first = mn.coordinator.onGameResult({ gameId: GAME });
    const repeated = mn.coordinator.onGameResult({ gameId: GAME });
    assert.equal(first.status, "PAYOUT_PLANNED_EXECUTOR_UNAVAILABLE");
    assert.equal(repeated.status, "ALREADY_PLANNED_NEEDS_RECONCILIATION");
    assert.equal(mn.paymentRuntime.financialLedger.listPayouts().length, 1);

    const restoredFinancial = new MainnetFinancialLedger({ config: mn.config }).initialize();
    const restoredRuntime = { ...mn.paymentRuntime, financialLedger: restoredFinancial,
        payoutLifecycle: new MainnetPayoutLifecycle({ financialLedger: restoredFinancial,
            adapter: { async sendTransfer() { throw new Error("broadcast forbidden"); },
                async estimateOutboundTransferFee() { throw new Error("fee lookup forbidden"); } },
            outgoingObserver: { async findOutgoingTransfer() {}, async verifyIndexedRecipientCredit() {} },
            independentVerifier: { async verifyTransfer() {} }, nowProvider: () => NOW }) };
    const restarted = new MainnetWinnerPayoutCoordinator({ paymentRuntime: restoredRuntime,
        walletPool: mn.walletPool, roomManager: { getRoom: () => ({ players: PLAYERS }) },
        playerManager: { getIdentity: playerId => ({ wallet: MAINNET_WALLETS[PLAYERS.indexOf(playerId)] }) },
        contextResolver: { resolveRoomByGameId: () => ROOM },
        winnerEngine: { getResult: () => ({ winnerPlayerId: "Lena" }) },
        ownerWalletProvider: () => MAINNET_OWNER });
    const replay = restarted.onGameResult({ gameId: GAME });
    assert.equal(replay.status, "ALREADY_PLANNED_NEEDS_RECONCILIATION");
    assert.equal(restoredFinancial.listPayouts().length, 1);
    assert.equal(restoredFinancial.listPayouts()[0].winner.state, "PENDING");
    assert.deepEqual(mn.observations, []);
});

test("paired Testnet/Mainnet restart recovery reads the original pending plan without sending", async t => {
    const testnetDir = mkdtempSync(join(tmpdir(), "wheelwin-testnet-winner-recovery-"));
    t.after(() => rmSync(testnetDir, { recursive: true, force: true }));
    const tn = testnetHarness({ dataDir: testnetDir });
    const mn = mainnetHarness(t);
    await tn.coordinator.onGameResult({ gameId: GAME });
    const mainnetCreated = mn.coordinator.onGameResult({ gameId: GAME });
    const mainnetPayoutPath = join(mn.config.dataDir, "financial-lifecycle", "state.json");
    const beforeRecovery = readFileSync(mainnetPayoutPath, "utf8");

    const restartedTestnetCoordinator = new TestnetWinnerPayoutCoordinator({
        paymentRuntime: tn.paymentRuntime
    });
    const testnetRecovery = await restartedTestnetCoordinator.recoverPendingResults();
    const restartedFinancial = new MainnetFinancialLedger({ config: mn.config }).initialize();
    const restartedRuntime = { ...mn.paymentRuntime, financialLedger: restartedFinancial,
        payoutLifecycle: new MainnetPayoutLifecycle({ financialLedger: restartedFinancial,
            adapter: { async sendTransfer() { throw new Error("broadcast forbidden"); },
                async estimateOutboundTransferFee() { throw new Error("fee lookup forbidden"); } },
            outgoingObserver: { async findOutgoingTransfer() {}, async verifyIndexedRecipientCredit() {} },
            independentVerifier: { async verifyTransfer() {} }, nowProvider: () => NOW }) };
    const restartedMainnetCoordinator = new MainnetWinnerPayoutCoordinator({
        paymentRuntime: restartedRuntime, walletPool: mn.walletPool,
        roomManager: { getRoom: () => ({ players: PLAYERS }) },
        playerManager: { getIdentity: playerId => ({ wallet: MAINNET_WALLETS[PLAYERS.indexOf(playerId)] }) },
        contextResolver: { resolveRoomByGameId: () => ROOM },
        winnerEngine: { getResult: () => ({ winnerPlayerId: "Lena" }) },
        ownerWalletProvider: () => MAINNET_OWNER
    });
    const mainnetRecovery = restartedMainnetCoordinator.recoverPendingResults();
    const repeatedRecovery = restartedMainnetCoordinator.recoverPendingResults();

    assert.equal(testnetRecovery.length, 1);
    assert.equal(testnetRecovery[0].status, "ALREADY_PLANNED_NEEDS_RECONCILIATION");
    assert.equal(mainnetCreated.payoutId, mainnetRecovery[0].payoutId);
    assert.equal(mainnetRecovery.length, 1);
    assert.equal(repeatedRecovery.length, 1);
    assert.equal(mainnetRecovery[0].principalAtomic, payoutPlanFromTestnet(tn).principalAtomic);
    assert.equal(mainnetRecovery[0].winner.address, MAINNET_WALLETS[1]);
    assert.equal(mainnetRecovery[0].owner.address, MAINNET_OWNER);
    assert.equal(mainnetRecovery[0].winner.state, "PENDING");
    assert.equal(mainnetRecovery[0].owner.state, "PENDING");
    assert.equal(restartedFinancial.listPayouts().length, 1);
    assert.equal(readFileSync(mainnetPayoutPath, "utf8"), beforeRecovery,
        "Mainnet recovery reads the persisted plan without changing the financial ledger");
    assert.deepEqual(mn.observations, [], "recovery performs no RPC, signature, or broadcast calls");
});

test("a persisted refund outcome prevents a competing payout plan", t => {
    const mn = mainnetHarness(t);
    mn.paymentRuntime.financialLedger.recordClosedRoom({ roomId: ROOM,
        roomNumber: mn.walletPool.getReservationForRoom(ROOM).roomNumber,
        closureReason: "pre_page5_destroyed" });
    assert.throws(() => mn.coordinator.onGameResult({ gameId: GAME }),
        /PAYOUT_REFUND_CONFLICT|MAINNET_ROOM_ALREADY_HAS_REFUND_OUTCOME/);
    assert.equal(mn.paymentRuntime.financialLedger.listPayouts().length, 0);
});
