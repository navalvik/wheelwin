import assert from 'node:assert/strict';
import { Address } from '@ton/core';
import { TestnetNativeTonService } from '../../payment/roomWallet/TestnetNativeTonService.js';
const account=Address.parse('0:'+'11'.repeat(32));
const check=value=>assert.ok(Address.isAddress(value));
const service=new TestnetNativeTonService({client:{
    async getContractState(value){check(value);return {state:'active'};},
    async runMethod(value){check(value);return {stack:{readNumber:()=>7}};},
    async getBalance(value){check(value);return 1000000000n;},
    async estimateExternalMessageFee(value){check(value);return {source_fees:{in_fwd_fee:1,storage_fee:2,gas_fee:3,fwd_fee:4}};}
}});
for(const value of [account,account.toRawString()]) {
    assert.equal(await service.getSeqno(value),7);
    assert.equal(await service.getBalance(value),1000000000n);
    assert.equal((await service.estimateExternalMessageFee(value,{})).totalFeeNano,10n);
}
console.log('PASS: native fee/seqno/balance accepts SDK Address objects and strings');
