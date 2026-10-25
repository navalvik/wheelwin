import test from "node:test";
import assert from "node:assert/strict";

import {
    fetchExpiredRoomWalletHistory
} from "../payment/roomWallet/RoomWalletExpiredChainScanner.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const OLGA = "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b";
const LENA = "0:de5819f3012bf5bb3f0e502aa3a066ffcab5bf4d52dcf384b9b33a857e3907c8";
const BOB = "0:2d8205bb979c1f41c3f2cb7f18ee656e5e7874c111dca4528f21db426dc4476f";

const data = [
    { lt: "105264240000003", hash: "a3692566ccc78cf87097af572aa573aaf6c0b460c8d11182c5a4850b8a68f5ef", time: 240, from: BOB },
    { lt: "105264234000003", hash: "42e85d64a448206c739b0a953ca22ba0368409425c193ec0bfd4409aceaba72a", time: 230, from: LENA },
    { lt: "105264227000003", hash: "488351bef406163cf3fc0546e53d6472324e77b787a56a628f1e24c776d99ca3", time: 220, from: OLGA },
    { lt: "105000000000001", hash: "e".repeat(64), time: 190, from: OLGA }
];

function mock({ tonapi = data, toncenter = data, fail = null, ignoreCursor = false } = {}) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        assert.equal(options.method, "GET");
        const provider = url.includes("tonapi.io") ? "tonapi" : "toncenter";
        const u = new URL(url);
        calls.push({ provider, url });
        if (provider === fail) return { ok: false, status: 542 };
        const records = (provider === "tonapi" ? tonapi : toncenter);
        const upper = provider === "tonapi" ? u.searchParams.get("before_lt") : u.searchParams.get("end_lt");
        const selected = records.filter(row => {
            if (!upper || ignoreCursor) return true;
            return provider === "tonapi"
                ? BigInt(row.lt) < BigInt(upper)
                : BigInt(row.lt) <= BigInt(upper);
        }).slice(0, Number(u.searchParams.get("limit")));
        return {
            ok: true,
            status: 200,
            async json() {
                return {
                    transactions: selected.map(row => ({
                        lt: provider === "tonapi" ? Number(row.lt) : row.lt,
                        hash: provider === "tonapi"
                            ? row.hash
                            : Buffer.from(row.hash, "hex").toString("base64"),
                        ...(provider === "tonapi"
                            ? { utime: row.time, success: true }
                            : { now: row.time }),
                        in_msg: {
                            source: provider === "tonapi"
                                ? { address: row.from }
                                : row.from.toUpperCase(),
                            destination: provider === "tonapi"
                                ? { address: ROOM }
                                : ROOM.toUpperCase(),
                            value: provider === "tonapi" ? 1000000000 : "1000000000"
                        }
                    }))
                };
            }
        };
    };
    return { calls, fetchImpl };
}

function query(fetchImpl, opts = {}) {
    return fetchExpiredRoomWalletHistory({
        address: ROOM,
        sessionStartMs: 205_000,
        startMarginMs: 0,
        fetchImpl,
        pageSize: 2,
        timeoutMs: 1000,
        ...opts
    });
}

test("oj7v: discovers all three deposits despite 2-page provider histories", async () => {
    const f = mock();
    const history = await query(f.fetchImpl);
    assert.equal(history.transactions.length, 3);
    assert.equal(history.historyComplete, true);
    assert.equal(history.awaitingSecondProvider, 0);
    assert.equal(history.walletReleaseAuthorized, false);
    assert.equal(history.scannedTransactions.tonapiPages, 2);
    assert.equal(history.scannedTransactions.toncenterV3Pages, 2);
    assert.equal(history.scannedTransactions.tonapi, 4);
    assert.equal(history.scannedTransactions.toncenterV3, 4);
    assert.ok(f.calls.some(x => x.url.includes("before_lt=105264234000003")));
    assert.ok(f.calls.some(x => x.url.includes("end_lt=105264234000002")));
    assert.deepEqual(
        history.transactions.map(x => x.transaction_id.lt),
        data.slice(0, 3).map(x => x.lt)
    );
});

test("missing one provider receipt is pending evidence, not no funds", async () => {
    const b = [data[0], data[2], data[3]];
    const history = await query(mock({ toncenter: b }).fetchImpl);
    assert.equal(history.awaitingSecondProvider, 1);
    assert.equal(history.transactions.length, 2);
    assert.equal(history.walletReleaseAuthorized, false);
});

test("TonCenter 542 fails closed without returning an empty list", async () => {
    await assert.rejects(
        query(mock({ fail: "toncenter" }).fetchImpl),
        (err) => err.code === "HISTORY_PROVIDER_HTTP_FAILURE"
    );
});

test("a fixed cursor or repeated LT never loops indefinitely", async () => {
    await assert.rejects(
        query(mock({ ignoreCursor: true }).fetchImpl),
        (err) => err.code === "HISTORY_ORDER_OR_HASH_INVALID"
    );
});

test("limited history pages fail closed, never claim complete history", async () => {
    await assert.rejects(
        query(mock().fetchImpl, { maxPagesPerProvider: 1 }),
        (err) => err.code === "HISTORY_INCOMPLETE_PAGE_BUDGET"
    );
});

test("a provider with no transactions cannot authorize wallet release", async () => {
    const history = await query(mock({ tonapi: [], toncenter: [] }).fetchImpl);
    assert.equal(history.transactions.length, 0);
    assert.equal(history.historyComplete, true);
    assert.equal(history.walletReleaseAuthorized, false);
});

test("malformed accounts, dates, and pagination limits fail closed", async () => {
    for (const opts of [
        { address: "not an address" },
        { sessionStartMs: NaN },
        { pageSize: 0 },
        { maxPagesPerProvider: 0 },
        { timeoutMs: 0 }
    ]) {
        await assert.rejects(query(mock().fetchImpl, opts));
    }
});
