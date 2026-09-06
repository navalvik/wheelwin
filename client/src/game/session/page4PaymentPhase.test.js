import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isGameContractDeployed } from "./authoritativeGameContractView.js";
import {
    canDeployDeposit,
    canFundSeat,
    canStakeGameEscrow,
    canSubmitEntryPayment,
    isDepositActivationVerified,
    isDepositFull,
    isGameEscrowOnlyPlayerPayment,
    PAGE4_PAYMENT_PHASE,
    resolveEntryPaymentComponents,
    resolvePage4PaymentPhase,
    shouldShowDepositAction,
    shouldShowEntryAction,
    shouldShowWalletActions
} from "./page4PaymentPhase.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE4_SOURCE = readFileSync(
    join(HERE, "../../pages/Page4Payment.jsx"),
    "utf8"
);

function depositFixture(overrides = {}) {

    return {
        phase: "AWAITING_FUNDS",
        depositId: "dep_1",
        depositAddress: "EQDdeposit",
        network: "testnet",
        package: {
            stateInit: { codeBoc: "code", dataBoc: "data" },
            deployValueNanotons: 11000000
        },
        mySeatIndex: 1,
        isCreator: false,
        mySeatStatus: "PENDING",
        myExpectedAmountNanotons: 11000000,
        confirmedSeats: 0,
        activationStatus: null,
        ...overrides
    };

}

test("R18-S16: Page4 declares language/TonConnect hooks before Deposit handler", () => {

    const languageHook = PAGE4_SOURCE.indexOf("const { t } = useLanguage()");
    const tonConnectHook = PAGE4_SOURCE.indexOf("const [tonConnectUI] = useTonConnectUI()");
    const walletHook = PAGE4_SOURCE.indexOf("const tonWallet = useTonWallet()");
    const depositHandler = PAGE4_SOURCE.indexOf("const handleConfirmInTelegramWallet");

    assert.ok(languageHook !== -1 && tonConnectHook !== -1 && walletHook !== -1);
    assert.ok(depositHandler !== -1);
    assert.ok(
        languageHook < depositHandler
        && tonConnectHook < depositHandler
        && walletHook < depositHandler,
        "Deposit handler must be declared after t / tonConnectUI / tonWallet"
    );
    assert.match(PAGE4_SOURCE, /nextEnabled=\{false\}/);
    assert.match(PAGE4_SOURCE, /resolvePage4PaymentPhase/);
    assert.match(PAGE4_SOURCE, /canSubmitEntryPayment/);
    assert.match(PAGE4_SOURCE, /buildEntryPaymentTransaction/);
    assert.doesNotMatch(PAGE4_SOURCE, /onNavigate\(7\)/);
    assert.doesNotMatch(PAGE4_SOURCE, /setTimeout\s*\([^)]*onNavigate/);
    assert.doesNotMatch(PAGE4_SOURCE, /hasPaid\s*=/);

});

test("R18-S16: PAYMENT_CONNECTION_READY does not select GameEscrow STAKE", () => {

    const phase = resolvePage4PaymentPhase({
        paymentConnectionReady: true,
        paymentSession: {
            status: "WAITING_FOR_PAYMENTS",
            participants: [{ playerId: "p1", status: "WAITING" }]
        },
        localPlayerId: "p1"
    });

    assert.equal(phase, PAGE4_PAYMENT_PHASE.DEPOSIT_ACTIVATION);
    assert.equal(shouldShowWalletActions(phase), false);
    assert.equal(phase === PAGE4_PAYMENT_PHASE.GAMEESCROW_STAKE, false);

});

test("R18-S16: creator deploy requires isCreator and package, not seatIndex===0 locally", () => {

    assert.equal(
        canDeployDeposit(depositFixture({
            isCreator: true,
            mySeatIndex: 0
        })),
        true
    );
    assert.equal(
        canDeployDeposit(depositFixture({
            isCreator: false,
            mySeatIndex: 0
        })),
        false
    );
    assert.equal(
        canDeployDeposit(depositFixture({
            isCreator: true,
            activationStatus: "VERIFIED"
        })),
        false
    );

});

test("R18-S16: FundSeat disabled before DEPOSIT_ACTIVATION_VERIFIED", () => {

    const pending = depositFixture({ activationStatus: null });

    assert.equal(isDepositActivationVerified(pending), false);
    assert.equal(canFundSeat(pending), false);

    const verified = depositFixture({ activationStatus: "VERIFIED" });

    assert.equal(isDepositActivationVerified(verified), true);
    assert.equal(canFundSeat(verified), true);
    assert.equal(verified.mySeatIndex, 1);
    assert.equal(verified.myExpectedAmountNanotons, 11000000);
    assert.equal(
        canFundSeat(depositFixture({
            activationStatus: "VERIFIED",
            mySeatStatus: "FUNDED"
        })),
        false
    );
    assert.equal(
        canFundSeat(null, { depositActivationVerified: true }),
        false
    );
    assert.equal(
        canFundSeat(
            depositFixture({ activationStatus: null }),
            { depositActivationVerified: true }
        ),
        true
    );

});

test("R18-S16: FundSeat uses authoritative mySeatIndex and amount", () => {

    const deposit = depositFixture({
        activationStatus: "ALREADY_VERIFIED",
        mySeatIndex: 2,
        myExpectedAmountNanotons: 22000000
    });

    assert.equal(canFundSeat(deposit), true);
    assert.equal(deposit.mySeatIndex, 2);
    assert.equal(deposit.myExpectedAmountNanotons, 22000000);
    assert.equal(
        canFundSeat(depositFixture({
            activationStatus: "VERIFIED",
            mySeatIndex: null
        })),
        false
    );

});

test("R18-S16: Deposit completion is server phase / confirmedSeats, not a local counter", () => {

    assert.equal(isDepositFull(depositFixture({ confirmedSeats: 2 })), false);
    assert.equal(
        isDepositFull(depositFixture({ phase: "DEPOSIT_FULL", confirmedSeats: 3 })),
        true
    );
    assert.equal(
        resolvePage4PaymentPhase({
            deposit: depositFixture({ phase: "DEPOSIT_FULL", confirmedSeats: 3 })
        }),
        PAGE4_PAYMENT_PHASE.DEPOSIT_FULL
    );

});

test("R18-S16: GameEscrow STAKE only after GameEscrow deployed", () => {

    assert.equal(
        isGameContractDeployed({ status: "DEPLOYED", contractAddress: "EQG" }),
        true
    );

    const stakePhase = resolvePage4PaymentPhase({
        deposit: depositFixture({
            phase: "DEPOSIT_FULL",
            confirmedSeats: 3,
            activationStatus: "VERIFIED"
        }),
        gameContract: {
            status: "AWAITING_PLAYER_PAYMENTS",
            contractAddress: "EQG"
        },
        paymentSession: {
            status: "WAITING_FOR_PAYMENTS",
            participants: [{
                playerId: "p1",
                status: "AWAITING_PLAYER_CONFIRMATION",
                playerIndex: 1
            }]
        },
        localPlayerId: "p1"
    });

    assert.equal(stakePhase, PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT);
    assert.equal(shouldShowEntryAction(stakePhase), true);
    assert.equal(
        canStakeGameEscrow({
            paymentSession: {
                status: "WAITING_FOR_PAYMENTS",
                participants: [{
                    playerId: "p1",
                    status: "AWAITING_PLAYER_CONFIRMATION"
                }]
            },
            gameContract: { status: "AWAITING_PLAYER_PAYMENTS", contractAddress: "EQG" },
            localPlayerId: "p1"
        }),
        true
    );
    assert.equal(
        canStakeGameEscrow({
            paymentSession: {
                status: "WAITING_FOR_PAYMENTS",
                participants: [{
                    playerId: "p1",
                    status: "AWAITING_PLAYER_CONFIRMATION"
                }]
            },
            gameContract: { status: "CREATING" },
            localPlayerId: "p1"
        }),
        false
    );

});

test("R18-S16: COMPLETED waits for OPEN_PAGE5 and does not imply local navigation", () => {

    assert.equal(
        resolvePage4PaymentPhase({
            paymentSession: { status: "COMPLETED", participants: [{ playerId: "p1" }] },
            gameContract: { status: "PAYMENTS_COMPLETE", contractAddress: "EQG" },
            localPlayerId: "p1"
        }),
        PAGE4_PAYMENT_PHASE.WAITING_PAGE5
    );

});

test("R18-S16: rehydrated 2/3 FUNDED projection disables canFundSeat", () => {

    const staleZeroOfThree = depositFixture({
        activationStatus: "VERIFIED",
        mySeatStatus: "PENDING",
        confirmedSeats: 0,
        myExpectedAmountNanotons: 11000000
    });

    assert.equal(canFundSeat(staleZeroOfThree), true);

    const rehydrated = depositFixture({
        activationStatus: "VERIFIED",
        mySeatStatus: "FUNDED",
        confirmedSeats: 2,
        myExpectedAmountNanotons: 11000000,
        phase: "PARTIALLY_FUNDED"
    });

    assert.equal(canFundSeat(rehydrated), false);
    assert.equal(
        resolvePage4PaymentPhase({ deposit: rehydrated }),
        PAGE4_PAYMENT_PHASE.DEPOSIT_WAIT_FULL
    );

});

test("R18-S16: reconnect restores phase from deposit activationStatus", () => {

    assert.equal(
        resolvePage4PaymentPhase({
            deposit: depositFixture({
                activationStatus: "VERIFIED",
                mySeatStatus: "PENDING"
            })
        }),
        PAGE4_PAYMENT_PHASE.FUND_SEAT
    );
    assert.equal(
        resolvePage4PaymentPhase({
            deposit: depositFixture({
                activationStatus: "VERIFIED",
                mySeatStatus: "FUNDED",
                confirmedSeats: 1
            })
        }),
        PAGE4_PAYMENT_PHASE.DEPOSIT_WAIT_FULL
    );

});

test("R18-S16 tSPj: production package without deployValueNanotons stays in DEPOSIT_ACTIVATION", () => {

    const tspjShaped = depositFixture({
        isCreator: true,
        mySeatIndex: 0,
        activationStatus: "WAITING_FOR_PLAYER_DEPLOYMENT",
        myExpectedAmountNanotons: 11000000,
        confirmedSeats: 0,
        package: {
            stateInit: { codeBoc: "code", dataBoc: "data" },
            deployValueNanotons: null
        }
    });

    assert.equal(canDeployDeposit(tspjShaped), false);
    assert.equal(canFundSeat(tspjShaped), false);

    const phase = resolvePage4PaymentPhase({
        deposit: tspjShaped,
        paymentConnectionReady: true
    });

    assert.equal(phase, PAGE4_PAYMENT_PHASE.DEPOSIT_ACTIVATION);
    assert.equal(shouldShowDepositAction(phase), false);
    assert.equal(shouldShowWalletActions(phase), false);

});

test("R18-S16: creator deploy proceeds only from authoritative package deployValueNanotons", () => {

    const withDeployValue = depositFixture({
        isCreator: true,
        mySeatIndex: 0,
        activationStatus: "WAITING_FOR_PLAYER_DEPLOYMENT",
        myExpectedAmountNanotons: 11000000,
        package: {
            stateInit: { codeBoc: "code", dataBoc: "data" },
            deployValueNanotons: 10000000
        }
    });

    assert.equal(canDeployDeposit(withDeployValue), true);

    const phase = resolvePage4PaymentPhase({ deposit: withDeployValue });

    assert.equal(phase, PAGE4_PAYMENT_PHASE.DEPOSIT_ACTIVATION);
    assert.equal(shouldShowDepositAction(phase), false);
    assert.equal(canDeployDeposit(withDeployValue), true);
    assert.equal(
        withDeployValue.package.deployValueNanotons,
        10000000,
        "amount must remain the package field, not a client reconstruction"
    );
    assert.notEqual(
        withDeployValue.package.deployValueNanotons,
        withDeployValue.myExpectedAmountNanotons,
        "deploy attach must not equal FundSeat expectedAmount"
    );
    assert.notEqual(
        withDeployValue.package.deployValueNanotons,
        1000000,
        "deploy attach must not equal creationFeePerSeat"
    );

});

function paymentReady(playerId, playerIndex) {

    return {
        status: "WAITING_FOR_PAYMENTS",
        participants: [{
            playerId,
            status: "AWAITING_PLAYER_CONFIRMATION",
            playerIndex,
            requiredGram: 0.01,
            contractAddress: "EQG"
        }]
    };

}

const gameEscrowReady = {
    status: "AWAITING_PLAYER_PAYMENTS",
    contractAddress: "EQG"
};

test("R18-S16: creator one-wallet entry after GameEscrow is deployed", () => {

    const deposit = depositFixture({
        isCreator: true,
        mySeatIndex: 0,
        activationStatus: "WAITING_FOR_PLAYER_DEPLOYMENT",
        myExpectedAmountNanotons: 11000000,
        package: {
            stateInit: { codeBoc: "code", dataBoc: "data" },
            deployValueNanotons: 10000000
        }
    });

    assert.equal(
        canSubmitEntryPayment({
            deposit,
            paymentSession: paymentReady("p0", 0),
            gameContract: gameEscrowReady,
            localPlayerId: "p0"
        }),
        true
    );

    const phase = resolvePage4PaymentPhase({
        deposit,
        paymentSession: paymentReady("p0", 0),
        gameContract: gameEscrowReady,
        localPlayerId: "p0"
    });

    assert.equal(phase, PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT);
    assert.equal(shouldShowEntryAction(phase), true);

});

test("R18-S16: player 2/3 one-wallet entry requires verified deposit", () => {

    const unverified = depositFixture({
        isCreator: false,
        mySeatIndex: 1,
        activationStatus: null
    });

    assert.equal(
        canSubmitEntryPayment({
            deposit: unverified,
            paymentSession: paymentReady("p1", 1),
            gameContract: gameEscrowReady,
            localPlayerId: "p1"
        }),
        false
    );

    const verified = depositFixture({
        isCreator: false,
        mySeatIndex: 2,
        activationStatus: "VERIFIED"
    });

    assert.equal(
        canSubmitEntryPayment({
            deposit: verified,
            paymentSession: paymentReady("p2", 2),
            gameContract: gameEscrowReady,
            localPlayerId: "p2"
        }),
        true
    );

    assert.equal(
        resolvePage4PaymentPhase({
            deposit: verified,
            paymentSession: paymentReady("p2", 2),
            gameContract: gameEscrowReady,
            localPlayerId: "p2"
        }),
        PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT
    );

    assert.equal(
        shouldShowEntryAction(PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT),
        true
    );

});


test("R18-S16: Page4 entry handler sends one TonConnect transaction", () => {

    const sendMatches = PAGE4_SOURCE.match(/tonConnectUI\.sendTransaction/g) ?? [];

    assert.equal(
        sendMatches.length,
        1,
        "Page4 must have exactly one sendTransaction call"
    );
    assert.match(PAGE4_SOURCE, /buildEntryPaymentTransaction/);
    assert.match(PAGE4_SOURCE, /PAYMENT_CONFIRM_INTENT/);
    assert.match(
        PAGE4_SOURCE,
        /const \{ totalNanotons, \.\.\.tonConnectTransaction \} = transactionObject/
    );
    assert.match(
        PAGE4_SOURCE,
        /tonConnectUI\.sendTransaction\(tonConnectTransaction\)/
    );
    assert.doesNotMatch(
        PAGE4_SOURCE,
        /tonConnectUI\.sendTransaction\(transactionObject\)/
    );

});

test("R18-S63: GameEscrow-only Page4 is creator-neutral STAKE payment", () => {

    assert.match(PAGE4_SOURCE, /isGameEscrowOnlyPlayerPayment/);
    assert.match(PAGE4_SOURCE, /includeFund: gameEscrowOnly \? false/);
    assert.match(PAGE4_SOURCE, /includeDeploy: gameEscrowOnly \? false/);

    const gameContract = {
        escrowMode: "game",
        status: "AWAITING_PLAYER_PAYMENTS",
        contractAddress: "EQBescrow"
    };

    assert.equal(isGameEscrowOnlyPlayerPayment(gameContract), true);

    const paymentSession = {
        status: "WAITING_FOR_PAYMENTS",
        participants: [
            {
                playerId: "lena",
                status: "AWAITING_PLAYER_CONFIRMATION",
                requiredGram: 1
            },
            {
                playerId: "bob",
                status: "AWAITING_PLAYER_CONFIRMATION",
                requiredGram: 1
            },
            {
                playerId: "olga",
                status: "AWAITING_PLAYER_CONFIRMATION",
                requiredGram: 1
            }
        ]
    };

    const creatorDeposit = depositFixture({ isCreator: true, mySeatIndex: 0 });
    const joinerDeposit = depositFixture({ isCreator: false, mySeatIndex: 1 });

    for (const [playerId, deposit] of [
        ["lena", creatorDeposit],
        ["bob", joinerDeposit],
        ["olga", joinerDeposit]
    ]) {

        const components = resolveEntryPaymentComponents({
            deposit,
            paymentSession,
            gameContract,
            localPlayerId: playerId
        });

        assert.equal(components.includeDeploy, false);
        assert.equal(components.includeFund, false);
        assert.equal(components.includeStake, true);
        assert.equal(
            canSubmitEntryPayment({
                deposit,
                paymentSession,
                gameContract,
                localPlayerId: playerId
            }),
            true
        );
        assert.equal(
            resolvePage4PaymentPhase({
                deposit,
                paymentSession,
                gameContract,
                localPlayerId: playerId
            }),
            PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT
        );

    }

    assert.equal(
        canSubmitEntryPayment({
            deposit: creatorDeposit,
            paymentSession,
            gameContract,
            localPlayerId: "lena"
        }),
        canSubmitEntryPayment({
            deposit: joinerDeposit,
            paymentSession,
            gameContract,
            localPlayerId: "bob"
        })
    );

});

