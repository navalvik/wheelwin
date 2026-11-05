import assert from "node:assert/strict";
import process from "node:process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    getMainnetPlayerPaymentStatus,
    mergeMainnetPaymentStatus,
    normalizeMainnetPaymentRequest,
    runMainnetPaymentAction
} from "../payment/mainnetPaymentRequest.js";
import { payerMatchesConnectedWallet } from "../payment/buildRoomWalletTonConnectRequest.js";
import { PAYMENT_SUBMISSION_PENDING_STATE, submissionAttemptIsActive } from "../payment/paymentStatusRequest.js";

const now = 1_800_000_000_000;
const roomId = "CPGJ";
const playerId = "player-1";
const payerAddress = "0:" + "11".repeat(32);
const destinationWalletAddress = "0:" + "22".repeat(32);
const paymentRequest = normalizeMainnetPaymentRequest({
    roomId, playerId, paymentReference: "cpgj-player-1", payerAddress,
    destinationWalletAddress, amountAtomic: "1000000000", asset: "TON",
    network: "mainnet", expiresAt: now + 60_000
}, { roomId, playerId, paymentAcceptanceEnabled: true, now });
assert.ok(paymentRequest, "fixture is a valid server-issued Mainnet request");

function clickMainnet({ requestValid = true, connectedWallet = null, walletMatches = false,
    sending = false, sentToWallet = false } = {}) {
    let modalOpenCount = 0;
    let sendCount = 0;
    const result = runMainnetPaymentAction({ requestValid, connectedWallet, walletMatches,
        sending, sentToWallet,
        openWalletModal: () => { modalOpenCount += 1; },
        submitPayment: () => { sendCount += 1; } });
    return { result, modalOpenCount, sendCount };
}

// A: no wallet opens selection, but cannot send.
assert.deepEqual(clickMainnet(), { result: "SELECT_WALLET", modalOpenCount: 1, sendCount: 0 });

// B: wrong wallet/address or chain opens selection; only matching Mainnet can submit.
const foreignWallet = { account: { address: "0:" + "33".repeat(32), chain: "-239" } };
const testnetWallet = { account: { address: payerAddress, chain: "-3" } };
assert.equal(payerMatchesConnectedWallet(payerAddress, foreignWallet, "mainnet"), false);
assert.equal(payerMatchesConnectedWallet(payerAddress, testnetWallet, "mainnet"), false);
assert.deepEqual(clickMainnet({ connectedWallet: foreignWallet }), { result: "SELECT_WALLET", modalOpenCount: 1, sendCount: 0 });
assert.deepEqual(clickMainnet({ connectedWallet: testnetWallet }), { result: "SELECT_WALLET", modalOpenCount: 1, sendCount: 0 });
assert.deepEqual(clickMainnet({ connectedWallet: { account: { address: payerAddress, chain: "-239" } }, walletMatches: true }),
    { result: "SUBMIT", modalOpenCount: 0, sendCount: 1 });

// C: status-only update preserves the request for the same identity.
let state = { ...paymentRequest, status: "AWAITING_PAYMENT", playerPaymentStatuses: [] };
const statusOnly = { roomId, playerId, status: "AWAITING_PAYMENT", paymentAcceptanceEnabled: true,
    network: "mainnet", confirmedCount: 0, requiredCount: 3 };
state = mergeMainnetPaymentStatus(state, statusOnly, { roomId, playerId, now });
for (const field of ["paymentReference", "payerAddress", "destinationWalletAddress", "amountAtomic"]) {
    assert.equal(state[field], paymentRequest[field], `status update preserves ${field}`);
}
assert.equal(state.status, "AWAITING_PAYMENT");
assert.equal(state.paymentAcceptanceEnabled, true);
assert.ok(normalizeMainnetPaymentRequest({ ...state, amountAtomic: String(state.amountAtomic) },
    { roomId, playerId, paymentAcceptanceEnabled: true, now }));

// D: repeated status updates keep the request and the existing submission lock.
state = mergeMainnetPaymentStatus(state, statusOnly, { roomId, playerId, now });
state = mergeMainnetPaymentStatus(state, statusOnly, { roomId, playerId, now });
assert.equal(state.paymentReference, paymentRequest.paymentReference);
const storage = { getItem: (key) => key === `wheelwin:payment:${paymentRequest.paymentReference}`
    ? PAYMENT_SUBMISSION_PENDING_STATE : null };
assert.equal(submissionAttemptIsActive(storage, state.paymentReference), true);
assert.deepEqual(clickMainnet({ sentToWallet: true }), { result: "BLOCKED", modalOpenCount: 0, sendCount: 0 });

// E: explicit revocation, mismatched identity, and expiry invalidate the request.
const revoked = mergeMainnetPaymentStatus(state, { ...statusOnly, status: "PAYMENT_UNAVAILABLE",
    paymentAcceptanceEnabled: false }, { roomId, playerId, now });
assert.equal(revoked.paymentAcceptanceEnabled, false);
assert.equal(revoked.paymentReference, null);
assert.deepEqual(clickMainnet({ requestValid: false }), { result: "BLOCKED", modalOpenCount: 0, sendCount: 0 });
assert.equal(mergeMainnetPaymentStatus(state, statusOnly, { roomId: "other-room", playerId, now }).paymentReference, null);
assert.equal(mergeMainnetPaymentStatus(state, statusOnly, { roomId, playerId,
    now: paymentRequest.expiresAt }).paymentReference, null);
assert.equal(getMainnetPlayerPaymentStatus("SETTLED"), "Payment verified");
assert.equal(getMainnetPlayerPaymentStatus("PENDING"), "Waiting for payments");

// F: Testnet retains the previous direct status update and wallet-button contract.
const page4Source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../pages/Page4Payment.jsx"), "utf8");
assert.match(page4Source, /: payload;[\s\S]*setPayment\(nextPayment\)/);
assert.match(page4Source, /runMainnetPaymentAction\(\{[\s\S]*requestValid: mainnetRequestValid/);
assert.match(page4Source, /disabled=\{sending \|\| sentToWallet \|\| !mainnetRequestValid\}/,
    "Mainnet selector/payment action is enabled only for a valid request and no active attempt");
assert.match(page4Source, /payment\.paymentAcceptanceEnabled && !mainnetMode/);
assert.match(page4Source, /disabled=\{sending \|\| sentToWallet\}/);

// G: both networks use the same active-session polling effect. Mainnet's
// PAYMENT_STATUS_REQUEST is routed by RoomLobbyBridge through its Mainnet
// incoming-payment adapter; Page4 must not suppress the shared 3-second loop.
const pollingEffect = page4Source.match(
    /\/\/ Only an active Page4 with an unsettled payment requests observation\.[\s\S]*?(?=\n\s*const walletMatches)/
);
assert.ok(pollingEffect, "Page4 contains the shared payment-observation effect");
assert.match(pollingEffect[0], /if \(!roomId \|\| !playerId[\s\S]*payment\.paymentAcceptanceEnabled !== true/,
    "polling requires the active room, player, and enabled payment session");
assert.match(pollingEffect[0], /\[\"AWAITING_PAYMENT\", \"MATCHED\", \"AWAITING_CONFIRMATION\"\]/,
    "polling is limited to unsettled payment states");
assert.doesNotMatch(pollingEffect[0], /mainnetMode/,
    "Mainnet does not bypass the shared polling effect");
assert.match(pollingEffect[0], /socket\.connected && Date\.now\(\) < payment\.expiresAt/,
    "polling only requests status while connected and before expiry");
assert.match(pollingEffect[0], /const id = setInterval\(check, 3000\)/,
    "payment observation runs on the Testnet 3000 ms interval");
assert.match(pollingEffect[0], /return \(\) => clearInterval\(id\)/,
    "the effect clears its single interval on settlement or cleanup");
assert.equal((pollingEffect[0].match(/setInterval\(check, 3000\)/g) ?? []).length, 1,
    "there is exactly one polling interval in the effect");

process.stdout.write("mainnetPage4PaymentSession.test.js: scenarios A-G passed\n");

