import assert from 'node:assert/strict';
import { TonapiTestnetPayoutVerifier } from '../../payment/refund/TonapiTestnetPayoutVerifier.js';
const source='0:'+'11'.repeat(32), destination='0:'+'22'.repeat(32);
const fromHash='aa'.repeat(32), toHash='bb'.repeat(32), msgHash='cc'.repeat(32);
const message={hash:msgHash,source:{address:source},destination:{address:destination},value:1000000000,bounced:false};
const txs=[{hash:fromHash,account:{address:source},success:true,aborted:false,total_fees:51669,out_msgs:[message]},
    {hash:toHash,account:{address:destination},success:true,aborted:false,total_fees:51669,in_msg:message}];
const verifier=new TonapiTestnetPayoutVerifier({apiKeyProvider:()=>'',fetchImpl:async url=>({status:200,
    json:async()=>url.endsWith(fromHash)?txs[0]:txs[1]})});
const query={sourceTransactionId:fromHash,recipientTransactionId:toHash,messageHash:msgHash,
    sourceWalletAddress:source,destinationAddress:destination,amountAtomic:1000000000};
assert.equal((await verifier.verifyTransfer(query))?.amountAtomic,1000000000);
message.value=Number.MAX_SAFE_INTEGER+1;
assert.equal(await verifier.verifyTransfer(query),null);
console.log('PASS: actual TonAPI numeric amount/fees schema and unsafe-number rejection');
