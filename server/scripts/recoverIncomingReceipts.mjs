/** Explicit historical receipt/debt recovery only. Never creates a signer or broadcasts. */
import 'dotenv/config';
import { join } from 'node:path';
import { resolveDefaultRoomWalletPaymentDataDir } from '../payment/runtime/PaymentRuntimeFactory.js';
import { PaymentIntentStore } from '../payment/PaymentIntentStore.js';
import { RefundObligationStore } from '../payment/refund/RefundObligationStore.js';
import { IncomingReceiptStore } from '../payment/incoming/IncomingReceiptStore.js';
import { IncomingReceiptAccounting } from '../payment/incoming/IncomingReceiptAccounting.js';
import { ToncenterIncomingProvider, ToncenterTransactionsClient } from '../payment/toncenter/index.js';
import { ToncenterTestnetOutgoingTransferProvider } from '../payment/refund/ToncenterTestnetOutgoingTransferProvider.js';
import { TonapiTestnetPayoutVerifier } from '../payment/refund/TonapiTestnetPayoutVerifier.js';
import { HistoricalIncomingReceiptReconciler } from '../payment/runtime/HistoricalIncomingReceiptReconciler.js';

const roomId=process.argv[2];
if (!roomId || !/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) throw new Error('Provide room ID');
const dataDir=join(resolveDefaultRoomWalletPaymentDataDir(),'testnet');
const intentStore=new PaymentIntentStore({dataDir}); intentStore.initialize();
const refundStore=new RefundObligationStore({dataDir:join(dataDir,'refunds')}); refundStore.initialize();
const receiptStore=new IncomingReceiptStore({dataDir}); receiptStore.initialize();
const receiptAccounting=new IncomingReceiptAccounting({store:receiptStore,intentStore,refundStore});
const client=new ToncenterTransactionsClient();
const worker=new HistoricalIncomingReceiptReconciler({runtime:{intentStore,refundStore,receiptStore,receiptAccounting},
    incomingProvider:new ToncenterIncomingProvider({client}),
    chainObserver:new ToncenterTestnetOutgoingTransferProvider({client}),
    independentVerifier:new TonapiTestnetPayoutVerifier()});
console.log(JSON.stringify(await worker.recoverRoom(roomId)));
console.log(JSON.stringify({roomId,receipts:receiptStore.listForRoom(roomId).length,
    refunds:refundStore.list().filter(r=>r.roomId===roomId).map(r=>({id:r.obligationId,amountAtomic:r.amountAtomic,state:r.state}))}));
