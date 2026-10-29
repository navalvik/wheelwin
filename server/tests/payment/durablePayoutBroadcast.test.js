import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keyPairFromSeed} from '@ton/crypto';
import {WalletContractV4} from '@ton/ton';
import {RoomWalletAdapter} from '../../payment/roomWallet/RoomWalletAdapter.js';

function setup(t) {
    const directory=mkdtempSync(join(tmpdir(),'ww-durable-payout-'));
    t.after(()=>rmSync(directory,{recursive:true,force:true}));
    const key=keyPairFromSeed(Buffer.alloc(32,11));
    const address=WalletContractV4.create({workchain:0,publicKey:key.publicKey}).address.toString();
    const state={now:1_800_000_000_000, seqno:7, failSeqno:false, failBroadcast:true, sent:[]};
    const make=()=>new RoomWalletAdapter({sequenceStateDir:directory,
        now:()=>state.now, seqnoConfirmTimeoutMs:10, seqnoConfirmPollMs:5,
        sleep:async ms=>{state.now+=ms;},
        walletResolver:async()=>({roomNumber:2,address,workchain:0,...key}),
        tonService:{
            getBalance:async()=>{throw new Error('balance must not gate winner');},
            getSeqno:async()=>{if(state.failSeqno)throw new Error('RPC_READ_TIMEOUT');return state.seqno;},
            broadcastTransaction:async boc=>{
                state.sent.push(boc);
                if(state.failBroadcast)throw new Error('RPC_REPLY_LOST');
                return {status:'SUBMITTED_UNCONFIRMED'};
            }
        }
    });
    const request={roomNumber:2,destination:'0:'+'b'.repeat(64),amountNano:2_850_000_000n,
        bounce:false,idempotencyKey:'payout_example:WINNER'};
    return {state,make,request};
}

test('lost broadcast reply: restart replays identical signed message and never sends again after seqno advances',async t=>{
    const {state,make,request}=setup(t);
    await assert.rejects(make().sendTransfer(request),/RPC_REPLY_LOST/);
    state.failBroadcast=false;
    assert.equal((await make().sendTransfer(request)).ok,true);
    assert.equal(state.sent.length,2);
    assert.equal(state.sent[0],state.sent[1]);
    state.seqno++;
    assert.equal((await make().sendTransfer(request)).code,'ACCEPTED_AWAITING_CREDIT');
    assert.equal(state.sent.length,2);
});

test('expired unused message is renewed only with the same unconsumed seqno',async t=>{
    const {state,make,request}=setup(t);
    await assert.rejects(make().sendTransfer(request),/RPC_REPLY_LOST/);
    state.now+=121_000;
    state.failBroadcast=false;
    await make().sendTransfer(request);
    assert.equal(state.sent.length,2);
    assert.notEqual(state.sent[0],state.sent[1]);
    state.seqno++;
    state.now+=121_000;
    await make().sendTransfer(request);
    assert.equal(state.sent.length,2);
});

test('pre-sign RPC failure is retryable and mismatched retry cannot change recipient amount',async t=>{
    const {state,make,request}=setup(t);
    state.failSeqno=true;
    await assert.rejects(make().sendTransfer(request),/RPC_READ_TIMEOUT/);
    assert.equal(state.sent.length,0);
    state.failSeqno=false;
    state.failBroadcast=false;
    await make().sendTransfer(request);
    await assert.rejects(make().sendTransfer({...request,amountNano:1n}),/IDENTITY_MISMATCH/);
    assert.equal(state.sent.length,1);
});
