import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
    AUTHORITATIVE_SESSION_ACTIONS,
    AUTHORITATIVE_SESSION_INITIAL_STATE,
    authoritativeSessionReducer
} from "./authoritativeSessionModel.js";
import {
    canSubmitEntryPayment,
    PAGE4_PAYMENT_PHASE,
    resolveEntryPaymentComponents,
    resolvePage4PaymentPhase,
    shouldShowEntryAction,
    shouldShowWalletActions
} from "./page4PaymentPhase.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE4_SOURCE = readFileSync(
    join(HERE, "../../pages/Page4Payment.jsx"),
    "utf8"
);

test("Page4 uses the authoritative Room Wallet payment flow", () => {

    assert.match(PAGE4_SOURCE, /resolvePage4PaymentPhase/);
    assert.match(PAGE4_SOURCE, /canSubmitEntryPayment/);
    assert.match(PAGE4_SOURCE, /buildEntryPaymentTransaction/);
    assert.doesNotMatch(PAGE4_SOURCE, /gameContract/);
    assert.doesNotMatch(PAGE4_SOURCE, /GameEscrow/);
    assert.doesNotMatch(PAGE4_SOURCE, /onNavigate\(7\)/);

});

test("Room Wallet payment session enables the entry payment action", () => {

    const paymentSession = {
        status: "WAITING_FOR_PAYMENTS",
        roomWalletAddress: "EQDROOMWALLET",
        participants: [{
            playerId: "p1",
            status: "AWAITING_PLAYER_CONFIRMATION",
            playerIndex: 0,
            requiredGram: 1
        }]
    };

    const phase = resolvePage4PaymentPhase({
        paymentSession,
        localPlayerId: "p1"
    });

    assert.equal(phase, PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT);
    assert.equal(shouldShowEntryAction(phase), true);
    assert.equal(shouldShowWalletActions(phase), false);
    assert.equal(
        canSubmitEntryPayment({
            paymentSession,
            localPlayerId: "p1"
        }),
        true
    );

    const components = resolveEntryPaymentComponents({
        paymentSession,
        localPlayerId: "p1"
    });

    assert.equal(components.includeDeploy, false);
    assert.equal(components.includeFund, false);
    assert.equal(components.includeStake, true);

});

test("Fully paid session waits for authoritative Page5 transition", () => {

    const phase = resolvePage4PaymentPhase({
        paymentSession: {
            status: "FULLY_PAID",
            roomWalletAddress: "EQDROOMWALLET",
            participants: []
        },
        localPlayerId: "p1"
    });

    assert.equal(phase, PAGE4_PAYMENT_PHASE.WAITING_PAGE5);

});

test("Authoritative session retains Room Wallet destination and contains no game contract state", () => {

    const state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_SESSION_CREATED,
            payload: {
                roomId: "7NZU",
                gameId: "game_1",
                paymentSessionId: "pay_1",
                network: "testnet",
                roomWalletAddress: "EQDROOMWALLET",
                status: "WAITING_FOR_PAYMENTS",
                participants: [{
                    playerId: "p1",
                    playerIndex: 0,
                    requiredGram: 1,
                    status: "AWAITING_PLAYER_CONFIRMATION",
                    paidAmount: 0,
                    confirmationStatus: "NONE"
                }]
            }
        }
    );

    assert.equal(state.paymentSession.roomWalletAddress, "EQDROOMWALLET");
    assert.equal(state.paymentSession.participants[0].requiredGram, 1);
    assert.equal("gameContract" in state, false);

});
