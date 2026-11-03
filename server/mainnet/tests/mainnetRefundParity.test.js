import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RefundLifecycleCoordinator } from "../../payment/refund/RefundLifecycleCoordinator.js";
import { TestnetPendingRefundReconciler } from "../../payment/runtime/TestnetPendingRefundReconciler.js";
import { IncomingReceiptAccounting } from "../../payment/incoming/IncomingReceiptAccounting.js";
import { LEDGER_ENTRY_KIND } from "../../payment/ledger/LedgerConstants.js";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { MainnetFinancialLedger } from "../payment/MainnetFinancialLedger.js";
import { MainnetIncomingPaymentLedger } from "../payment/MainnetIncomingPaymentLedger.js";
import { MainnetRefundLifecycle } from "../payment/MainnetRefundLifecycle.js";

const NOW = 1_800_000_000_000;
const ROOM = "refund-parity-room";
const TESTNET_PAYER = i => `0:${String(i + 1).padStart(64, "0")}`;
const MAINNET_PAYER = i => `0:${String(i + 101).padStart(64, "0")}`;
const TESTNET_WALLET = `0:${"a".repeat(64)}`;
const MAINNET_WALLET = `0:${"b".repeat(64)}`;
const independentVerifier = { async verifyTransfer() { return null; } };

function mainnetSetup(t, settledCount) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-refund-parity-mainnet-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const catalog = JSON.stringify(Array.from({ length: 64 }, (_, index) => ({
        walletId: `mn-wallet-${index + 1}`, roomNumber: index + 1,
        address: `0:${String(index + 200).padStart(64, "0")}`, network: "mainnet"
    })));
    const config = loadMainnetRuntimeConfig({ TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-key", MAINNET_ROOM_WALLET_DATA_DIR: dataDir,
        MAINNET_ROOM_WALLETS_JSON: catalog });
    const financial = new MainnetFinancialLedger({ config, nowProvider: () => NOW }).initialize();
    const incoming = new MainnetIncomingPaymentLedger({ config, nowProvider: () => NOW }).initialize();
    const players = Array.from({ length: 3 }, (_, index) => ({
        playerId: `player-${index + 1}`, paymentReference: `mn-ref-${index + 1}`,
        expectedSender: MAINNET_PAYER(index), amountAtomic: "1000000000"
    }));
    incoming.createRoomPaymentIntents({ roomId: ROOM,
        wallet: { walletId: "mn-wallet-44", address: MAINNET_WALLET, network: "mainnet", globalId: -239 },
        players, createdAt: NOW - 1000, expiresAt: NOW + 10_000 });
    for (let index = 0; index < settledCount; index += 1) {
        const intent = incoming.listRoomIntents(ROOM)[index];
        const transactionId = `mainnet-in-${index + 1}`;
        const observation = { network: "mainnet", globalId: -239, roomId: ROOM, transactionId,
            payloadFingerprint: String(index + 1).repeat(64), sourceAddress: intent.expectedSender,
            destinationAddress: MAINNET_WALLET, amountAtomic: intent.amountAtomic, asset: "TON",
            transactionTime: NOW, observedAt: NOW + 1 };
        const receipt = { network: "mainnet", globalId: -239, status: "CONFIRMED", reason: null,
            roomId: ROOM, transactionId, paymentReference: intent.paymentReference,
            playerId: intent.playerId, amountAtomic: intent.amountAtomic,
            sourceAddress: intent.expectedSender, destinationAddress: MAINNET_WALLET,
            asset: "TON", transactionTime: NOW, updatedAt: NOW + 1 };
        incoming.recordTransfer({ observation, receipt, settleReference: intent.paymentReference });
    }
    const lifecycle = new MainnetRefundLifecycle({ financialLedger: financial, incomingLedger: incoming,
        adapter: { async sendTransfer() { throw new Error("offline test: no transfer"); },
            async estimateOutboundTransferFee() { throw new Error("offline test: no fee quote"); } },
        outgoingObserver: { async findOutgoingTransfer() {}, async verifyIndexedRecipientCredit() {} },
        independentVerifier,
        nowProvider: () => NOW });
    lifecycle.configureReservedWalletRoomNumberResolver(() => 44);
    return { config, financial, incoming, lifecycle };
}

function testnetSetup(settledCount) {
    const intents = Array.from({ length: 3 }, (_, index) => ({
        paymentReference: `tn-ref-${index + 1}`, roomId: ROOM, playerId: `player-${index + 1}`,
        network: "testnet", expectedSender: TESTNET_PAYER(index), amountAtomic: 1_000_000_000,
        destinationWalletAddress: TESTNET_WALLET,
        asset: "TON", state: index < settledCount ? "SETTLED" : "PENDING",
        transactionId: index < settledCount ? `testnet-in-${index + 1}` : null
    }));
    const principal = intents.slice(0, settledCount).map((intent, index) => ({
        entryId: `principal-${index + 1}`, roomId: ROOM, kind: LEDGER_ENTRY_KIND.INCOMING_PRINCIPAL,
        playerId: intent.playerId, amountAtomic: intent.amountAtomic, asset: "TON", network: "testnet",
        metadata: { paymentReference: intent.paymentReference, transactionId: intent.transactionId,
            intentState: "SETTLED", source: "SETTLED_PAYMENT_INTENT" }
    }));
    const closedRooms = new Map();
    const obligations = new Map();
    const refundStore = {
        initialize() {},
        recordClosedRoom(context) {
            const existing = closedRooms.get(context.roomId);
            if (existing && (existing.roomNumber !== context.roomNumber
                || existing.closureReason !== context.closureReason)) throw new Error("TESTNET_CLOSED_CONTEXT_CONFLICT");
            const stored = existing ?? { ...context, networkName: "TESTNET", globalId: -3 };
            closedRooms.set(context.roomId, stored);
            return { replay: Boolean(existing), context: stored };
        },
        listClosedRooms() { return [...closedRooms.values()]; },
        getClosedRoom(id) { return closedRooms.get(id) ?? null; },
        create(record) {
            const existing = obligations.get(record.idempotencyKey);
            if (existing) return { replay: true, obligation: existing };
            obligations.set(record.idempotencyKey, record);
            return { replay: false, obligation: record };
        },
        listPending() { return [...obligations.values()]; }
    };
    const intentStore = {
        listForRoom(id) { return id === ROOM ? intents : []; },
        findByTransactionId(transactionId) {
            const intent = intents.find(item => item.transactionId === transactionId);
            return intent ? { paymentReference: intent.paymentReference } : null;
        }
    };
    const ledgerStore = { listForRoom: id => id === ROOM ? principal : [] };
    const coordinator = new RefundLifecycleCoordinator({ store: refundStore,
        intentStore, ledgerStore, nowProvider: () => NOW });
    return { coordinator, refundStore, obligations, intents, principal };
}

function closeMainnet(h, closureReason = "pre_page5_destroyed") {
    return h.lifecycle.prepareClosedRoom({ roomId: ROOM, roomNumber: 44, closureReason,
        status: "DESTROYED", prePage5: true });
}

function closeTestnet(h, closureReason = "pre_page5_destroyed") {
    return h.coordinator.prepareClosedRoom({ roomId: ROOM, roomNumber: 7,
        closureReason, status: "DESTROYED" });
}

function recordAdditionalReceipt(h, overrides = {}) {
    const intent = h.incoming.listRoomIntents(ROOM)[0];
    const transactionId = overrides.transactionId ?? "mainnet-extra-unsettled-1";
    const roomId = overrides.roomId ?? ROOM;
    const receipt = {
        network: "mainnet", globalId: -239, status: "EXTRA_PAYMENT",
        reason: overrides.reason ?? "UNMATCHED_FINALIZED_RECEIPT", roomId, transactionId,
        paymentReference: intent.paymentReference,
        playerId: overrides.playerId ?? intent.playerId,
        amountAtomic: overrides.amountAtomic ?? "750000000",
        sourceAddress: overrides.sourceAddress ?? intent.expectedSender,
        destinationAddress: overrides.destinationAddress ?? MAINNET_WALLET,
        asset: "TON", transactionTime: NOW, updatedAt: NOW + 2
    };
    const observation = {
        network: "mainnet", globalId: -239, roomId, transactionId,
        payloadFingerprint: "f".repeat(64), sourceAddress: receipt.sourceAddress,
        destinationAddress: receipt.destinationAddress, amountAtomic: receipt.amountAtomic,
        asset: "TON", transactionTime: NOW, observedAt: NOW + 2
    };
    h.incoming.recordTransfer({ observation, receipt });
    return receipt;
}

test("paired Testnet/Mainnet closures make the same 0/3 through 3/3 refund decisions", t => {
    for (const settledCount of [0, 1, 2, 3]) {
        const tn = testnetSetup(settledCount);
        const mn = mainnetSetup(t, settledCount);
        const tnFirst = closeTestnet(tn);
        const mnFirst = closeMainnet(mn);
        assert.equal(tnFirst.length, settledCount, `Testnet ${settledCount}/3`);
        assert.equal(mnFirst.length, settledCount, `Mainnet ${settledCount}/3`);
        assert.equal(tn.obligations.size, mn.financial.listRefunds(ROOM).length);

        const tnReplay = closeTestnet(tn);
        const mnReplay = closeMainnet(mn);
        assert.equal(tnReplay.length, settledCount);
        assert.equal(mnReplay.length, settledCount);
        assert.equal(tn.obligations.size, mn.financial.listRefunds(ROOM).length,
            "repeated close does not duplicate either network's obligations");

        const tnRestart = testnetSetup(settledCount);
        // Retain the original close context and simulate a crash after context
        // persistence but before obligation creation.
        tnRestart.refundStore.recordClosedRoom({ roomId: ROOM, roomNumber: 7,
            closureReason: "pre_page5_destroyed", closedAtMs: NOW,
            networkName: "TESTNET", globalId: -3 });
        tnRestart.coordinator.initialize();
        const mnRestartFinancial = new MainnetFinancialLedger({ config: mn.config }).initialize();
        if (!mnRestartFinancial.getOutcome(ROOM)) {
            mnRestartFinancial.recordClosedRoom({ roomId: ROOM, roomNumber: 44,
                closureReason: "pre_page5_destroyed" });
        }
        const mnRestartIncoming = new MainnetIncomingPaymentLedger({ config: mn.config }).initialize();
        const mnRestart = new MainnetRefundLifecycle({ financialLedger: mnRestartFinancial,
            incomingLedger: mnRestartIncoming,
            adapter: { async sendTransfer() {}, async estimateOutboundTransferFee() {} },
            outgoingObserver: { async findOutgoingTransfer() {}, async verifyIndexedRecipientCredit() {} },
            independentVerifier,
            nowProvider: () => NOW });
        mnRestart.configureReservedWalletRoomNumberResolver(() => 44);
        const recovery = mnRestart.recover();
        assert.equal(tnRestart.obligations.size, settledCount, `Testnet recovery ${settledCount}/3`);
        assert.equal(mnRestartFinancial.listRefunds(ROOM).length, settledCount,
            `Mainnet recovery ${settledCount}/3`);
        assert.equal(recovery.length, settledCount);
    }
});

test("paired completed-game closures do not create refunds", t => {
    const tn = testnetSetup(3);
    const mn = mainnetSetup(t, 3);
    mn.financial.recordPage5Started(ROOM);
    assert.equal(closeTestnet(tn, "session_ended").length, 0);
    assert.equal(closeMainnet(mn, "session_ended").length, 0);
    assert.equal(tn.obligations.size, 0);
    assert.equal(mn.financial.listRefunds(ROOM).length, 0);
});

test("paired closed-room accounting refunds an additional finalized payment once", t => {
    const tn = testnetSetup(1);
    const tnReceipts = [];
    const receiptStore = {
        record(entry) {
            if (!tnReceipts.some(item => item.transactionId === entry.transactionId)) tnReceipts.push(entry);
        },
        listForRoom(roomId) { return tnReceipts.filter(item => item.roomId === roomId); }
    };
    const accounting = new IncomingReceiptAccounting({ store: receiptStore,
        intentStore: tn.coordinator._intents, refundStore: tn.coordinator._store,
        nowProvider: () => NOW });
    const tnIntent = tn.intents[0];
    accounting.recordVerifiedTransfer({ transactionId: "testnet-extra-in-1",
        providerTransactionIdentity: { transactionId: "provider-extra-1", accountId: TESTNET_WALLET },
        transactionTime: NOW, amountAtomic: tnIntent.amountAtomic,
        senderAddress: tnIntent.expectedSender, destinationWalletAddress: TESTNET_WALLET,
        paymentReference: tnIntent.paymentReference }, [tnIntent], ROOM);
    closeTestnet(tn);
    accounting.prepareClosedRoom(ROOM);

    const mn = mainnetSetup(t, 1);
    const mnIntent = mn.incoming.listRoomIntents(ROOM)[0];
    const transactionId = "mainnet-extra-in-1";
    const observation = { network: "mainnet", globalId: -239, roomId: ROOM, transactionId,
        payloadFingerprint: "e".repeat(64), sourceAddress: mnIntent.expectedSender,
        destinationAddress: MAINNET_WALLET, amountAtomic: mnIntent.amountAtomic,
        asset: "TON", transactionTime: NOW, observedAt: NOW + 2 };
    const receipt = { network: "mainnet", globalId: -239, status: "EXTRA_PAYMENT",
        reason: "PAYMENT_ALREADY_SETTLED", roomId: ROOM, transactionId,
        paymentReference: mnIntent.paymentReference, playerId: mnIntent.playerId,
        amountAtomic: mnIntent.amountAtomic, sourceAddress: mnIntent.expectedSender,
        destinationAddress: MAINNET_WALLET, asset: "TON", transactionTime: NOW,
        updatedAt: NOW + 2 };
    mn.incoming.recordTransfer({ observation, receipt });
    closeMainnet(mn);

    assert.equal(tnReceipts.length, 1);
    assert.equal(tn.obligations.size, 2, "Testnet prepares principal and separately captured extra receipt");
    assert.equal(mn.financial.listRefunds(ROOM).length, 2,
        "Mainnet prepares equivalent obligations from its settled and extra-payment receipts");
    assert.equal(closeMainnet(mn).length, 2, "Mainnet replay remains idempotent");
});

test("Mainnet refunds an identified additional receipt for a non-settled intent using its received amount", t => {
    const mn = mainnetSetup(t, 0);
    const intent = mn.incoming.listRoomIntents(ROOM)[0];
    assert.equal(intent.state, "PENDING");
    recordAdditionalReceipt(mn);

    const created = closeMainnet(mn);
    assert.equal(created.length, 1);
    assert.equal(created[0].paymentIntentId, intent.paymentReference);
    assert.equal(created[0].playerId, intent.playerId);
    assert.equal(created[0].amountAtomic, 750_000_000);
    assert.equal(created[0].refundDestination, intent.expectedSender);
    assert.equal(created[0].sourceWalletAddress, intent.destinationWalletAddress);

    const replay = closeMainnet(mn);
    assert.equal(replay.length, 1);
    assert.equal(replay[0].replay, true);
    assert.equal(mn.financial.listRefunds(ROOM).length, 1,
        "the same incoming transaction does not create another obligation");
});

test("Mainnet additional-payment refunds reject payer, player, and room-wallet mismatches", t => {
    for (const overrides of [
        { sourceAddress: MAINNET_PAYER(1) },
        { playerId: "another-player" },
        { destinationAddress: TESTNET_WALLET }
    ]) {
        const mn = mainnetSetup(t, 0);
        recordAdditionalReceipt(mn, overrides);
        assert.throws(() => closeMainnet(mn), /MAINNET_REFUND_PAYMENT_EVIDENCE_CONFLICT/);
        assert.equal(mn.financial.listRefunds(ROOM).length, 0);
    }

    const crossRoom = mainnetSetup(t, 0);
    recordAdditionalReceipt(crossRoom, { roomId: "another-room" });
    assert.deepEqual(closeMainnet(crossRoom), []);
    assert.equal(crossRoom.financial.listRefunds(ROOM).length, 0);
});

test("an existing Mainnet payout outcome still prevents additional-payment refunds", t => {
    const mn = mainnetSetup(t, 0);
    mn.financial.createPayout({
        payoutId: "payout_refund_conflict",
        roomId: ROOM,
        roomNumber: 44,
        sourceWalletAddress: MAINNET_WALLET,
        principalAtomic: 1_000_000_000,
        winner: { recipientId: "winner", address: `0:${"c".repeat(64)}` },
        owner: { recipientId: "owner", address: `0:${"d".repeat(64)}` }
    });
    recordAdditionalReceipt(mn);

    assert.deepEqual(closeMainnet(mn), []);
    assert.equal(mn.financial.listRefunds(ROOM).length, 0);
    assert.equal(mn.financial.hasPayoutOutcome(ROOM), true);
});

test("Mainnet rejects receipt, observation, and intent disagreement before obligation creation", t => {
    const corruptions = [
        state => { state.receipts[0].destinationAddress = TESTNET_WALLET; },
        state => { state.observations[0].amountAtomic = "999000000"; },
        state => { state.intents[0].expectedSender = TESTNET_PAYER(0); }
    ];
    for (const corrupt of corruptions) {
        const h = mainnetSetup(t, 1);
        const statePath = join(h.config.dataDir, "incoming-payment-ledger", "state.json");
        const persisted = JSON.parse(readFileSync(statePath, "utf8"));
        corrupt(persisted);
        writeFileSync(statePath, JSON.stringify(persisted));
        const corruptedIncoming = new MainnetIncomingPaymentLedger({ config: h.config }).initialize();
        const financial = new MainnetFinancialLedger({ config: h.config }).initialize();
        const lifecycle = new MainnetRefundLifecycle({ financialLedger: financial,
            incomingLedger: corruptedIncoming,
            adapter: { async sendTransfer() {}, async estimateOutboundTransferFee() {} },
            outgoingObserver: { async findOutgoingTransfer() {}, async verifyIndexedRecipientCredit() {} },
            independentVerifier,
            nowProvider: () => NOW });
        assert.throws(() => lifecycle.prepareClosedRoom({ roomId: ROOM, roomNumber: 44,
            closureReason: "pre_page5_destroyed", status: "DESTROYED" }),
        /MAINNET_REFUND_PAYMENT_EVIDENCE_CONFLICT/);
        assert.equal(financial.listRefunds(ROOM).length, 0);
    }
});

test("Testnet and Mainnet both reject a principal/receipt that conflicts with its settled intent", t => {
    const tn = testnetSetup(1);
    tn.principal[0].amountAtomic += 1;
    assert.throws(() => closeTestnet(tn), /evidence is missing or inconsistent/);

    const mn = mainnetSetup(t, 1);
    const statePath = join(mn.config.dataDir, "incoming-payment-ledger", "state.json");
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    persisted.receipts[0].amountAtomic = "1000000001";
    writeFileSync(statePath, JSON.stringify(persisted));
    const incoming = new MainnetIncomingPaymentLedger({ config: mn.config }).initialize();
    const financial = new MainnetFinancialLedger({ config: mn.config }).initialize();
    const lifecycle = new MainnetRefundLifecycle({ financialLedger: financial, incomingLedger: incoming,
        adapter: { async sendTransfer() {}, async estimateOutboundTransferFee() {} },
        outgoingObserver: { async findOutgoingTransfer() {}, async verifyIndexedRecipientCredit() {} },
        independentVerifier,
        nowProvider: () => NOW });
    assert.throws(() => lifecycle.prepareClosedRoom({ roomId: ROOM, roomNumber: 44,
        closureReason: "pre_page5_destroyed", status: "DESTROYED" }),
    /MAINNET_REFUND_PAYMENT_EVIDENCE_CONFLICT/);
    assert.equal(financial.listRefunds(ROOM).length, 0);
});

test("paired Testnet/Mainnet refund reconciliation completes only on matching dual-source evidence", async t => {
    for (const independentAvailable of [true, false]) {
        const mn = mainnetSetup(t, 1);
        const obligation = closeMainnet(mn)[0];
        mn.financial.updateRefund(obligation.obligationId, { state: "SUBMISSION_UNKNOWN",
            transferAmountAtomic: obligation.amountAtomic - 1_200_000, gasChargeAtomic: 1_200_000 });
        mn.financial.updateRefund(obligation.obligationId, { state: "SUBMITTED", outgoingTransactionId: "out-tx" });
        const mainnetObserver = {
            async findOutgoingTransfer(query) { return { transactionId: "out-tx",
                sourceAddress: MAINNET_WALLET, destinationAddress: MAINNET_PAYER(0),
                amountAtomic: query.amountAtomic }; },
            async verifyIndexedRecipientCredit(query) { return {
                status: "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED", globalId: -239,
                sourceTransactionId: "out-tx", recipientTransactionId: "recipient-tx",
                messageHash: "a".repeat(64), sourceWalletAddress: MAINNET_WALLET,
                destinationAddress: MAINNET_PAYER(0), amountAtomic: query.amountAtomic,
                sourceFinality: "finalized", recipientFinality: "finalized",
                sourceBlockRef: { workchain: 0, shard: "8000000000000000", seqno: 21 },
                recipientBlockRef: { workchain: 0, shard: "8000000000000000", seqno: 22 } }; }
        };
        const mainnetVerifier = { async verifyTransfer(input) {
            if (!independentAvailable) return null;
            return { status: "INDEPENDENT_INDEXED_CREDIT_OBSERVED", ...input,
                provider: "tonapi-mainnet", network: "mainnet", globalId: -239, actualFeeAtomic: 1 };
        } };
        const mainnetLifecycle = new MainnetRefundLifecycle({ financialLedger: mn.financial,
            incomingLedger: mn.incoming,
            adapter: { async sendTransfer() { throw new Error("must stay read-only"); },
                async estimateOutboundTransferFee() { throw new Error("must stay read-only"); } },
            outgoingObserver: mainnetObserver, independentVerifier: mainnetVerifier, nowProvider: () => NOW });
        await mainnetLifecycle.reconcileRefund(obligation.obligationId);

        const testnetIntent = { paymentReference: "tn-refund-intent", transactionId: "tn-in-tx",
            roomId: ROOM, playerId: "player-1", network: "testnet", state: "SETTLED",
            expectedSender: TESTNET_PAYER(0), destinationWalletAddress: TESTNET_WALLET,
            amountAtomic: 1_000_000_000 };
        const testnetReceipt = { transactionId: "tn-in-tx", paymentIntentId: testnetIntent.paymentReference,
            amountAtomic: 1_000_000_000, senderAddress: TESTNET_PAYER(0),
            destinationWalletAddress: TESTNET_WALLET };
        const testnetObligation = { obligationId: "tn-refund", state: "SUBMITTED", networkName: "TESTNET",
            globalId: -3, roomId: ROOM, paymentIntentId: testnetIntent.paymentReference,
            incomingTransactionId: "tn-in-tx", amountAtomic: 1_000_000_000,
            transferAmountAtomic: 998_800_000, refundDestination: TESTNET_PAYER(0),
            sourceWalletAddress: TESTNET_WALLET, createdAtMs: NOW, outgoingTransactionId: "tn-out-tx" };
        const testnetState = { ...testnetObligation };
        const refundStore = { listPending: () => [testnetState],
            completeFromVerifiedHistory(_id, patch) { Object.assign(testnetState, patch, { state: "COMPLETE" }); } };
        const testnetCalls = [];
        const testnetObserver = {
            async findOutgoingTransfer(query) { testnetCalls.push("find"); return { transactionId: "tn-out-tx" }; },
            async verifyIndexedRecipientCredit(query) { testnetCalls.push("indexed"); return {
                status: "MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED", globalId: -3,
                sourceTransactionId: "tn-out-tx", recipientTransactionId: "tn-recipient-tx",
                messageHash: "b".repeat(64), amountAtomic: query.amountAtomic,
                destinationAddress: TESTNET_PAYER(0),
                sourceFinality: "finalized", recipientFinality: "finalized",
                sourceBlockRef: { workchain: 0, shard: "8000000000000000", seqno: 31 } }; }
        };
        const testnetVerifier = { async verifyTransfer(input) {
            testnetCalls.push("independent");
            if (!independentAvailable) return null;
            return { status: "INDEPENDENT_INDEXED_CREDIT_OBSERVED", ...input,
                provider: "tonapi-testnet", amountAtomic: input.amountAtomic,
                sourceWalletAddress: TESTNET_WALLET, destinationAddress: TESTNET_PAYER(0) };
        } };
        const testnet = new TestnetPendingRefundReconciler({
            refundStore, intentStore: { listForRoom: () => [testnetIntent] },
            receiptStore: { listForRoom: () => [testnetReceipt] }, toncenterObserver: testnetObserver,
            independentVerifier: testnetVerifier, nowProvider: () => NOW
        });
        const testnetPass = await testnet.runPass();
        assert.equal(mn.financial.getRefund(obligation.obligationId).state === "COMPLETE",
            testnetState.state === "COMPLETE",
            `same dual-source availability (${independentAvailable}) must make the same decision; ${JSON.stringify(testnetPass)}; calls=${testnetCalls.join(",")}`);
    }
});
