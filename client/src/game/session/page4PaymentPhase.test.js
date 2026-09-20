import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
    canStakeGameEscrow,
    canSubmitEntryPayment,
    PAGE4_PAYMENT_PHASE,
    resolveEntryPaymentComponents,
    resolvePage4PaymentPhase,
    resolvePlayerPaymentDestination
} from "./page4PaymentPhase.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE4_SOURCE = readFileSync(
    join(HERE, "../../pages/Page4Payment.jsx"),
    "utf8"
);

function roomWalletSession(overrides = {}) {
    return {
        status: "WAITING_FOR_PAYMENTS",
        roomWalletAddress: "EQDroomWalletPayToXXXXXXXXXXXXXXXXXX",
        participants: [{
            playerId: "p1",
            status: "AWAITING_PLAYER_CONFIRMATION",
            playerIndex: 0,
            requiredGram: 1,
            contractAddress: "EQDlegacyMustNotBeUsedXXXXXXXXXXXXXXXX"
        }],
        ...overrides
    };
}

test("Page4 uses only the server-authoritative Room Wallet destination", () => {
    const paymentSession = roomWalletSession();

    assert.equal(
        resolvePlayerPaymentDestination({
            paymentSession,
            localPlayerId: "p1"
        }),
        paymentSession.roomWalletAddress
    );
});

test("Page4 never falls back to participant contractAddress", () => {
    const paymentSession = roomWalletSession({
        roomWalletAddress: null
    });

    assert.equal(
        resolvePlayerPaymentDestination({
            paymentSession,
            localPlayerId: "p1"
        }),
        null
    );

    assert.equal(
        canStakeGameEscrow({
            paymentSession,
            localPlayerId: "p1"
        }),
        false
    );
});

test("Room Wallet payment has no deploy/fund components", () => {
    const components = resolveEntryPaymentComponents({
        paymentSession: roomWalletSession(),
        gameContract: { escrowMode: "game", status: "AWAITING_PAYMENTS" },
        localPlayerId: "p1"
    });

    assert.deepEqual(components, {
        includeDeploy: false,
        includeFund: false,
        includeStake: true
    });
});

test("Page4 selects ENTRY_PAYMENT only when Room Wallet destination exists", () => {
    const paymentSession = roomWalletSession();

    assert.equal(
        resolvePage4PaymentPhase({
            paymentSession,
            gameContract: { escrowMode: "game", status: "AWAITING_PAYMENTS" },
            localPlayerId: "p1"
        }),
        PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT
    );

    assert.equal(
        canSubmitEntryPayment({
            paymentSession,
            gameContract: { escrowMode: "game", status: "AWAITING_PAYMENTS" },
            localPlayerId: "p1"
        }),
        true
    );
});

test("Page4 fails closed when the Room Wallet destination is missing", () => {
    const paymentSession = roomWalletSession({
        roomWalletAddress: null
    });

    assert.notEqual(
        resolvePage4PaymentPhase({
            paymentSession,
            gameContract: { escrowMode: "game", status: "AWAITING_PAYMENTS" },
            paymentConnectionReady: true,
            localPlayerId: "p1"
        }),
        PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT
    );

    assert.equal(
        canSubmitEntryPayment({
            paymentSession,
            gameContract: { escrowMode: "game", status: "AWAITING_PAYMENTS" },
            localPlayerId: "p1"
        }),
        false
    );
});

test("Page4 still has exactly one TonConnect sendTransaction path", () => {
    const sendMatches = PAGE4_SOURCE.match(/tonConnectUI\.sendTransaction/g) ?? [];
    assert.equal(sendMatches.length, 1);
    assert.match(PAGE4_SOURCE, /buildEntryPaymentTransaction/);
    assert.match(PAGE4_SOURCE, /resolvePlayerPaymentDestination/);
});

test("Page4 source contains no participant contractAddress payment fallback", () => {
    assert.doesNotMatch(
        PAGE4_SOURCE,
        /participant\?\.contractAddress/
    );
});
