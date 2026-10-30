import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingReceiptStore } from '../../payment/incoming/IncomingReceiptStore.js';
import { IncomingReceiptAccounting } from '../../payment/incoming/IncomingReceiptAccounting.js';
import { RefundObligationStore } from '../../payment/refund/RefundObligationStore.js';
import { RoomPaymentObservationService, ToncenterIncomingProvider,
    ToncenterTransactionsClient } from '../../payment/toncenter/index.js';
import { SyntheticTonSettlementEvidenceProvider } from '../helpers/syntheticTonSettlementEvidence.js';

test('two finalized Lena transfers: first stake credited, second is one durable refund obligation', async () => {
    const dir=mkdtempSync(join(tmpdir(), 'ww-lena-excess-'));
    try {
        const now=1_700_000_010_000;
        const dest='0:'+'11'.repeat(32);
        const senders=['22','33','44'].map(x=>'0:'+x.repeat(32));
        const refs=['WW-LENA','WW-OLGA','WW-BOB'];
        const players=['Lena','Olga','Bob'];
        const intents=players.map((playerId,i)=>({
            roomId:'room-lena-double',playerId,paymentReference:refs[i],
            expectedSender:senders[i],destinationWalletId:'room-wallet-2',
            destinationWalletAddress:dest,createdAt:now-9000,expiresAt:now+1000,
            amountAtomic:1000000000,state:'PENDING',network:'testnet',asset:'TON',
            transactionId:null
        }));
        const tx=(sender,hash,seconds)=>({
            account:dest,hash,now:seconds,emulated:false,
            description:{aborted:false,compute_ph:{success:true},action:{success:true}},
            in_msg:{source:sender,destination:dest,value:'1000000000',bounced:false,
                message_content:{decoded:{type:'text_comment',
                    comment:'WW1:'+refs[senders.indexOf(sender)]}}}
        });
        const stamp=Math.floor((now-5000)/1000);
        // API newest-first, so the later Lena tx is first in the response.
        const rows=[tx(senders[0],'lena-later',stamp+1),
            tx(senders[1],'olga',stamp),
            tx(senders[2],'bob',stamp),
            tx(senders[0],'lena-earlier',stamp)];
        const receiptStore=new IncomingReceiptStore({dataDir:dir});
        receiptStore.initialize();
        const refundStore=new RefundObligationStore({dataDir:join(dir,'refunds')});
        refundStore.initialize();
        const accounting=new IncomingReceiptAccounting({
            store:receiptStore,refundStore,intentStore:{listForRoom:()=>intents},
            nowProvider:()=>now
        });
        const client=new ToncenterTransactionsClient({
            apiKeyProvider:()=> 'SYNTHETIC',fetchImpl:async()=>({
                status:200,json:async()=>({transactions:rows,address_book:{}})
            })
        });
        const observer=new RoomPaymentObservationService({
            provider:new ToncenterIncomingProvider({client}),
            nowProvider:()=>now,
            settlementEvidenceProvider:new SyntheticTonSettlementEvidenceProvider({
                nowProvider:()=>now
            })
        });
        const observation=await observer.checkRoomPayments({
            roomId:'room-lena-double',walletAddress:dest,paymentIntents:intents,
            floorMs:now-9000,ceilingMs:now,destinationWalletId:'room-wallet-2'
        });
        assert.equal(observation.resultWindowComplete,true);
        assert.equal(observation.observations.filter(x=>x.status==='matched').length,3);
        const extra=observation.observations.filter(x=>x.status==='excess-payment');
        assert.equal(extra.length,1);
        assert.equal(extra[0].excessForPaymentReference,refs[0]);
        const matched=observation.observations.filter(x=>x.status==='matched');
        for(const entry of matched) {
            intents.find(x=>x.paymentReference===entry.paymentReference).transactionId=entry.transactionId;
        }
        const lenaStake=matched.find(x=>x.paymentReference===refs[0]);
        assert.equal(observation.transfers.find(x=>x.transactionId===lenaStake.transactionId)
            .providerTransactionIdentity.transactionId,'lena-earlier');
        accounting.capture(observation);
        accounting.capture(observation);
        assert.equal(receiptStore.listForRoom('room-lena-double').length,4,
            'all four real transfers recorded once despite idempotent replay');
        refundStore.recordClosedRoom({
            roomId:'room-lena-double',roomNumber:2,closureReason:'room_destroyed',
            closedAtMs:now,networkName:'TESTNET',globalId:-3
        });
        const obligations=accounting.prepareClosedRoom('room-lena-double');
        assert.equal(obligations.length,1,
            'exactly one excess Lena transfer is scheduled for a refund');
        assert.equal(obligations[0].obligation.playerId,'Lena');
        assert.equal(obligations[0].obligation.amountAtomic,1000000000);
        assert.equal(obligations[0].obligation.incomingTransactionId,extra[0].transactionId);
        assert.equal(accounting.prepareClosedRoom('room-lena-double').length,1,
            'repeated reconciliation is idempotent');
        assert.equal(refundStore.list().length,1);
        assert.equal(refundStore.list()[0].state,'PENDING',
            'this test prepares an obligation but does not broadcast money');
    } finally {
        rmSync(dir,{recursive:true,force:true});
    }
});
