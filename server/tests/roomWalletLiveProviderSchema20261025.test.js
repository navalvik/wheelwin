/**
 * Read-only API-format regression based on observed 25 Oct 2026 TON Testnet
 * public Room Wallet #1 transactions and the provider wire schemas.
 * These fixture tests do NOT access either provider or sign/send GRAM.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    reconcileDualSourceTransactions
} from "../payment/roomWallet/RoomWalletDualSourceEvidence.js";
import {
    verifyOutgoingPaymentFromBothProviders
} from "../payment/roomWallet/RoomWalletDualSourceOutgoingReceipt.js";
import {
    fetchDualSourceRoomWalletTip
} from "../payment/roomWallet/RoomWalletDualSourceAccountTip.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const PEOPLE = Object.freeze([
    Object.freeze({
        name: "Olga",
        from: "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b",
        lt: "105264227000003",
        hash: "488351bef406163cf3fc0546e53d6472324e77b787a56a628f1e24c776d99ca3",
        utime: 1792892552
    }),
    Object.freeze({
        name: "Lena",
        from: "0:de5819f3012bf5bb3f0e502aa3a066ffcab5bf4d52dcf384b9b33a857e3907c8",
        lt: "105264234000003",
        hash: "42e85d64a448206c739b0a953ca22ba0368409425c193ec0bfd4409aceaba72a",
        utime: 1792892555
    }),
    Object.freeze({
        name: "Bob",
        from: "0:2d8205bb979c1f41c3f2cb7f18ee656e5e7874c111dca4528f21db426dc4476f",
        lt: "105264240000003",
        hash: "a3692566ccc78cf87097af572aa573aaf6c0b460c8d11182c5a4850b8a68f5ef",
        utime: 1792892557
    })
]);
const OLGA_REFUND = Object.freeze({
    hash: "decf4284978c28153475f4ac94668f77e233bed93d6aaf32f3ed9e737514565c",
    lt: "105271924000001",
    messageHash: "8bd49707c7daa0f04fb1ba2f7ec05842213f540935d2f030de4e73a31b47fd94",
    valueNano: "998611722"
});
const to64 = s => Buffer.from(s, "hex").toString("base64");

function wireIncoming(p, provider) {
    if (provider === "tonapi") {
        return {
            account: { address: ROOM },
            hash: p.hash,
            lt: Number(p.lt),
            success: true,
            utime: p.utime,
            in_msg: {
                source: p.from,
                destination: ROOM,
                value: "1000000000",
                hash: "0".repeat(64)
            },
            out_msgs: []
        };
    }
    return {
        account: ROOM.toUpperCase(),
        hash: to64(p.hash),
        lt: p.lt,
        now: p.utime,
        description: { aborted: false },
        in_msg: {
            source: p.from.toUpperCase(),
            destination: ROOM.toUpperCase(),
            value: "1000000000",
            hash: to64("0".repeat(64))
        },
        out_msgs: []
    };
}

function wireRefund(provider) {
    if (provider === "tonapi") {
        return {
            account: { address: ROOM },
            hash: OLGA_REFUND.hash,
            lt: Number(OLGA_REFUND.lt),
            success: true,
            utime: 1792910000,
            in_msg: { hash: "d".repeat(64) },
            out_msgs: [{
                destination: { address: PEOPLE[0].from },
                value: Number(OLGA_REFUND.valueNano),
                hash: OLGA_REFUND.messageHash
            }]
        };
    }
    return {
        account: ROOM.toUpperCase(),
        hash: to64(OLGA_REFUND.hash),
        lt: OLGA_REFUND.lt,
        now: 1792910000,
        description: { aborted: false },
        in_msg: { hash: to64("d".repeat(64)) },
        out_msgs: [{
            destination: PEOPLE[0].from.toUpperCase(),
            value: OLGA_REFUND.valueNano,
            hash: to64(OLGA_REFUND.messageHash)
        }]
    };
}

test("real-world wire conventions match exactly three 1-GRAM room payments", () => {
    const matches = reconcileDualSourceTransactions({
        tonapiTransactions: PEOPLE.map(p => wireIncoming(p, "tonapi")),
        toncenterTransactions: PEOPLE.map(p => wireIncoming(p, "toncenter")),
        expectedRoomWalletRaw: ROOM
    });
    assert.equal(matches.transactions.length, 3);
    assert.equal(matches.awaitingSecondProvider, 0);
    const identified = matches.transactions.map(tx => ({
        from: tx.in_msg.source,
        value: tx.in_msg.value,
        lt: tx.transaction_id.lt,
        hash: tx.transaction_id.hash
    }));
    for (const person of PEOPLE) {
        assert.ok(identified.some(tx => tx.from === person.from
            && tx.lt === person.lt
            && tx.hash === person.hash
            && tx.value === "1000000000"));
    }
});

test("TonCenter base64 hashes and uppercase raw addresses confirm Olga's historical refund", () => {
    const confirmation = verifyOutgoingPaymentFromBothProviders({
        tonapiTransactions: [wireRefund("tonapi")],
        toncenterTransactions: [wireRefund("toncenter")],
        roomWallet: ROOM,
        recipientWallet: PEOPLE[0].from,
        valueNano: OLGA_REFUND.valueNano,
        knownWalletTransactionHash: OLGA_REFUND.hash,
        knownWalletTransactionLt: OLGA_REFUND.lt
    });
    assert.equal(confirmation.state, "CHAIN_CONFIRMED");
    assert.equal(confirmation.receipt.roomWalletTxHash, OLGA_REFUND.hash);
    assert.equal(confirmation.receipt.outboundMessageHash, OLGA_REFUND.messageHash);
    assert.equal(confirmation.broadcastAuthorized, false);
});

test("two providers' mismatched refund value cannot confirm or authorize re-broadcast", () => {
    const unsafe = wireRefund("toncenter");
    unsafe.out_msgs[0].value = "998611723";
    assert.throws(() => verifyOutgoingPaymentFromBothProviders({
        tonapiTransactions: [wireRefund("tonapi")],
        toncenterTransactions: [unsafe],
        roomWallet: ROOM,
        recipientWallet: PEOPLE[0].from,
        valueNano: OLGA_REFUND.valueNano,
        knownWalletTransactionHash: OLGA_REFUND.hash,
        knownWalletTransactionLt: OLGA_REFUND.lt
    }), error => error.code === "OUTGOING_MESSAGES_DISAGREE");
});

test("provider lag never credits an incoming payment", () => {
    const result = reconcileDualSourceTransactions({
        tonapiTransactions: PEOPLE.map(p => wireIncoming(p, "tonapi")),
        toncenterTransactions: PEOPLE.slice(1).map(p => wireIncoming(p, "toncenter")),
        expectedRoomWalletRaw: ROOM
    });
    assert.equal(result.transactions.length, 2);
    assert.equal(result.awaitingSecondProvider, 1);
    assert.equal(result.transactions.some(tx => tx.in_msg.source === PEOPLE[0].from), false);
});

test("real account-state schemas return identical account head after Olga refund", async () => {
    let calls = 0;
    const fetchImpl = async url => {
        calls++;
        if (url.includes("tonapi.io")) {
            return { ok: true, async json() {
                return {
                    address: ROOM,
                    last_transaction_lt: Number(OLGA_REFUND.lt),
                    last_transaction_hash: OLGA_REFUND.hash
                };
            }};
        }
        return { ok: true, async json() {
            return { accounts: [{
                address: ROOM.toUpperCase(),
                last_transaction_lt: OLGA_REFUND.lt,
                last_transaction_hash: to64(OLGA_REFUND.hash)
            }] };
        }};
    };
    const tip = await fetchDualSourceRoomWalletTip({
        roomWallet: ROOM, fetchImpl
    });
    assert.equal(calls, 2);
    assert.equal(tip.headLt, OLGA_REFUND.lt);
    assert.equal(tip.headHash, OLGA_REFUND.hash);
    assert.equal(tip.providersAgree, true);
});

test("stale account-state tip cannot release quarantine", async () => {
    const fetchImpl = async url => {
        const base = {
            last_transaction_lt: OLGA_REFUND.lt,
            last_transaction_hash: OLGA_REFUND.hash
        };
        if (url.includes("tonapi.io")) {
            return { ok: true, async json() { return base; } };
        }
        return { ok: true, async json() {
            return { accounts: [{
                ...base,
                address: ROOM.toUpperCase(),
                last_transaction_lt: "105271923000001"
            }] };
        }};
    };
    await assert.rejects(
        fetchDualSourceRoomWalletTip({ roomWallet: ROOM, fetchImpl }),
        error => error.code === "WALLET_HEAD_PROVIDERS_DISAGREE"
    );
});


test("duplicate identical LT from TonAPI never credits one deposit twice", () => {
    const repeated = wireIncoming(PEOPLE[0], "tonapi");
    assert.throws(() => reconcileDualSourceTransactions({
        tonapiTransactions: [repeated, { ...repeated }],
        toncenterTransactions: [wireIncoming(PEOPLE[0], "toncenter")],
        expectedRoomWalletRaw: ROOM
    }), error => error.code === "DUPLICATE_LT_ON_PROVIDER");
});

test("duplicate identical LT from TON Center v3 is not silently accepted", () => {
    const repeated = wireIncoming(PEOPLE[0], "toncenter");
    assert.throws(() => reconcileDualSourceTransactions({
        tonapiTransactions: [wireIncoming(PEOPLE[0], "tonapi")],
        toncenterTransactions: [repeated, { ...repeated }],
        expectedRoomWalletRaw: ROOM
    }), error => error.code === "DUPLICATE_LT_ON_PROVIDER");
});

test("positive incoming payment with missing sender cannot turn into zero liabilities", () => {
    const source = wireIncoming(PEOPLE[1], "tonapi");
    const malformed = {
        ...source,
        in_msg: { ...source.in_msg, source: null }
    };
    assert.throws(() => reconcileDualSourceTransactions({
        tonapiTransactions: [malformed],
        toncenterTransactions: [wireIncoming(PEOPLE[1], "toncenter")],
        expectedRoomWalletRaw: ROOM
    }), error => error.code === "MALFORMED_ROOM_WALLET_INCOMING_EVIDENCE");
});

test("positive incoming with unknown value fails closed even if both APIs omit it", () => {
    const first = wireIncoming(PEOPLE[2], "tonapi");
    const second = wireIncoming(PEOPLE[2], "toncenter");
    first.in_msg.value = null;
    second.in_msg.value = null;
    assert.throws(() => reconcileDualSourceTransactions({
        tonapiTransactions: [first],
        toncenterTransactions: [second],
        expectedRoomWalletRaw: ROOM
    }), error => error.code === "MALFORMED_ROOM_WALLET_INCOMING_EVIDENCE");
});

test("external zero-value wallet signing message is ignored, not treated as a player deposit", () => {
    const outside = wireIncoming(PEOPLE[0], "tonapi");
    outside.in_msg = { source: null, destination: ROOM, value: "0" };
    const result = reconcileDualSourceTransactions({
        tonapiTransactions: [outside],
        toncenterTransactions: [],
        expectedRoomWalletRaw: ROOM
    });
    assert.equal(result.transactions.length, 0);
    assert.equal(result.awaitingSecondProvider, 0);
});


test("different reported TonAPI account is rejected despite matching destination", () => {
    const tx = wireIncoming(PEOPLE[0], "tonapi");
    tx.account = { address: PEOPLE[0].from };
    assert.throws(() => reconcileDualSourceTransactions({
        tonapiTransactions: [tx],
        toncenterTransactions: [wireIncoming(PEOPLE[0], "toncenter")],
        expectedRoomWalletRaw: ROOM
    }), error => error.code === "EVIDENCE_ACCOUNT_MISMATCH");
});

test("different reported TON Center account is rejected even if all payment fields match", () => {
    const tx = wireIncoming(PEOPLE[1], "toncenter");
    tx.account = PEOPLE[1].from.toUpperCase();
    assert.throws(() => reconcileDualSourceTransactions({
        tonapiTransactions: [wireIncoming(PEOPLE[1], "tonapi")],
        toncenterTransactions: [tx],
        expectedRoomWalletRaw: ROOM
    }), error => error.code === "EVIDENCE_ACCOUNT_MISMATCH");
});


test("real TonCenter v3 external-in source:null and value:null is not a paid deposit", () => {
    // The provider's actual wallet-v4 external inbound shape has import_fee
    // but no internal created_lt/fwd_fee. TonAPI represents the same action
    // with source absent and numeric zero value.
    const toncenterExternal = {
        account: ROOM.toUpperCase(),
        lt: "105271924000001",
        hash: to64(OLGA_REFUND.hash),
        now: 1792895626,
        in_msg: {
            hash: to64("d".repeat(64)),
            source: null, destination: ROOM.toUpperCase(), value: null,
            created_lt: null, created_at: null,
            import_fee: "0", fwd_fee: null
        },
        out_msgs: [{
            destination: PEOPLE[0].from.toUpperCase(),
            hash: to64(OLGA_REFUND.messageHash),
            value: OLGA_REFUND.valueNano
        }]
    };
    const tonapiExternal = {
        account: { address: ROOM },
        lt: 105271924000001,
        hash: OLGA_REFUND.hash,
        utime: 1792895626,
        success: true,
        in_msg: {
            msg_type: "ext_in_msg",
            destination: ROOM, value: 0,
            hash: "d".repeat(64)
        },
        out_msgs: []
    };
    const verified = reconcileDualSourceTransactions({
        tonapiTransactions: [tonapiExternal],
        toncenterTransactions: [toncenterExternal],
        expectedRoomWalletRaw: ROOM
    });
    assert.equal(verified.transactions.length, 0);
    assert.equal(verified.awaitingSecondProvider, 0);
});

test("null amount and null sender without external-only metadata remain untrusted", () => {
    const malformed = wireIncoming(PEOPLE[1], "toncenter");
    malformed.in_msg.source = null;
    malformed.in_msg.value = null;
    malformed.in_msg.import_fee = null;
    assert.throws(() => reconcileDualSourceTransactions({
        tonapiTransactions: [],
        toncenterTransactions: [malformed],
        expectedRoomWalletRaw: ROOM
    }), error => error.code === "MALFORMED_ROOM_WALLET_INCOMING_EVIDENCE");
});
