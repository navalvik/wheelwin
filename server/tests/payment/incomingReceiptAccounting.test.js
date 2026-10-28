import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingReceiptStore } from '../../payment/incoming/IncomingReceiptStore.js';
import { IncomingReceiptAccounting } from '../../payment/incoming/IncomingReceiptAccounting.js';
import { RefundObligationStore } from '../../payment/refund/RefundObligationStore.js';
import { RoomPaymentObservationService, ToncenterIncomingProvider, ToncenterTransactionsClient } from '../../payment/toncenter/index.js';
import { SyntheticTonSettlementEvidenceProvider } from '../helpers/syntheticTonSettlementEvidence.js';
import { HistoricalIncomingReceiptReconciler } from '../../payment/runtime/HistoricalIncomingReceiptReconciler.js';
import { countUnsettledRoomFinancialObligations } from '../../payment/runtime/countUnsettledRoomFinancialObligations.js';

const dir = mkdtempSync(join(tmpdir(), 'ww-receipts-'));
const now = 1700000010000;
const dest = '0:' + '11'.repeat(32);
const senders = ['22','33','44'].map(x => '0:' + x.repeat(32));
const intents = senders.map((expectedSender, n) => ({ roomId: 'Pn6f-test', playerId: 'p'+n,
    paymentReference: 'WW_test_'+n, expectedSender, destinationWalletAddress: dest,
    createdAt: now-9000, expiresAt: now+1000, amountAtomic: 1000000000, state: 'PENDING',
    network:'testnet', asset:'TON' }));
const rows = [1000000000, 1000000000, 3000000000].map((value,n) => ({
    account: dest, hash: 'hash-'+n, now: (now-5000)/1000,
    description: { aborted: false, compute_ph: {success:true}, action:{success:true} },
    in_msg: { source:senders[n], destination:dest, value:String(value), bounced:false,
        message_content: { decoded: {'@type':'empty_cell'} } }
}));
try {
    const store = new IncomingReceiptStore({dataDir:dir}); store.initialize();
    const refundStore = new RefundObligationStore({dataDir:join(dir,'refunds')}); refundStore.initialize();
    const accounting = new IncomingReceiptAccounting({store, refundStore,
        intentStore:{listForRoom:()=>intents}, nowProvider:()=>now});
    const client = new ToncenterTransactionsClient({ apiKeyProvider:()=> 'SYNTHETIC',
        fetchImpl:async()=>({status:200,json:async()=>({transactions:rows,address_book:{}})}) });
    const provider = new ToncenterIncomingProvider({client});
    const observationService = new RoomPaymentObservationService({provider, nowProvider:()=>now,
        settlementEvidenceProvider:new SyntheticTonSettlementEvidenceProvider({nowProvider:()=>now})});
    const observation = await observationService.checkRoomPayments({roomId:'Pn6f-test',walletAddress:dest,
        paymentIntents:intents, floorMs:now-9000, ceilingMs:now});
    accounting.capture({...observation});
    assert.equal(store.listForRoom('Pn6f-test').length,0,'copied observations are untrusted');
    accounting.capture(observation);
    accounting.capture(observation);
    assert.equal(store.listForRoom('Pn6f-test').length,3);
    assert.equal(accounting.prepareClosedRoom('Pn6f-test').length,0,'active room never refunded');
    refundStore.recordClosedRoom({roomId:'Pn6f-test',roomNumber:1,closureReason:'setup_expired',
        closedAtMs:now,networkName:'TESTNET',globalId:-3});
    accounting.prepareClosedRoom('Pn6f-test'); accounting.prepareClosedRoom('Pn6f-test');
    assert.deepEqual(refundStore.list().map(r=>r.amountAtomic).sort(),[1000000000,1000000000,3000000000]);
    assert.ok(intents.every(i=>i.state==='PENDING'),'receipt capture does not credit a stake');
    const restarted = new IncomingReceiptStore({dataDir:dir}); restarted.initialize();
    assert.equal(restarted.listForRoom('Pn6f-test').length,3);
    assert.equal(refundStore.list().length,3,'replay does not duplicate refunds');
    const historyStore=new IncomingReceiptStore({dataDir:join(dir,'history')}); historyStore.initialize();
    const historyRefunds=new RefundObligationStore({dataDir:join(dir,'history-refunds')}); historyRefunds.initialize();
    historyRefunds.recordClosedRoom({roomId:'Pn6f-test',roomNumber:1,closureReason:'setup_expired',
        closedAtMs:now,networkName:'TESTNET',globalId:-3});
    const historyAccounting=new IncomingReceiptAccounting({store:historyStore,refundStore:historyRefunds,
        intentStore:{listForRoom:()=>intents},nowProvider:()=>now});
    let independentEnabled=false;
    const worker=new HistoricalIncomingReceiptReconciler({
        runtime:{receiptStore:historyStore,refundStore:historyRefunds,receiptAccounting:historyAccounting,
            intentStore:{listForRoom:()=>intents}},incomingProvider:provider,nowProvider:()=>now,
        chainObserver:{findOutgoingTransfer:async q=>({transactionId:'source-'+senders.indexOf(q.sourceWalletAddress)}),
            verifyIndexedRecipientCredit:async q=>({status:'MASTERCHAIN_INDEXED_RECIPIENT_CREDIT_OBSERVED',
                globalId:-3,sourceFinality:'finalized',recipientFinality:'finalized',
                sourceTransactionId:q.transactionId,recipientTransactionId:'hash-'+senders.indexOf(q.sourceWalletAddress),
                amountAtomic:q.amountAtomic,messageHash:'msg'})},
        independentVerifier:{verifyTransfer:async q=>independentEnabled ? {...q,
            status:'INDEPENDENT_INDEXED_CREDIT_OBSERVED',provider:'tonapi-testnet'}:null}});
    await worker.recoverRoom('Pn6f-test');
    assert.equal(historyStore.listForRoom('Pn6f-test').length,0,'one provider cannot authorize historical recovery');
    independentEnabled=true;
    await worker.recoverRoom('Pn6f-test'); await worker.recoverRoom('Pn6f-test');
    assert.equal(historyStore.listForRoom('Pn6f-test').length,3);
    assert.equal(historyRefunds.list().length,3);
    // Underpayment and a repeated sender are additional receipts, never a
    // replacement for the original payment or an invitation to double-credit.
    rows.push({...rows[0],hash:'hash-underpaid',in_msg:{...rows[0].in_msg,value:'500000000'}});
    rows.push({...rows[0],hash:'hash-unknown',in_msg:{...rows[0].in_msg,
        source:'0:'+'55'.repeat(32),value:'250000000'}});
    const extra=await observationService.checkRoomPayments({roomId:'Pn6f-test',walletAddress:dest,
        paymentIntents:intents,floorMs:now-9000,ceilingMs:now});
    accounting.capture(extra); accounting.prepareClosedRoom('Pn6f-test');
    assert.equal(store.listForRoom('Pn6f-test').length,5);
    assert.equal(refundStore.list().length,4,'unknown sender remains held, known underpayment is refundable');
    assert.equal(refundStore.list().filter(r=>r.amountAtomic===500000000).length,1);
    assert.ok(countUnsettledRoomFinancialObligations({roomId:'Pn6f-test',receiptStore:store,refundStore,
        ledger:{store:{listForRoom:()=>[]},listPayoutObligations:()=>[]}})>0,
        'unreturned receipts keep room wallet reserved');
    console.log('PASS: unmatched 1/1/3 receipts, trusted finality, closure, restart, idempotent debts');
} finally { rmSync(dir,{recursive:true,force:true}); }
