import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMainnetRuntimeConfig } from "../config/MainnetRuntimeConfig.js";
import { MainnetFinancialLedger } from "../payment/MainnetFinancialLedger.js";
import { MainnetIncomingPaymentLedger } from "../payment/MainnetIncomingPaymentLedger.js";
import { MainnetIncomingPaymentService } from "../payment/MainnetIncomingPaymentService.js";
import { MainnetRefundLifecycle } from "../payment/MainnetRefundLifecycle.js";
import { MainnetToncenterReadClient, MainnetToncenterError } from "../payment/MainnetToncenterReadClient.js";

const NOW_MS = 1_700_000_200_000;
const ROOM = "mn-room-001";
const WALLET = "0:" + "1".repeat(64);
const OTHER_WALLET = "0:" + "2".repeat(64);
const SENDERS = ["0:" + "3".repeat(64), "0:" + "4".repeat(64), "0:" + "5".repeat(64)];

function catalog() {
    return JSON.stringify(Array.from({ length: 64 }, (_, i) => ({
        walletId: `mw-${i + 1}`, roomNumber: i + 1,
        address: `0:${String(i + 10).padStart(64, "0")}`, network: "mainnet"
    })));
}

function makeConfig(dataDir, overrides = {}) {
    return loadMainnetRuntimeConfig({
        TON_NETWORK: "mainnet",
        MAINNET_TONCENTER_API_KEY: "offline-synthetic-api-key",
        MAINNET_ROOM_WALLET_DATA_DIR: dataDir,
        MAINNET_ROOM_WALLETS_JSON: catalog(),
        ...overrides
    });
}

function tx({ hash = "tx-1", source = SENDERS[0], destination = WALLET, amount = "1000",
    comment = "WW1:pay_a", now = Math.floor((NOW_MS + 500) / 1000), mc = 800 } = {}) {
    const message = { source, destination, value: amount };
    if (comment !== null) {
        message.message_content = { decoded: { type: "text_comment", comment } };
    }
    return {
        account: WALLET, hash, now,
        description: { aborted: false, compute_ph: { success: true }, action: { success: true } },
        in_msg: message,
        emulated: false,
        block_ref: { workchain: 0, shard: "8000000000000000", seqno: 4788 },
        mc_block_seqno: mc
    };
}

function harness(t, { transactions = [], headGlobalId = -239, headSeqno = 805,
    fetchError = null, limitRows = null } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "wheelwin-mainnet-incoming-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const config = makeConfig(dataDir);
    const calls = [];
    const response = (payload) => ({ status: 200, json: async () => payload });
    const fetchImpl = async (input, init) => {
        calls.push({ url: String(input), init });
        if (fetchError) throw fetchError;
        const url = new URL(String(input));
        if (url.pathname === "/api/v3/transactions") {
            const rows = limitRows === null ? transactions : transactions.slice(0, limitRows);
            return response({ transactions: rows, address_book: {} });
        }
        if (url.pathname === "/api/v3/masterchainInfo") {
            return response({ last: { global_id: headGlobalId, seqno: headSeqno } });
        }
        if (url.pathname === "/api/v2/getAddressInformation") {
            return response({ result: { state: "active", balance: "2500000000" } });
        }
        throw new Error("unexpected endpoint");
    };
    const client = new MainnetToncenterReadClient({ config, fetchImpl });
    const ledger = new MainnetIncomingPaymentLedger({ config, nowProvider: () => NOW_MS + 1_000 }).initialize();
    const financialLedger = new MainnetFinancialLedger({ config, nowProvider: () => NOW_MS + 1_000 }).initialize();
    const service = new MainnetIncomingPaymentService({
        config, client, ledger, nowProvider: () => NOW_MS + 1_000, minimumMasterchainDepth: 1
    });
    const refundLifecycle = new MainnetRefundLifecycle({
        financialLedger, incomingLedger: ledger,
        adapter: { async sendTransfer() { throw new Error("offline test: no transfer"); },
            async estimateOutboundTransferFee() { throw new Error("offline test: no fee quote"); } },
        outgoingObserver: { async findOutgoingTransfer() {}, async verifyIndexedRecipientCredit() {} },
        independentVerifier: { async verifyTransfer() { return null; } }, nowProvider: () => NOW_MS + 1_000
    });
    refundLifecycle.configureReservedWalletRoomNumberResolver(() => 1);
    return { config, client, ledger, financialLedger, service, refundLifecycle, calls, dataDir };
}

test("Mainnet account precheck is a fixed Toncenter Mainnet GET with no Testnet fallback", async (t) => {
    const h = harness(t);
    const info = await h.client.getAddressInformation(WALLET);
    assert.equal(info.result.state, "active");
    assert.equal(h.calls.length, 1);
    const call = h.calls[0];
    const url = new URL(call.url);
    assert.equal(url.hostname, "toncenter.com");
    assert.equal(url.pathname, "/api/v2/getAddressInformation");
    assert.equal(url.searchParams.get("address"), WALLET);
    assert.equal(call.init.method, "GET");
    await assert.rejects(h.client.getAddressInformation(""),
        (error) => error.code === "MAINNET_ACCOUNT_QUERY_INVALID");
});

function registerThree(service, { senders = SENDERS, amounts = ["1000", "2000", "3000"] } = {}) {
    return service.createRoomPaymentIntents({
        roomId: ROOM,
        wallet: { network: "mainnet", globalId: -239, walletId: "mw-room", address: WALLET },
        createdAt: NOW_MS - 10_000,
        expiresAt: NOW_MS + 60_000,
        players: senders.map((expectedSender, i) => ({
            playerId: `player-${i + 1}`, expectedSender, amountAtomic: amounts[i],
            paymentReference: ["pay_a", "pay_b", "pay_c"][i]
        }))
    });
}

test("valid finalized Mainnet incoming transfer settles exactly one intent", async (t) => {
    const h = harness(t, { transactions: [tx()] });
    registerThree(h.service);
    const result = await h.service.observeRoom(ROOM);
    assert.equal(result.confirmed, 1);
    assert.equal(result.paymentStatus.status, "1/3");
    assert.equal(h.ledger.listReceipts(ROOM)[0].status, "CONFIRMED");
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).page5Enabled, false);
    assert.deepEqual(h.calls.map((call) => new URL(call.url).hostname), [
        "toncenter.com", "toncenter.com"
    ]);
    assert.ok(h.calls.every((call) => call.init.method === "GET"));
});

test("provider network error leaves intents and receipts unchanged", async (t) => {
    const h = harness(t, { fetchError: new Error("offline") });
    registerThree(h.service);
    await assert.rejects(h.service.observeRoom(ROOM), (error) => error.code === "MAINNET_TONCENTER_NETWORK_ERROR");
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).status, "0/3");
    assert.equal(h.ledger.listReceipts(ROOM).length, 0);
});

test("wrong sender is recorded unresolved and never credited", async (t) => {
    const h = harness(t, { transactions: [tx({ source: OTHER_WALLET })] });
    registerThree(h.service);
    const result = await h.service.observeRoom(ROOM);
    assert.equal(result.confirmed, 0);
    assert.equal(h.ledger.listReceipts(ROOM)[0].reason, "SENDER_MISMATCH");
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).status, "0/3");
    assert.deepEqual(h.refundLifecycle.prepareClosedRoom({ roomId: ROOM, roomNumber: 1,
        closureReason: "pre_page5_destroyed", status: "DESTROYED", prePage5: true }), []);
});

test("wrong recipient is ignored even when Toncenter returns the row", async (t) => {
    const h = harness(t, { transactions: [tx({ destination: OTHER_WALLET })] });
    registerThree(h.service);
    const result = await h.service.observeRoom(ROOM);
    assert.equal(result.confirmed, 0);
    assert.equal(h.ledger.listReceipts(ROOM).length, 0);
});

test("finalized amount mismatch is retained as an uncredited receipt without settling the intent", async (t) => {
    const h = harness(t, { transactions: [tx({ amount: "1001" })] });
    registerThree(h.service);
    const result = await h.service.observeRoom(ROOM);
    assert.equal(result.confirmed, 0);
    assert.equal(result.extra, 1);
    assert.equal(h.ledger.listReceipts(ROOM)[0].status, "EXTRA_PAYMENT");
    assert.equal(h.ledger.listReceipts(ROOM)[0].reason, "AMOUNT_MISMATCH");
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).status, "0/3");
});

test("transaction outside the registered intent window cannot settle", async (t) => {
    const h = harness(t, { transactions: [tx({ now: Math.floor((NOW_MS - 20_000) / 1000) })] });
    registerThree(h.service);
    const result = await h.service.observeRoom(ROOM);
    assert.equal(result.confirmed, 0);
    assert.equal(h.ledger.listReceipts(ROOM).length, 0);
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).status, "0/3");
});

test("payment without memo settles only when sender, amount, wallet and window identify one intent", async (t) => {
    const h = harness(t, { transactions: [tx({ comment: null })] });
    registerThree(h.service);
    const result = await h.service.observeRoom(ROOM);
    assert.equal(result.confirmed, 1);
    assert.equal(h.ledger.listReceipts(ROOM)[0].paymentReference, "pay_a");
});

test("unsupported transaction payload is not treated as an absent memo", async (t) => {
    const invalidPayload = tx();
    invalidPayload.in_msg.message_content.decoded.type = "binary_comment";
    const h = harness(t, { transactions: [invalidPayload] });
    registerThree(h.service);
    const result = await h.service.observeRoom(ROOM);
    assert.equal(result.confirmed, 0);
    assert.equal(h.ledger.listReceipts(ROOM)[0].reason, "MALFORMED_PAYMENT_REFERENCE");
});

test("memo-less transfer matching multiple intents is left ambiguous", async (t) => {
    const h = harness(t, { transactions: [tx({ comment: null })] });
    registerThree(h.service, { senders: [SENDERS[0], SENDERS[0], SENDERS[2]], amounts: ["1000", "1000", "3000"] });
    const result = await h.service.observeRoom(ROOM);
    assert.equal(result.confirmed, 0);
    assert.equal(h.ledger.listReceipts(ROOM)[0].status, "AMBIGUOUS");
    assert.equal(h.ledger.listReceipts(ROOM)[0].reason, "MULTIPLE_INTENTS_MATCH");
    assert.deepEqual(h.refundLifecycle.prepareClosedRoom({ roomId: ROOM, roomNumber: 1,
        closureReason: "pre_page5_destroyed", status: "DESTROYED", prePage5: true }), []);
});

test("a settled exact-reference payment is not refund-attributed when the sender has multiple owners", async (t) => {
    const h = harness(t, { transactions: [tx({ comment: "WW1:pay_a" }),
        tx({ hash: "tx-extra-ambiguous-owner", comment: "WW1:pay_a" })] });
    registerThree(h.service, { senders: [SENDERS[0], SENDERS[0], SENDERS[2]], amounts: ["1000", "2000", "3000"] });
    const result = await h.service.observeRoom(ROOM);
    assert.equal(result.confirmed, 1, "existing exact-reference settlement behavior is preserved");
    assert.equal(result.extra, 0);
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).status, "1/3");
    assert.equal(h.ledger.getReceipt(h.ledger.listReceipts(ROOM)[1].transactionId).status, "AMBIGUOUS");
    const refunds = h.refundLifecycle.prepareClosedRoom({ roomId: ROOM, roomNumber: 1,
        closureReason: "pre_page5_destroyed", status: "DESTROYED", prePage5: true });
    assert.equal(refunds.length, 1, "only the confirmed principal is refundable");
    assert.equal(refunds[0].incomingTransactionId, h.ledger.listReceipts(ROOM)[0].transactionId);
});

test("duplicate transaction rows are counted once", async (t) => {
    const duplicate = tx();
    const h = harness(t, { transactions: [duplicate, duplicate] });
    registerThree(h.service);
    const result = await h.service.observeRoom(ROOM);
    assert.equal(result.confirmed, 1);
    assert.equal(result.duplicates, 1);
    assert.equal(h.ledger.listReceipts(ROOM).length, 1);
});

test("same transaction identity with conflicting payload fails closed", async (t) => {
    const h = harness(t, { transactions: [tx(), tx({ amount: "1001" })] });
    registerThree(h.service);
    await assert.rejects(h.service.observeRoom(ROOM), /MAINNET_TRANSACTION_IDENTITY_CONFLICT/);
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).status, "1/3");
    assert.equal(h.ledger.listReceipts(ROOM).length, 1);
});

test("replaying transaction history is idempotent", async (t) => {
    const h = harness(t, { transactions: [tx()] });
    registerThree(h.service);
    await h.service.observeRoom(ROOM);
    const replay = await h.service.observeRoom(ROOM);
    assert.equal(replay.confirmed, 0);
    assert.equal(replay.duplicates, 1);
    assert.equal(h.ledger.listReceipts(ROOM).length, 1);
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).status, "1/3");
});

test("an additional finalized transfer from an already-paid player is recorded without a second credit", async (t) => {
    const extra = tx({ hash: "tx-extra", comment: "WW1:pay_a" });
    const h = harness(t, { transactions: [tx(), extra] });
    registerThree(h.service);
    const result = await h.service.observeRoom(ROOM);
    assert.equal(result.confirmed, 1);
    assert.equal(result.extra, 1);
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).status, "1/3");
    assert.equal(h.ledger.listReceipts(ROOM).filter((receipt) => receipt.status === "EXTRA_PAYMENT").length, 1);
});

test("identified unmatched receipt follows normal ingestion into one refund and survives restart", async (t) => {
    const unexpectedReference = tx({ hash: "tx-uncredited", amount: "1500", comment: "WW1:unknown_ref" });
    const h = harness(t, { transactions: [unexpectedReference] });
    registerThree(h.service);

    const observed = await h.service.observeRoom(ROOM);
    assert.equal(observed.confirmed, 0);
    assert.equal(observed.extra, 1);
    assert.equal(observed.paymentStatus.status, "0/3");
    const receipt = h.ledger.listReceipts(ROOM)[0];
    assert.equal(receipt.status, "EXTRA_PAYMENT");
    assert.equal(receipt.playerId, "player-1");
    assert.equal(receipt.paymentReference, "pay_a");
    assert.equal(receipt.amountAtomic, "1500");

    const closed = h.refundLifecycle.prepareClosedRoom({ roomId: ROOM, roomNumber: 1,
        closureReason: "pre_page5_destroyed", status: "DESTROYED", prePage5: true });
    assert.equal(closed.length, 1);
    assert.equal(closed[0].incomingTransactionId, receipt.transactionId);
    assert.equal(closed[0].amountAtomic, 1500);
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).status, "0/3");

    const duplicateScan = await h.service.observeRoom(ROOM);
    assert.equal(duplicateScan.duplicates, 1);
    assert.equal(h.ledger.listReceipts(ROOM).length, 1);

    const incomingRestart = new MainnetIncomingPaymentLedger({
        config: h.config, nowProvider: () => NOW_MS + 2_000
    }).initialize();
    const financialRestart = new MainnetFinancialLedger({
        config: h.config, nowProvider: () => NOW_MS + 2_000
    }).initialize();
    const refundRestart = new MainnetRefundLifecycle({
        financialLedger: financialRestart, incomingLedger: incomingRestart,
        adapter: { async sendTransfer() { throw new Error("offline test: no transfer"); },
            async estimateOutboundTransferFee() { throw new Error("offline test: no fee quote"); } },
        outgoingObserver: { async findOutgoingTransfer() {}, async verifyIndexedRecipientCredit() {} },
        independentVerifier: { async verifyTransfer() { return null; } }, nowProvider: () => NOW_MS + 2_000
    });
    refundRestart.configureReservedWalletRoomNumberResolver(() => 1);
    const replay = refundRestart.prepareClosedRoom({ roomId: ROOM, roomNumber: 1,
        closureReason: "pre_page5_destroyed", status: "DESTROYED", prePage5: true });
    assert.equal(replay.length, 1);
    assert.equal(replay[0].replay, true);
    assert.equal(financialRestart.listRefunds(ROOM).length, 1);
    assert.equal(incomingRestart.getRoomPaymentStatus(ROOM).status, "0/3");
});

test("identified additional payment is only refunded once and never credits a PENDING intent", async (t) => {
    const rows = [tx({ hash: "tx-main", amount: "1000", comment: "WW1:pay_a" }),
        tx({ hash: "tx-extra-pending", amount: "1001", comment: "WW1:pay_a" })];
    const h = harness(t, { transactions: rows });
    registerThree(h.service);

    const observed = await h.service.observeRoom(ROOM);
    assert.equal(observed.confirmed, 1);
    assert.equal(observed.extra, 1);
    assert.equal(observed.paymentStatus.status, "1/3");
    const refunds = h.refundLifecycle.prepareClosedRoom({ roomId: ROOM, roomNumber: 1,
        closureReason: "pre_page5_destroyed", status: "DESTROYED", prePage5: true });
    assert.equal(refunds.length, 2, "the original principal and extra receipt are both refundable on closure");
    assert.equal(refunds.find(item => item.incomingTransactionId === h.ledger.listReceipts(ROOM)
        .find(receipt => receipt.status === "EXTRA_PAYMENT").transactionId).amountAtomic, 1001);
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).status, "1/3");
    const replay = await h.service.observeRoom(ROOM);
    assert.equal(replay.duplicates, 2);
    assert.equal(h.refundLifecycle.prepareClosedRoom({ roomId: ROOM, roomNumber: 1,
        closureReason: "pre_page5_destroyed", status: "DESTROYED", prePage5: true }).length, 2);
    assert.equal(h.financialLedger.listRefunds(ROOM).length, 2);
});

test("unknown sender is retained as unresolved and not attributed", async (t) => {
    const h = harness(t, { transactions: [tx({ source: OTHER_WALLET, comment: null })] });
    registerThree(h.service);
    const result = await h.service.observeRoom(ROOM);
    assert.equal(result.confirmed, 0);
    assert.equal(h.ledger.listReceipts(ROOM)[0].reason, "UNKNOWN_SENDER");
});

test("restart restores intents, confirmations, observations and receipts", async (t) => {
    const h = harness(t, { transactions: [tx()] });
    registerThree(h.service);
    await h.service.observeRoom(ROOM);
    const restoredLedger = new MainnetIncomingPaymentLedger({
        config: h.config, nowProvider: () => NOW_MS + 2_000
    }).initialize();
    assert.equal(restoredLedger.getRoomPaymentStatus(ROOM).status, "1/3");
    assert.equal(restoredLedger.listObservations(ROOM).length, 1);
    assert.equal(restoredLedger.listReceipts(ROOM)[0].status, "CONFIRMED");
});

test("two of three is not financially ready; three of three is ready without enabling Page5", async (t) => {
    const rows = [
        tx({ hash: "tx-a", comment: "WW1:pay_a" }),
        tx({ hash: "tx-b", source: SENDERS[1], amount: "2000", comment: "WW1:pay_b" }),
        tx({ hash: "tx-c", source: SENDERS[2], amount: "3000", comment: "WW1:pay_c" })
    ];
    const h = harness(t, { transactions: rows.slice(0, 2) });
    registerThree(h.service);
    const two = await h.service.observeRoom(ROOM);
    assert.equal(two.paymentStatus.status, "2/3");
    assert.equal(two.paymentStatus.financialReady, false);
    assert.equal(two.paymentStatus.page5Enabled, false);

    const full = harness(t, { transactions: rows });
    registerThree(full.service);
    const three = await full.service.observeRoom(ROOM);
    assert.equal(three.paymentStatus.status, "3/3");
    assert.equal(three.paymentStatus.financialReady, true);
    assert.equal(three.paymentStatus.page5Enabled, false);
});

test("wrong masterchain global ID rejects confirmation and writes no receipt", async (t) => {
    const h = harness(t, { transactions: [tx()], headGlobalId: -3 });
    registerThree(h.service);
    await assert.rejects(h.service.observeRoom(ROOM), /MAINNET_MASTERCHAIN_GLOBAL_ID_MISMATCH/);
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).status, "0/3");
    assert.equal(h.ledger.listReceipts(ROOM).length, 0);
});

test("indexed transaction remains pending until Mainnet masterchain depth is sufficient", async (t) => {
    const h = harness(t, { transactions: [tx()], headSeqno: 800 });
    registerThree(h.service);
    const waiting = await h.service.observeRoom(ROOM);
    assert.equal(waiting.confirmed, 0);
    assert.equal(h.ledger.listReceipts(ROOM)[0].status, "PENDING_FINALITY");
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).status, "0/3");

    const finalizedClient = new MainnetToncenterReadClient({
        config: h.config,
        fetchImpl: async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/api/v3/transactions") return { status: 200,
                json: async () => ({ transactions: [tx()], address_book: {} }) };
            return { status: 200, json: async () => ({ last: { global_id: -239, seqno: 801 } }) };
        }
    });
    const recovered = new MainnetIncomingPaymentService({
        config: h.config, client: finalizedClient, ledger: h.ledger,
        nowProvider: () => NOW_MS + 1_000, minimumMasterchainDepth: 1
    });
    const finalized = await recovered.observeRoom(ROOM);
    assert.equal(finalized.confirmed, 1);
    assert.equal(h.ledger.getRoomPaymentStatus(ROOM).status, "1/3");
});

test("incomplete Toncenter history window cannot settle a payment", async (t) => {
    const h = harness(t, { transactions: [tx()], limitRows: 1 });
    registerThree(h.service);
    const result = await h.service.observeRoom(ROOM, { limit: 1 });
    assert.equal(result.status, "INCOMPLETE_WINDOW");
    assert.equal(result.paymentStatus.status, "0/3");
    assert.equal(h.ledger.listReceipts(ROOM).length, 0);
});

test("malformed incoming sender for the queried Mainnet wallet is surfaced as incomplete history", async t => {
    const h = harness(t, { transactions: [tx({ source: "not-a-valid-ton-address" })] });
    const batch = await h.client.listIncomingTransactions({ account: WALLET,
        floorMs: NOW_MS - 10_000, ceilingMs: NOW_MS + 1_000, limit: 100 });
    assert.equal(batch.resultWindowComplete, true);
    assert.equal(batch.records.length, 0);
    assert.equal(batch.malformedIncomingCandidateCount, 1);
});

test("Mainnet transport is fixed to Toncenter Mainnet and exposes read-only calls only", (t) => {
    const h = harness(t);
    assert.equal(h.client.baseUrl, "https://toncenter.com");
    assert.equal(h.client.network, "mainnet");
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(h.client));
    assert.equal(methods.some((name) => /send|submit|broadcast|sign|refund|payout/i.test(name)), false);
});

test("Mainnet configuration has no Testnet credential or catalog fallback", (t) => {
    const h = harness(t);
    assert.throws(() => makeConfig(h.dataDir, { TON_API_KEY: "testnet-key" }),
        /TESTNET_CREDENTIAL_OR_CATALOG_PRESENT_IN_MAINNET_RUNTIME/);
    assert.throws(() => new MainnetToncenterReadClient({ config: {
        network: "testnet", globalId: -3, toncenterBaseUrl: "https://testnet.toncenter.com",
        apiKeyProvider: () => "testnet"
    } }), /MAINNET_TONCENTER_CONFIG_REQUIRED/);
});

test("missing Mainnet API credential fails before any RPC request", async (t) => {
    const h = harness(t);
    registerThree(h.service);
    const noKeyConfig = { ...h.config, apiKeyProvider: () => "" };
    const client = new MainnetToncenterReadClient({ config: noKeyConfig, fetchImpl: async () => {
        throw new Error("must not run");
    } });
    await assert.rejects(client.listIncomingTransactions({
        account: WALLET, floorMs: NOW_MS - 1000, ceilingMs: NOW_MS + 1000
    }), (error) => error instanceof MainnetToncenterError && error.code === "MAINNET_TONCENTER_API_KEY_REQUIRED");
});
