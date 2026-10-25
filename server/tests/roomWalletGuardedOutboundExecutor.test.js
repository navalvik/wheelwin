import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Address, beginCell, external, internal, storeMessage, storeMessageRelaxed, SendMode } from "@ton/core";

import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";
import { RoomWalletOutboundIntentJournal } from "../payment/roomWallet/RoomWalletOutboundIntentJournal.js";
import { RoomWalletSingleWriterGate } from "../payment/roomWallet/RoomWalletSingleWriterGate.js";
import { RoomWalletGuardedOutboundExecutor } from "../payment/roomWallet/RoomWalletGuardedOutboundExecutor.js";

const ROOM = "0:c6423c1a3f43921316bd31f66287ad437b94d0b9421340f622619c9fa80173a6";
const OLGA = "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b";
const LENA = "0:de5819f3012bf5bb3f0e502aa3a066ffcab5bf4d52dcf384b9b33a857e3907c8";
const NET = "998611722";
const GAS = "1388278";
const NOW = 1792900000;
const b64 = hash => Buffer.from(hash, "hex").toString("base64");

function fakeSignedV4({ p, seqno = 42, validUntil = NOW + 100,
    signedDestination = p.destinationWallet, signedValue = p.transferNano }) {
    // Offline structural TON V4 message. No real signature or private key.
    const payload = beginCell()
        .storeBuffer(Buffer.alloc(64, 7))
        .storeUint(698983191, 32)
        .storeUint(validUntil, 32)
        .storeUint(seqno, 32)
        .storeUint(0, 8) // Wallet V4 action sendMsg
        .storeUint(SendMode.PAY_GAS_SEPARATELY, 8)
        .storeRef(beginCell().store(storeMessageRelaxed(internal({
            to: Address.parse(signedDestination), value: BigInt(signedValue), bounce: true
        }))).endCell())
        .endCell();
    const message = external({ to: Address.parse(p.roomWallet), body: payload });
    const root = beginCell().store(storeMessage(message)).endCell();
    return {
        roomWallet: p.roomWallet,
        recipientWallet: p.destinationWallet,
        amountNano: p.transferNano,
        seqno,
        validUntil,
        externalHash: root.hash().toString("hex"),
        bocBase64: root.toBoc().toString("base64")
    };
}

function fx(t, { who = "Olga", wallet = OLGA, suffix = "a" } = {}) {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-signing-gate-"));
    const volume = join(root, "ton-financial");
    const locks = join(root, "wallet-locks");
    let active;
    t.after(() => {
        active?.persistence?.shutdown({ checkpoint: false });
        rmSync(root, { recursive: true, force: true });
    });
    function open() {
        const persistence = new TonFinancialPersistence({ dataDir: volume });
        persistence.initialize();
        const journal = new RoomWalletOutboundIntentJournal({ financialPersistence: persistence });
        const gate = new RoomWalletSingleWriterGate({
            directory: locks,
            intentJournal: journal
        });
        active = { persistence, journal, gate };
        return active;
    }
    const original = open();
    const obligationId = "rwrefund_" + suffix.repeat(64);
    original.persistence.createRecoveryDataRecord({
        recoveryRecordId: obligationId,
        kind: "ROOM_WALLET_REFUND_OBLIGATION",
        status: "ACTIVE",
        state: "REFUND_RECONCILIATION_REQUIRED",
        executionAllowed: true,
        network: "testnet",
        roomId: "oj7v",
        roomNumber: 1,
        gameId: "game_oj7v",
        paymentSessionId: "pay_oj7v",
        playerId: who,
        fromRoomWallet: ROOM,
        recipientWallet: wallet,
        grossRefundNano: "1000000000"
    }, { recoveryRecordId: obligationId, roomId: "oj7v", gameId: "game_oj7v",
        status: "ACTIVE", tonNetwork: "testnet" });
    const intentId = original.journal.createRefundPlan({
        obligationId,
        netRefundNano: NET,
        recipientGasChargeNano: GAS,
        frozenGasPlanHash: "a".repeat(64)
    }).intentId;
    return { root, locks, open, intentId, first: original };
}

function mockChainHistory(prepared, recipient = OLGA, value = NET) {
    const H = "e".repeat(64), OUT = "f".repeat(64);
    return {
        tonapiTransactions: [{
            account: { address: ROOM },
            lt: 105271924000001,
            hash: H,
            success: true,
            in_msg: { hash: prepared.externalHash },
            out_msgs: [{
                destination: { address: recipient },
                value: Number(value),
                hash: OUT
            }]
        }],
        toncenterTransactions: [{
            account: ROOM,
            lt: "105271924000001",
            hash: b64(H),
            in_msg: { hash: b64(prepared.externalHash) },
            out_msgs: [{
                destination: recipient,
                value,
                hash: b64(OUT)
            }]
        }]
    };
}

function makeExecutor(store, { enabled = true, seqno = 42,
    broadcaster = async () => ({ ok: true }), chainSeqno = 43,
    prepareOverride = null } = {}) {
    let called = 0;
    let prepared;
    const signer = {
        async prepareSignedTransfer() {
            called++;
            const p = store.journal.listPendingForWallet(ROOM)[0].payload;
            prepared = prepareOverride ?? fakeSignedV4({ p, seqno });
            return prepared;
        }
    };
    let broadcasts = 0;
    const executor = new RoomWalletGuardedOutboundExecutor({
        intentJournal: store.journal,
        walletGate: store.gate,
        signer,
        broadcaster: {
            async broadcastSignedBoc(boc) {
                broadcasts++;
                assert.equal(boc, prepared?.bocBase64);
                return broadcaster(boc);
            }
        },
        chain: { async getSeqno() { return chainSeqno; } },
        enabled,
        nowSeconds: () => NOW
    });
    return { executor, read: () => ({
        signerCalls: called, broadcasts, prepared
    }) };
}

test("disabled by default: no lock, no signature and no on-chain broadcast", async t => {
    const f = fx(t);
    const gate = makeExecutor(f.first, { enabled: false });
    await assert.rejects(gate.executor.execute({ intentId: f.intentId }),
        e => e.code === "OUTBOUND_EXECUTOR_DISABLED");
    assert.deepEqual(gate.read().broadcasts, 0);
    assert.equal(f.first.gate.isLocked(ROOM), false);
});

test("persist SIGNED_HELD before the only broadcast; RPC ACK remains UNKNOWN", async t => {
    const f = fx(t);
    const out = makeExecutor(f.first, {
        broadcaster: async () => {
            const saved = f.first.journal.load(f.intentId);
            assert.equal(saved.payload.state, "SIGNED_HELD");
            assert.equal(f.first.gate.isLocked(ROOM), true);
            return { success: true };
        }
    });
    const result = await out.executor.execute({ intentId: f.intentId });
    assert.equal(result.state, "CONFIRMATION_UNKNOWN");
    assert.equal(result.reason, "RPC_ACKNOWLEDGED");
    assert.equal(out.read().broadcasts, 1);
    assert.equal(f.first.journal.load(f.intentId).payload.seqno, 42);
    assert.equal(f.first.gate.isLocked(ROOM), true);
    assert.equal(f.first.journal.load(f.intentId).payload.signedExternalMessageHash,
        out.read().prepared.externalHash);
    assert.equal((await out.executor.execute({ intentId: f.intentId })).broadcasted, false);
    assert.equal(out.read().broadcasts, 1);
});

test("HTTP 542 may hide a successful send; UNKNOWN holds without rebroadcast", async t => {
    const f = fx(t);
    const out = makeExecutor(f.first, { broadcaster: async () => {
        const err = new Error("TonCenter HTTP 542");
        err.status = 542;
        throw err;
    } });
    const result = await out.executor.execute({ intentId: f.intentId });
    assert.equal(result.reason, "RPC_RESULT_AMBIGUOUS");
    assert.equal(result.state, "CONFIRMATION_UNKNOWN");
    assert.equal(out.read().broadcasts, 1);
    assert.equal(f.first.gate.isLocked(ROOM), true);
    await out.executor.execute({ intentId: f.intentId });
    assert.equal(out.read().broadcasts, 1);
});

test("crash + restart cannot reacquire wallet lock or produce a second send", async t => {
    const f = fx(t);
    const first = makeExecutor(f.first);
    await first.executor.execute({ intentId: f.intentId });
    f.first.persistence.shutdown({ checkpoint: false });
    const recovered = f.open();
    assert.equal(recovered.journal.load(f.intentId).payload.state,
        "CONFIRMATION_UNKNOWN");
    const second = makeExecutor(recovered);
    const secondRun = await second.executor.execute({ intentId: f.intentId });
    assert.equal(secondRun.broadcasted, false);
    assert.equal(second.read().broadcasts, 0);
    assert.equal(recovered.gate.isLocked(ROOM), true);
});

test("actual outgoing proof + seqno releases lock; replay cannot resend", async t => {
    const f = fx(t);
    const out = makeExecutor(f.first);
    await out.executor.execute({ intentId: f.intentId });
    const before = await out.executor.reconcile({
        intentId: f.intentId,
        ...mockChainHistory(out.read().prepared, LENA)
    });
    assert.equal(before.state, "CONFIRMATION_UNKNOWN");
    assert.equal(f.first.gate.isLocked(ROOM), true);
    const final = await out.executor.reconcile({
        intentId: f.intentId,
        ...mockChainHistory(out.read().prepared)
    });
    assert.equal(final.state, "CHAIN_CONFIRMED");
    assert.equal(f.first.journal.load(f.intentId).payload.state, "CHAIN_CONFIRMED");
    assert.equal(f.first.gate.isLocked(ROOM), false);
    const recheck = await out.executor.execute({ intentId: f.intentId });
    assert.equal(recheck.broadcasted, false);
    assert.equal(out.read().broadcasts, 1);
});

test("seqno unchanged cannot finalize or free the durable lock", async t => {
    const f = fx(t);
    const out = makeExecutor(f.first, { chainSeqno: 42 });
    await out.executor.execute({ intentId: f.intentId });
    await assert.rejects(out.executor.reconcile({
        intentId: f.intentId,
        ...mockChainHistory(out.read().prepared)
    }), e => e.code === "OUTBOUND_SEQNO_NOT_ADVANCED");
    assert.equal(f.first.journal.load(f.intentId).payload.state,
        "CONFIRMATION_UNKNOWN");
    assert.equal(f.first.gate.isLocked(ROOM), true);
});

test("another intent may not acquire the same wallet before finality", async t => {
    const f = fx(t);
    await makeExecutor(f.first).executor.execute({ intentId: f.intentId });
    assert.throws(() => f.first.gate.acquire({ intentId: f.intentId }),
        e => e.code === "SIGNER_GATE_NOT_FRESH_PLAN");
    assert.equal(f.first.gate.isLocked(ROOM), true);
});

test("prepared BOC external hash mismatch fails without broadcasting", async t => {
    const f = fx(t);
    const p = f.first.journal.load(f.intentId).payload;
    const bad = { ...fakeSignedV4({ p }), externalHash: "c".repeat(64) };
    const out = makeExecutor(f.first, { prepareOverride: bad });
    await assert.rejects(out.executor.execute({ intentId: f.intentId }),
        e => e.code === "OUTBOUND_SIGNED_HASH_MISMATCH");
    assert.equal(out.read().broadcasts, 0);
    assert.equal(f.first.gate.isLocked(ROOM), false);
    assert.equal(f.first.journal.load(f.intentId).payload.state, "PLANNED");
});

test("invalid signed seqno or expiry in BOC fails closed, no broadcast", async t => {
    const f = fx(t);
    const p = f.first.journal.load(f.intentId).payload;
    const signed = fakeSignedV4({ p, seqno: 42 });
    const out = makeExecutor(f.first, {
        prepareOverride: { ...signed, seqno: 43 }
    });
    await assert.rejects(out.executor.execute({ intentId: f.intentId }),
        e => e.code === "OUTBOUND_BOC_SEQNO_OR_EXPIRY_MISMATCH");
    assert.equal(out.read().broadcasts, 0);
});

test("two different executor instances cannot sign one wallet concurrently", async t => {
    const f = fx(t);
    const one = makeExecutor(f.first);
    const two = makeExecutor(f.first);
    const [a, b] = await Promise.allSettled([
        one.executor.execute({ intentId: f.intentId }),
        two.executor.execute({ intentId: f.intentId })
    ]);
    assert.equal(a.status, "fulfilled");
    assert.equal(b.status, "rejected");
    assert.equal(b.reason.code, "SIGNER_GATE_WALLET_ALREADY_LOCKED");
    assert.equal(one.read().broadcasts, 1);
    assert.equal(two.read().broadcasts, 0);
});

test("fifty distinct Room Wallet locks can coexist on a shared volume", t => {
    const root = mkdtempSync(join(tmpdir(), "ww-50-wallet-leases-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const ids = new Map();
    for (let n = 1; n <= 50; n++) {
        const addr = "0:" + n.toString(16).padStart(64, "0");
        const intentId = "rwout_" + n.toString(16).padStart(64, "0");
        ids.set(intentId, { recordId: intentId, status: "ACTIVE",
            payload: { state: "PLANNED", network: "testnet", roomWallet: addr } });
    }
    const gate = new RoomWalletSingleWriterGate({
        directory: root,
        intentJournal: { load(id) { return ids.get(id); } }
    });
    for (let n = 1; n <= 50; n++) {
        const id = "rwout_" + n.toString(16).padStart(64, "0");
        const addr = "0:" + n.toString(16).padStart(64, "0");
        const token = gate.acquire({ intentId: id });
        assert.equal(token.roomWallet, addr);
        assert.equal(gate.isLocked(addr), true);
    }
    assert.equal(ids.size, 50);
});

test("wrong recipient embedded in signed BOC is rejected even when metadata matches", async t => {
    const f = fx(t);
    const p = f.first.journal.load(f.intentId).payload;
    const malicious = fakeSignedV4({ p, signedDestination: LENA });
    const out = makeExecutor(f.first, { prepareOverride: malicious });
    await assert.rejects(out.executor.execute({ intentId: f.intentId }),
        e => e.code === "OUTBOUND_BOC_RECIPIENT_OR_AMOUNT_MISMATCH");
    assert.equal(out.read().broadcasts, 0);
    assert.equal(f.first.gate.isLocked(ROOM), false);
});

test("wrong nanogram value embedded in signed BOC fails before broadcast", async t => {
    const f = fx(t);
    const p = f.first.journal.load(f.intentId).payload;
    const malicious = fakeSignedV4({ p, signedValue: "1998611722" });
    const out = makeExecutor(f.first, { prepareOverride: malicious });
    await assert.rejects(out.executor.execute({ intentId: f.intentId }),
        e => e.code === "OUTBOUND_BOC_RECIPIENT_OR_AMOUNT_MISMATCH");
    assert.equal(out.read().broadcasts, 0);
});


test("temporary getSeqno failure BEFORE signing releases only the current owner lock", async t => {
    const f = fx(t);
    const brokenSigner = new RoomWalletGuardedOutboundExecutor({
        intentJournal: f.first.journal,
        walletGate: f.first.gate,
        signer: { async prepareSignedTransfer() {
            throw new Error("TonCenter getSeqno temporarily unavailable");
        }},
        broadcaster: { async broadcastSignedBoc() {
            throw new Error("BROADCAST_MUST_NOT_BE_CALLED");
        }},
        chain: { async getSeqno() { return 42; }},
        nowSeconds: () => NOW,
        enabled: true
    });
    await assert.rejects(brokenSigner.execute({ intentId: f.intentId }),
        /TonCenter getSeqno temporarily unavailable/);
    assert.equal(f.first.journal.load(f.intentId).payload.state, "PLANNED");
    assert.equal(f.first.gate.isLocked(ROOM), false);

    // Same plan can now safely prepare/sign, still only one eventual send.
    const recovered = makeExecutor(f.first);
    const state = await recovered.executor.execute({ intentId: f.intentId });
    assert.equal(state.state, "CONFIRMATION_UNKNOWN");
    assert.equal(recovered.read().broadcasts, 1);
});

test("an owned signed-intent lock cannot use the unattempted release shortcut", t => {
    const f = fx(t);
    const token = f.first.gate.acquire({ intentId: f.intentId });
    f.first.journal.holdSignedMessage({
        intentId: f.intentId, seqno: 42,
        signedExternalMessageHash: "b".repeat(64),
        validUntil: NOW + 60
    });
    assert.throws(() => f.first.gate.releaseUnattempted(token),
        e => e.code === "SIGNER_GATE_UNATTEMPTED_PROOF_FAILED");
    assert.equal(f.first.gate.isLocked(ROOM), true);
});

test("a separate signer cannot release an unattempted lock without ownerToken", t => {
    const f = fx(t);
    const token = f.first.gate.acquire({ intentId: f.intentId });
    assert.throws(() => f.first.gate.releaseUnattempted({
        intentId: f.intentId, ownerToken: "stolen-token"
    }), e => e.code === "SIGNER_GATE_OWNERSHIP_LOST");
    assert.equal(f.first.gate.isLocked(ROOM), true);
    assert.equal(f.first.gate.releaseUnattempted(token).released, true);
    assert.equal(f.first.gate.isLocked(ROOM), false);
});
