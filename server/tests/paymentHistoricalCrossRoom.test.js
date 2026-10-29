import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IncomingReceiptStore } from "../payment/incoming/IncomingReceiptStore.js";
import { IncomingReceiptAccounting } from "../payment/incoming/IncomingReceiptAccounting.js";
import { RefundObligationStore } from "../payment/refund/RefundObligationStore.js";
import { HistoricalIncomingReceiptReconciler } from "../payment/runtime/HistoricalIncomingReceiptReconciler.js";

const address = n => `0:${n.toString(16).padStart(64, "0")}`;
const wallet = address(4), payerA = address(100), payerB = address(101), unknownPayer = address(102);
const roomA = "Room-A", roomB = "Room-B";
const intentA = { roomId:roomA, playerId:"player-a", paymentReference:"ref-room-a",
    destinationWalletId:"room-wallet-4", destinationWalletAddress:wallet, expectedSender:payerA,
    amountAtomic:1_000_000_000, createdAt:1_000_000, expiresAt:1_480_000, state:"EXPIRED" };
const intentB = { roomId:roomB, playerId:"player-b", paymentReference:"ref-room-b",
    destinationWalletId:"room-wallet-4", destinationWalletAddress:wallet, expectedSender:payerB,
    amountAtomic:1_000_000_000, createdAt:1_600_000, expiresAt:2_080_000, state:"EXPIRED" };

function record({ id, time, sender, reference }) {
    return { network:"testnet", accountId:wallet, transactionId:id, transactionTime:time,
        sourceAddress:sender, destinationAddress:wallet, amountAtomic:"1000000000", asset:"TON",
        comment:reference ?? null };
}

test("historical room recovery isolates reused wallets, preserves unique late payment, and quarantines ambiguity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ww-cross-room-recovery-"));
    try {
        const receiptStore = new IncomingReceiptStore({ dataDir:dir }); receiptStore.initialize();
        const refundStore = new RefundObligationStore({ dataDir:join(dir, "refunds") }); refundStore.initialize();
        refundStore.recordClosedRoom({ roomId:roomA, roomNumber:4, closureReason:"setup_expired",
            closedAtMs:1_480_000, networkName:"TESTNET", globalId:-3 });

        const transfers = [
            record({ id:"late-a", time:1_550_000, sender:payerA, reference:intentA.paymentReference }),
            record({ id:"payment-b", time:1_700_000, sender:payerB, reference:intentB.paymentReference }),
            record({ id:"uncertain", time:1_800_000, sender:unknownPayer, reference:null })
        ];
        const sourceBySender = new Map(transfers.map(row => [row.sourceAddress, `source-${row.transactionId}`]));
        const transactionBySource = new Map(transfers.map(row => [`source-${row.transactionId}`, row.transactionId]));
        const allIntents = [intentA, intentB];
        const intentStore = { listForRoom:id => allIntents.filter(row => row.roomId === id), list:() => allIntents };
        const receiptAccounting = new IncomingReceiptAccounting({ store:receiptStore, intentStore,
            refundStore, nowProvider:() => 2_000_000 });
        const runtime = {
            receiptStore, refundStore, receiptAccounting, intentStore,
            walletPool: {
                resolveReservationOwnerAt({ transactionTime }) {
                    if (transactionTime < 1_500_000) return { status:"OWNED", roomId:roomA, candidates:[roomA] };
                    if (transactionTime < 1_600_000) return { status:"UNKNOWN", roomId:null, candidates:[] };
                    if (transactionTime < 1_750_000) return { status:"OWNED", roomId:roomB, candidates:[roomB] };
                    return { status:"AMBIGUOUS", roomId:null, candidates:[roomA, roomB] };
                }
            }
        };
        const worker = new HistoricalIncomingReceiptReconciler({ runtime,
            incomingProvider:{ listIncomingTransactions:async () => ({
                resultWindowComplete:true, rowsReturned:transfers.length, records:transfers
            }) },
            chainObserver:{
                findOutgoingTransfer:async query => ({ transactionId:sourceBySender.get(query.sourceWalletAddress) }),
                verifyIndexedRecipientCredit:async query => {
                    const transactionId = transactionBySource.get(query.transactionId);
                    return { status:"MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED", globalId:-3,
                        sourceFinality:"finalized", recipientFinality:"finalized",
                        sourceTransactionId:query.transactionId, recipientTransactionId:transactionId,
                        amountAtomic:query.amountAtomic, messageHash:`message-${transactionId}` };
                }
            },
            independentVerifier:{ verifyTransfer:async query => ({ ...query,
                status:"INDEPENDENT_INDEXED_CREDIT_OBSERVED", provider:"tonapi-testnet" }) },
            nowProvider:() => 2_000_000
        });

        const roomAResult = await worker.recoverRoom(roomA);
        assert.deepEqual(receiptStore.listForRoom(roomA).map(row => row.providerTransactionId), ["late-a"],
            `A's exact late payment is recovered, but B's payment is not assigned to A (${JSON.stringify(roomAResult)})`);
        assert.equal(receiptStore.get(receiptStore.listUnresolved()[0]?.transactionId)?.providerTransactionId, "uncertain");
        assert.equal(receiptStore.listUnresolved().length, 1);
        assert.equal(refundStore.list().length, 1, "only the uniquely attributable A receipt creates a refund obligation");

        const restartedReceipts = new IncomingReceiptStore({ dataDir:dir }); restartedReceipts.initialize();
        assert.equal(restartedReceipts.listForRoom(roomA).length, 1);
        assert.equal(restartedReceipts.listUnresolved().length, 1);
        await worker.recoverRoom(roomA);
        assert.equal(restartedReceipts.listForRoom(roomA).length, 1, "recovery replay adds no duplicate receipt");
        assert.equal(refundStore.list().length, 1, "recovery replay adds no duplicate refund");

        refundStore.recordClosedRoom({ roomId:roomB, roomNumber:5, closureReason:"setup_expired",
            closedAtMs:2_080_000, networkName:"TESTNET", globalId:-3 });
        const roomBResult = await worker.recoverRoom(roomB);
        assert.equal(roomBResult.captured, 1, "Room B can independently recover its own wallet transfer");
        assert.deepEqual(receiptStore.listForRoom(roomB).map(row => row.providerTransactionId), ["payment-b"]);
        assert.equal(receiptStore.listForRoom(roomA).some(row => row.providerTransactionId === "payment-b"), false);
        assert.equal(receiptStore.listUnresolved().length, 1, "ambiguous transfer remains held without refund");
    } finally { rmSync(dir, { recursive:true, force:true }); }
});
