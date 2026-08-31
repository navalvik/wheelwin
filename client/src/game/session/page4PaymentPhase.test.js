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
    isDepositActivationVerified,
    isDepositFull,
    PAGE4_PAYMENT_PHASE,
    resolvePage4PaymentPhase,
    shouldShowDepositAction,
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
    assert.match(PAGE4_SOURCE, /canDeployDeposit/);
    assert.match(PAGE4_SOURCE, /canFundSeat/);
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

    assert.equal(stakePhase, PAGE4_PAYMENT_PHASE.GAMEESCROW_STAKE);
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
        package: {
            stateInit: { codeBoc: "code", dataBoc: "data" },
            deployValueNanotons: 50000000
        }
    });

    assert.equal(canDeployDeposit(withDeployValue), true);

    const phase = resolvePage4PaymentPhase({ deposit: withDeployValue });

    assert.equal(phase, PAGE4_PAYMENT_PHASE.DEPOSIT_DEPLOY);
    assert.equal(shouldShowDepositAction(phase), true);
    assert.equal(
        withDeployValue.package.deployValueNanotons,
        50000000,
        "amount must remain the package field, not a client reconstruction"
    );

});

