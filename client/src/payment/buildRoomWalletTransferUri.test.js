import assert from 'node:assert/strict';
import { buildRoomWalletTransferUri } from './buildRoomWalletTransferUri.js';
const now = Date.now();
const payment = { paymentAcceptanceEnabled: true, status: 'AWAITING_PAYMENT', network: 'testnet', asset: 'TON', amountAtomic: 1000000000, paymentReference: 'WW_test', expiresAt: now + 60000, destinationWalletAddress: '0:' + '11'.repeat(32), payerAddress: '0:' + '22'.repeat(32) };
for (const amount of [1000000000, 2500000000, 10000000000, 25000000000]) {
    const uri = new URL(buildRoomWalletTransferUri({ ...payment, amountAtomic: amount }, now));
    assert.equal(uri.protocol, 'ton:');
    assert.equal(uri.hostname, 'transfer');
    assert.match(uri.pathname, /^\/0Q/);
    assert.equal(uri.searchParams.get('amount'), String(amount));
    assert.equal(uri.searchParams.get('text'), 'WW1:WW_test');
}
assert.throws(() => buildRoomWalletTransferUri(payment, payment.expiresAt));
assert.throws(() => buildRoomWalletTransferUri({ ...payment, amountAtomic: 0 }, now));
assert.throws(() => buildRoomWalletTransferUri({ ...payment, status: 'SETTLED' }, now));
console.log('Transfer URI amounts, memo, Testnet address and expiry checks passed');
