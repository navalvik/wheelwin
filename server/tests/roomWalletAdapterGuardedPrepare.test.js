import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    Address, Cell, loadMessage, loadMessageRelaxed, SendMode
} from "@ton/core";
import { keyPairFromSeed } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

import { RoomWalletAdapter } from "../payment/roomWallet/RoomWalletAdapter.js";
import { RoomWalletSingleWriterGate } from "../payment/roomWallet/RoomWalletSingleWriterGate.js";
import { RoomWalletOutboundIntentJournal } from "../payment/roomWallet/RoomWalletOutboundIntentJournal.js";
import { RoomWalletGuardedOutboundExecutor } from "../payment/roomWallet/RoomWalletGuardedOutboundExecutor.js";
import { TonFinancialPersistence } from "../persistence/TonFinancialPersistence.js";

const keyPair = keyPairFromSeed(Buffer.alloc(32, 0x39));
const contract = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
const walletAddress = contract.address.toRawString().toLowerCase();
const OLGA = "0:bdab0280cbbda45f5a0fb6bc97fa0e72e380769986440761d574901e269ae56b";

function fixture(overrides = {}) {
    let broadcastCalls = 0;
    let seqnoCalls = 0;
    const tonService = {
        async getSeqno() {
            seqnoCalls++;
            if (overrides.seqnoFailure) throw new Error("timeout");
            return overrides.seqno ?? 42;
        },
        async getBalance() {
            return overrides.balance ?? 3_000_000_000n;
        },
        async broadcastTransaction() {
            broadcastCalls++;
            throw new Error("NO REAL NETWORK ACCESS ALLOWED IN TEST");
        }
    };
    const adapter = new RoomWalletAdapter({
        tonService,
        walletResolver: async () => ({
            address: contract.address.toString({ bounceable: true, urlSafe: true }),
            workchain: 0, roomNumber: 1,
            publicKey: keyPair.publicKey,
            secretKey: keyPair.secretKey
        })
    });
    return { adapter, calls: () => ({ broadcastCalls, seqnoCalls }) };
}

const args = {
    roomNumber: 1, roomWallet: walletAddress,
    recipientWallet: OLGA,
    amountNano: "998611722",
    recipientGasChargeNano: "1388278",
    role: "REFUND"
};

test("actual WalletContractV4 signed BOC embeds destination, value, seqno and expiry", async () => {
    const f = fixture();
    const prepared = await f.adapter.prepareSignedTransfer(args);
    assert.equal(prepared.roomWallet, walletAddress);
    assert.equal(prepared.recipientWallet, OLGA);
    assert.equal(prepared.amountNano, args.amountNano);
    assert.equal(prepared.seqno, 42);
    assert.ok(prepared.validUntil > Math.floor(Date.now() / 1000));
    const root = Cell.fromBoc(Buffer.from(prepared.bocBase64, "base64"))[0];
    assert.equal(root.hash().toString("hex"), prepared.externalHash);
    const externalMessage = loadMessage(root.beginParse());
    assert.equal(externalMessage.info.type, "external-in");
    assert.equal(externalMessage.info.dest.toRawString(), walletAddress);
    const body = externalMessage.body.beginParse();
    body.skip(512);
    body.loadUint(32); // wallet id
    assert.equal(body.loadUint(32), prepared.validUntil);
    assert.equal(body.loadUint(32), 42);
    assert.equal(body.loadUint(8), 0);
    assert.equal(body.loadUint(8), SendMode.PAY_GAS_SEPARATELY);
    const internalMessage = loadMessageRelaxed(body.loadRef().beginParse());
    assert.equal(internalMessage.info.type, "internal");
    assert.equal(internalMessage.info.dest.toRawString(), OLGA);
    assert.equal(internalMessage.info.value.coins, 998611722n);
    assert.equal(f.calls().broadcastCalls, 0);
});

test("sign-only preparation refuses missing authoritative seqno", async () => {
    const f = fixture({ seqnoFailure: true });
    await assert.rejects(f.adapter.prepareSignedTransfer(args),
        /GUARDED_SIGNER_SEQNO_UNAVAILABLE/);
    assert.equal(f.calls().broadcastCalls, 0);
});

test("sign-only refuses insufficient balance for net amount plus charged fee", async () => {
    const f = fixture({ balance: 998611722n });
    await assert.rejects(f.adapter.prepareSignedTransfer(args),
        /GUARDED_SIGNER_INSUFFICIENT_BALANCE/);
    assert.equal(f.calls().broadcastCalls, 0);
});

test("sign-only rejects redirect to unexpected room wallet", async () => {
    const f = fixture();
    await assert.rejects(f.adapter.prepareSignedTransfer({
        ...args, roomWallet: OLGA
    }), /GUARDED_SIGNER_WALLET_IDENTITY_MISMATCH/);
    assert.equal(f.calls().broadcastCalls, 0);
});

test("signed real V4 payload and persisted intent work together without live RPC", async t => {
    const root = mkdtempSync(join(tmpdir(), "wheelwin-real-sig-"));
    t.after(() => rmSync(root, { force: true, recursive: true }));
    const persistence = new TonFinancialPersistence({ dataDir: join(root, "data") });
    persistence.initialize();
    t.after(() => persistence.shutdown({ checkpoint: false }));
    const journal = new RoomWalletOutboundIntentJournal({ financialPersistence: persistence });
    const obligationId = "rwrefund_" + "2".repeat(64);
    persistence.createRecoveryDataRecord({
        recoveryRecordId: obligationId,
        kind: "ROOM_WALLET_REFUND_OBLIGATION",
        status: "ACTIVE",
        state: "REFUND_RECONCILIATION_REQUIRED",
        executionAllowed: true,
        network: "testnet", roomId: "oj7v", roomNumber: 1,
        gameId: "demo_mock_game", paymentSessionId: "demo_mock_session",
        playerId: "Olga", fromRoomWallet: walletAddress,
        recipientWallet: OLGA, grossRefundNano: "1000000000"
    }, { recoveryRecordId: obligationId, status: "ACTIVE",
        roomId: "oj7v", gameId: "demo_mock_game", tonNetwork: "testnet" });
    const intentId = journal.createRefundPlan({
        obligationId, netRefundNano: "998611722",
        recipientGasChargeNano: "1388278", frozenGasPlanHash: "9".repeat(64)
    }).intentId;
    const gate = new RoomWalletSingleWriterGate({
        directory: join(root, "signer-locks"), intentJournal: journal
    });
    const { adapter, calls } = fixture();
    let broadcastInvocations = 0;
    const executor = new RoomWalletGuardedOutboundExecutor({
        intentJournal: journal, walletGate: gate, signer: adapter,
        broadcaster: { async broadcastSignedBoc(boc) {
            assert.ok(boc.length > 64);
            broadcastInvocations++;
            // Simulated accepted transport, NO actual TON network access.
            return { accepted: true };
        }},
        chain: { async getSeqno() { return 43; } },
        enabled: true
    });
    const first = await executor.execute({ intentId });
    assert.equal(first.state, "CONFIRMATION_UNKNOWN");
    assert.equal(broadcastInvocations, 1);
    assert.equal(calls().broadcastCalls, 0);
    assert.equal(gate.isLocked(walletAddress), true);
    const repeat = await executor.execute({ intentId });
    assert.equal(repeat.broadcasted, false);
    assert.equal(broadcastInvocations, 1);
    assert.equal(journal.load(intentId).payload.seqno, 42);
});
