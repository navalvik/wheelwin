import test from 'node:test';
import assert from 'node:assert/strict';
import {TestnetPendingRefundExecutor} from '../../payment/runtime/TestnetPendingRefundExecutor.js';

test('executor sends only PENDING debts and never retries ambiguous broadcasts', async () => {
    const debts = [{obligationId:'a',state:'PENDING'}, {obligationId:'b',state:'SUBMISSION_UNKNOWN'}, {obligationId:'c',state:'SUBMITTED'}];
    const sent = [];
    const worker = new TestnetPendingRefundExecutor({runtime:{
        outgoingRefundProvider:{canExecute:()=>true},
        refundStore:{listClosedRooms:()=>[],listPending:()=>debts},
        refundLifecycle:{submitRefund:async id=>{sent.push(id); debts.find(x=>x.obligationId===id).state='SUBMISSION_UNKNOWN'; return {id};}}
    }});
    await worker.runPass();
    await worker.runPass();
    assert.deepEqual(sent, ['a']);
});

test('overlapping passes cannot send the same pending debt concurrently', async () => {
    let complete, calls = 0;
    const worker = new TestnetPendingRefundExecutor({runtime:{
        outgoingRefundProvider:{canExecute:()=>true},
        refundStore:{listClosedRooms:()=>[],listPending:()=>[{obligationId:'a',state:'PENDING'}]},
        refundLifecycle:{submitRefund:()=>{calls++;return new Promise(resolve=>{complete=resolve;});}}
    }});
    const first = worker.runPass();
    assert.deepEqual(await worker.runPass(), []);
    assert.equal(calls, 1);
    complete({outcome:'SUBMISSION_UNKNOWN'});
    await first;
});
