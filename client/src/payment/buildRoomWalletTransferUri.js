import { buildRoomWalletTonConnectRequest } from './buildRoomWalletTonConnectRequest.js';

export function buildRoomWalletTransferUri(payment, now = Date.now()) {
    const request = buildRoomWalletTonConnectRequest(payment, now);
    const message = request.messages[0];
    const query = new URLSearchParams({
        amount: message.amount,
        text: `WW1:${payment.paymentReference}`
    });
    return `ton://transfer/${message.address}?${query}`;
}
