import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FinancialOutcomeStore} from '../../payment/FinancialOutcomeStore.js';
import {durableWriteJson} from '../../payment/DurableJson.js';
import {resolveDefaultRoomWalletPaymentDataDir} from '../../payment/runtime/PaymentRuntimeFactory.js';
import {LedgerStore, RoomLedger, CurrencyMapping, RoomPayoutCalculator} from '../../payment/ledger/index.js';
import {PaymentIntentStore} from '../../payment/PaymentIntentStore.js';

function directory(t) {
    const path = mkdtempSync(join(tmpdir(), 'ww-financial-boundary-'));
    t.after(() => rmSync(path, {recursive:true, force:true}));
    return path;
}

test('Railway financial records require the persistent volume', () => {
    assert.equal(resolveDefaultRoomWalletPaymentDataDir({RAILWAY_VOLUME_MOUNT_PATH:'/persistent'}), join('/persistent', 'room-wallet-payments'));
    assert.throws(() => resolveDefaultRoomWalletPaymentDataDir({RAILWAY_ENVIRONMENT_ID:'test'}), /Persistent/);
    assert.equal(resolveDefaultRoomWalletPaymentDataDir({ROOM_WALLET_DATA_DIR:'G:/explicit'}), 'G:/explicit');
});

test('atomic exclusive publication never replaces the original financial decision', t => {
    const path = join(directory(t), 'record.json');
    durableWriteJson(path, {debt:2500000000}, {exclusive:true});
    assert.throws(() => durableWriteJson(path, {debt:0}, {exclusive:true}), {code:'EEXIST'});
    assert.equal(JSON.parse(readFileSync(path)).debt, 2500000000);
    durableWriteJson(path, {debt:2500000000, state:'UNKNOWN'});
    assert.equal(JSON.parse(readFileSync(path)).state, 'UNKNOWN');
});

test('winner identity and payout decision survive restart in one durable record', t => {
    const dir = directory(t), store = new FinancialOutcomeStore(dir);
    const result = {payoutId:'payout-test', winnerId:'Lena', principal:6000000000};
    store.claim('room', 'PAYOUT', result);
    const restored = new FinancialOutcomeStore(dir);
    assert.deepEqual(restored.list()[0].context, result);
    assert.throws(() => restored.claim('room', 'REFUND'), /CONFLICT/);
    assert.throws(() => restored.claim('room', 'PAYOUT', {...result, winnerId:'Bob'}), /CONFLICT/);
    restored.claim('room', 'PAYOUT', result);
});

test('restart repairs both recipient obligations after crash immediately after payout plan', t => {
    const dir = directory(t);
    const store = new LedgerStore({dataDir:dir}); store.initialize();
    const intents = new PaymentIntentStore({dataDir:dir}); intents.initialize();
    const plan = RoomPayoutCalculator.computePlan({payoutId:'payout-test',roomId:'room',asset:'TON',network:'testnet',
        principalAtomic:6000000000, safetyMarginAtomic:0,
        winner:{recipientId:'Lena',address:'0:'+'a'.repeat(64)}, owner:{recipientId:'WheelWin',address:'0:'+'b'.repeat(64)},
        networkFees:{winner:{feeAtomic:2000000},owner:{feeAtomic:2000000}},nowMs:Date.now()});
    store.append({idempotencyKey:'payout-test:plan',roomId:'room',kind:'PAYOUT_PLAN',amountAtomic:6000000000,
        asset:'TON',network:'testnet',metadata:{payoutId:'payout-test',plan:plan.toJSON()}});
    const ledger = new RoomLedger({store:new LedgerStore({dataDir:dir}), intentStore:intents, currency:CurrencyMapping.nativeTon({network:'testnet'})});
    ledger.initialize();
    assert.equal(ledger.listPayoutObligations('room').length, 2);
    assert.equal(ledger.countOpenObligations('room'), 2);
    const count = ledger.store.size;
    ledger.initialize();
    assert.equal(ledger.store.size, count);
    assert.equal(plan.transfers[0].grossAtomic, 5700000000);
    assert.equal(plan.transfers[1].grossAtomic, 300000000);
});
