import test from "node:test";
import assert from "node:assert/strict";

import {
    RoomWalletEvidenceUnavailable,
    normalizeRawTonAddress,
    normalizeTonTransactionHash,
    reconcileDualSourceTransactions,
    fetchDualSourceRoomWalletTransactions
} from "../payment/roomWallet/RoomWalletDualSourceEvidence.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const OLGA = "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b";
const LENA = "0:de5819f3012bf5bb3f0e502aa3a066ffcab5bf4d52dcf384b9b33a857e3907c8";
const BOB = "0:2d8205bb979c1f41c3f2cb7f18ee656e5e7874c111dca4528f21db426dc4476f";
const INPUTS = [
    { lt: "105264227000003", hash: "488351bef406163cf3fc0546e53d6472324e77b787a56a628f1e24c776d99ca3", from: OLGA, time: 1792892552 },
    { lt: "105264234000003", hash: "42e85d64a448206c739b0a953ca22ba0368409425c193ec0bfd4409aceaba72a", from: LENA, time: 1792892555 },
    { lt: "105264240000003", hash: "a3692566ccc78cf87097af572aa573aaf6c0b460c8d11182c5a4850b8a68f5ef", from: BOB, time: 1792892557 }
];

function tonapi(tx, overrides = {}) {
    return {
        utime: tx.time,
        lt: Number(tx.lt),
        hash: tx.hash,
        success: true,
        in_msg: {
            source: { address: tx.from },
            destination: { address: ROOM },
            value: 1000000000
        },
        out_msgs: [],
        ...overrides
    };
}

function toncenter(tx, overrides = {}) {
    return {
        now: tx.time,
        lt: tx.lt,
        hash: Buffer.from(tx.hash, "hex").toString("base64"),
        in_msg: { source: tx.from.toUpperCase(), destination: ROOM.toUpperCase(), value: "1000000000" },
        out_msgs: [],
        ...overrides
    };
}

function compare(a = INPUTS.map(tonapi), b = INPUTS.map(toncenter)) {
    return reconcileDualSourceTransactions({
        tonapiTransactions: a,
        toncenterTransactions: b,
        expectedRoomWalletRaw: ROOM
    });
}

test("incident oj7v: match three independently confirmed deposits", () => {
    const evidence = compare();
    assert.equal(evidence.transactions.length, 3);
    assert.equal(evidence.awaitingSecondProvider, 0);
    assert.equal(evidence.source, "tonapi+toncenter-v3");
    for (let i = 0; i < 3; i++) {
        assert.equal(evidence.transactions[i].transaction_id.hash, INPUTS[i].hash);
        assert.equal(evidence.transactions[i].transaction_id.lt, INPUTS[i].lt);
        assert.equal(evidence.transactions[i].in_msg.source, INPUTS[i].from);
        assert.equal(evidence.transactions[i].in_msg.destination, ROOM);
        assert.equal(evidence.transactions[i].in_msg.value, "1000000000");
        assert.equal(evidence.transactions[i].utime, INPUTS[i].time);
        assert.equal(evidence.transactions[i].success, true);
    }
});

test("hash equivalence is case and encoding independent, but rejects malformed values", () => {
    const hash = INPUTS[0].hash;
    assert.equal(normalizeTonTransactionHash(hash.toUpperCase()), hash);
    assert.equal(normalizeTonTransactionHash(Buffer.from(hash, "hex").toString("base64")), hash);
    assert.equal(normalizeTonTransactionHash("not a hash"), null);
    assert.equal(normalizeRawTonAddress(ROOM.toUpperCase()), ROOM);
    assert.equal(normalizeRawTonAddress({ address: ROOM }), ROOM);
    assert.equal(normalizeRawTonAddress({ unexpected: ROOM }), null);
});

test("indexing lag is pending evidence, not an absent payment", () => {
    const evidence = compare(INPUTS.map(tonapi), [toncenter(INPUTS[0])]);
    assert.equal(evidence.transactions.length, 1);
    assert.equal(evidence.awaitingSecondProvider, 2);
});

test("provider disagreement about amount rejects all attempted confirmations", () => {
    const changed = toncenter(INPUTS[1]);
    changed.in_msg.value = "2000000000";
    assert.throws(
        () => compare(INPUTS.map(tonapi), [toncenter(INPUTS[0]), changed, toncenter(INPUTS[2])]),
        (error) => error instanceof RoomWalletEvidenceUnavailable
            && error.code === "PROVIDER_EVIDENCE_DISAGREEMENT"
    );
});

test("different hashes at the same logical time reject all confirmations", () => {
    const changed = toncenter(INPUTS[0], { hash: Buffer.alloc(32, 7).toString("base64") });
    assert.throws(
        () => compare(INPUTS.map(tonapi), [changed, toncenter(INPUTS[1]), toncenter(INPUTS[2])]),
        (error) => error.code === "PROVIDER_EVIDENCE_DISAGREEMENT"
    );
});

test("failed transaction is never credited despite matching transaction identity", () => {
    const fail = tonapi(INPUTS[0], { success: false });
    const result = compare([fail], [toncenter(INPUTS[0])]);
    assert.equal(result.transactions.length, 0);
});

test("explicitly aborted transaction from second provider is never credited", () => {
    const aborted = toncenter(INPUTS[0], { description: { aborted: true } });
    const result = compare([tonapi(INPUTS[0])], [aborted]);
    assert.equal(result.transactions.length, 0);
});

test("missing sender, destination, value or hash is never credited", () => {
    const broken = [
        tonapi(INPUTS[0], { in_msg: { destination: ROOM, value: "1000000000" } }),
        tonapi(INPUTS[1], { in_msg: { source: LENA, value: "1000000000" } }),
        tonapi(INPUTS[2], { hash: "invalid" })
    ];
    assert.equal(compare(broken).transactions.length, 0);
});

test("network outage is not treated as zero payments", async () => {
    const fetchImpl = async (_url, opts) => ({
        ok: false,
        status: 542,
        json: async () => ({}),
        requestOptions: opts
    });
    await assert.rejects(
        fetchDualSourceRoomWalletTransactions({
            address: ROOM,
            expectedRoomWalletRaw: ROOM,
            fetchImpl
        }),
        (error) => error instanceof RoomWalletEvidenceUnavailable
            && error.code === "EVIDENCE_PROVIDER_HTTP_ERROR"
    );
});

test("both providers must be available; requests remain strictly GET", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
        calls.push({ url, opts });
        return {
            ok: true,
            status: 200,
            json: async () => ({
                transactions: url.includes("tonapi")
                    ? INPUTS.map(tonapi)
                    : INPUTS.map(toncenter)
            })
        };
    };
    const result = await fetchDualSourceRoomWalletTransactions({
        address: ROOM,
        expectedRoomWalletRaw: ROOM,
        fetchImpl
    });
    assert.equal(result.transactions.length, 3);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(c => c.opts.method === "GET"));
    assert.ok(calls.every(c => c.url.startsWith("https://testnet.")));
    assert.ok(calls.every(c => !JSON.stringify(c).includes("secretKey")));
});

test("invalid provider response fails closed", async () => {
    await assert.rejects(
        fetchDualSourceRoomWalletTransactions({
            address: ROOM,
            expectedRoomWalletRaw: ROOM,
            fetchImpl: async () => ({ ok: true, json: async () => ({ transactions: null }) })
        }),
        (err) => err.code === "EVIDENCE_RESPONSE_INVALID"
    );
});
