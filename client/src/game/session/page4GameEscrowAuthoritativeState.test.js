/**
 * R18-S66 — kEo2 forensic: Page4 must follow PaymentSession + Game Escrow
 * state, not a leftover Deposit/Creator gate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    AUTHORITATIVE_SESSION_ACTIONS,
    AUTHORITATIVE_SESSION_INITIAL_STATE,
    authoritativeSessionReducer,
    unwrapAuthoritativeSocketRecord
} from "./authoritativeSessionModel.js";
import { canConfirmLocalPayment } from "./authoritativePaymentSessionView.js";
import { isGameContractDeployed } from "./authoritativeGameContractView.js";
import {
    canSubmitEntryPayment,
    isGameEscrowOnlyPlayerPayment,
    PAGE4_PAYMENT_PHASE,
    resolveEntryPaymentComponents,
    resolvePage4PaymentPhase,
    shouldShowEntryAction,
    shouldShowWaitingCreatorDeposit
} from "./page4PaymentPhase.js";

const KEO2_ROOM = "kEo2";
const KEO2_GAME = "game_4976ed6a-8736-4ec5-81c4-d5f619e44500";
const KEO2_ESCROW = "EQBmvptdvJ5h1WqJy8Fy3Mf0F1rtowikZ8cVWjAtfYnBabpx";

const PLAYERS = [
    { playerId: "player_olga", playerIndex: 0 },
    { playerId: "player_lena", playerIndex: 1 },
    { playerId: "player_bob", playerIndex: 2 }
];

function keo2ContractSnapshot() {

    return {
        contractId: "contract_keo2",
        roomId: KEO2_ROOM,
        gameId: KEO2_GAME,
        status: "AWAITING_PLAYER_PAYMENTS",
        contractAddress: KEO2_ESCROW,
        escrowMode: "game"
    };

}

function keo2PaymentSnapshot() {

    return {
        paymentSessionId: "pay_keo2",
        roomId: KEO2_ROOM,
        gameId: KEO2_GAME,
        status: "WAITING_FOR_PAYMENTS",
        participants: PLAYERS.map((player) => ({
            playerId: player.playerId,
            playerIndex: player.playerIndex,
            requiredGram: 1,
            status: "AWAITING_PLAYER_CONFIRMATION",
            contractAddress: KEO2_ESCROW
        }))
    };

}

function leftoverDeposit() {

    return {
        phase: "AWAITING_FUNDS",
        depositId: "dep_previous_room",
        depositAddress: "EQDstaleDepositFromPreviousRoom",
        roomId: "f6iJ",
        gameId: "game_previous",
        isCreator: false,
        mySeatIndex: 1,
        myExpectedAmountNanotons: 11000000,
        package: {
            stateInit: { codeBoc: "code", dataBoc: "data" },
            deployValueNanotons: 11000000
        }
    };

}

function ingestKeo2(state, { nestedContract = false } = {}) {

    let next = authoritativeSessionReducer(state, {
        type: AUTHORITATIVE_SESSION_ACTIONS.SETUP_SESSION,
        payload: {
            setupSessionId: "setup_keo2",
            roomId: KEO2_ROOM,
            startedAt: 1,
            expiresAt: 2
        }
    });

    const contractPayload = nestedContract
        ? {
            type: "GAME_CONTRACT_UPDATED",
            payload: keo2ContractSnapshot()
        }
        : keo2ContractSnapshot();

    next = authoritativeSessionReducer(next, {
        type: AUTHORITATIVE_SESSION_ACTIONS.GAME_CONTRACT_UPDATED,
        payload: contractPayload
    });

    next = authoritativeSessionReducer(next, {
        type: AUTHORITATIVE_SESSION_ACTIONS.PAYMENT_SESSION_UPDATED,
        payload: keo2PaymentSnapshot()
    });

    return next;

}

function page4View(state, localPlayerId) {

    const gameContract = state.gameContract;
    const paymentSession = state.paymentSession;
    const deposit = state.deposit;
    const context = {
        deposit,
        paymentSession,
        roomId: state.roomId,
        gameId: state.gameId
    };
    const localParticipant = paymentSession?.participants?.find(
        (participant) => String(participant.playerId) === String(localPlayerId)
    ) ?? null;
    const phase = resolvePage4PaymentPhase({
        deposit,
        paymentSession,
        gameContract,
        localPlayerId,
        paymentConnectionReady: true
    });

    return {
        hasGameContract: Boolean(gameContract),
        escrowMode: gameContract?.escrowMode ?? null,
        contractStatus: gameContract?.status ?? null,
        contractDeployed: isGameContractDeployed(gameContract),
        hasPaymentSession: Array.isArray(paymentSession?.participants)
            && paymentSession.participants.length === 3,
        localPlayerMatched: Boolean(localParticipant),
        localStatus: localParticipant?.status ?? null,
        canConfirm: canConfirmLocalPayment(paymentSession, localPlayerId),
        gameEscrowOnly: isGameEscrowOnlyPlayerPayment(gameContract, context),
        phase,
        showPay: shouldShowEntryAction(phase),
        showWaitingCreatorDeposit: shouldShowWaitingCreatorDeposit({
            paymentPhase: phase,
            gameContract,
            deposit,
            paymentSession
        }),
        components: resolveEntryPaymentComponents({
            deposit,
            paymentSession,
            gameContract,
            localPlayerId
        }),
        canSubmit: canSubmitEntryPayment({
            deposit,
            paymentSession,
            gameContract,
            localPlayerId
        })
    };

}

test("R18-S66: unwrap nested GAME_CONTRACT envelope so escrowMode is authoritative", () => {

    const snapshot = keo2ContractSnapshot();
    const unwrapped = unwrapAuthoritativeSocketRecord({
        type: "GAME_CONTRACT_UPDATED",
        payload: snapshot
    });

    assert.equal(unwrapped.escrowMode, "game");
    assert.equal(unwrapped.status, "AWAITING_PLAYER_PAYMENTS");
    assert.equal(unwrapped.contractAddress, KEO2_ESCROW);

    const state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.GAME_CONTRACT_UPDATED,
            payload: {
                type: "GAME_CONTRACT_UPDATED",
                payload: snapshot
            }
        }
    );

    assert.equal(state.gameContract.escrowMode, "game");
    assert.equal(state.gameContract.status, "AWAITING_PLAYER_PAYMENTS");
    assert.equal(state.gameContract.contractAddress, KEO2_ESCROW);

});

test("R18-S66: leftover Deposit from another room is dropped for kEo2 Game Escrow", () => {

    let state = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
            payload: {
                roomId: "f6iJ",
                gameId: "game_previous",
                deposit: leftoverDeposit()
            }
        }
    );

    assert.equal(state.deposit.depositId, "dep_previous_room");

    state = ingestKeo2(state);

    assert.equal(state.roomId, KEO2_ROOM);
    assert.equal(state.deposit, null);
    assert.equal(state.gameContract.escrowMode, "game");
    assert.equal(state.paymentSession.participants.length, 3);

});

test("R18-S66: kEo2 Page4 is PAY for every player, never Creator Deposit wait", () => {

    const withLeftover = authoritativeSessionReducer(
        AUTHORITATIVE_SESSION_INITIAL_STATE,
        {
            type: AUTHORITATIVE_SESSION_ACTIONS.DEPOSIT_PACKAGE_PUBLISHED,
            payload: {
                roomId: "f6iJ",
                gameId: "game_previous",
                deposit: leftoverDeposit()
            }
        }
    );
    const state = ingestKeo2(withLeftover, { nestedContract: true });

    for (const player of PLAYERS) {

        const view = page4View(state, player.playerId);

        assert.equal(view.hasGameContract, true);
        assert.equal(view.escrowMode, "game");
        assert.equal(view.contractStatus, "AWAITING_PLAYER_PAYMENTS");
        assert.equal(view.contractDeployed, true);
        assert.equal(view.hasPaymentSession, true);
        assert.equal(view.localPlayerMatched, true);
        assert.equal(view.localStatus, "AWAITING_PLAYER_CONFIRMATION");
        assert.equal(view.canConfirm, true);
        assert.equal(view.gameEscrowOnly, true);
        assert.equal(view.phase, PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT);
        assert.equal(view.showPay, true);
        assert.equal(view.showWaitingCreatorDeposit, false);
        assert.equal(view.canSubmit, true);
        assert.deepEqual(view.components, {
            includeDeploy: false,
            includeFund: false,
            includeStake: true
        });
        assert.equal(view.components.includeFund, false);

    }

    const creator = page4View(state, "player_olga");
    const joiner = page4View(state, "player_bob");

    assert.equal(creator.canSubmit, joiner.canSubmit);
    assert.equal(creator.showPay, joiner.showPay);
    assert.deepEqual(creator.components, joiner.components);

});

test("R18-S66: v4 Deposit wait remains when escrowMode is v4", () => {

    const deposit = leftoverDeposit();
    deposit.roomId = "v4room";
    deposit.gameId = "game_v4";
    deposit.isCreator = false;

    const phase = resolvePage4PaymentPhase({
        deposit,
        paymentSession: {
            status: "WAITING_FOR_PAYMENTS",
            roomId: "v4room",
            participants: [{
                playerId: "p1",
                status: "AWAITING_PLAYER_CONFIRMATION",
                requiredGram: 0.01,
                contractAddress: "EQG"
            }]
        },
        gameContract: {
            escrowMode: "v4",
            status: "AWAITING_PLAYER_PAYMENTS",
            contractAddress: "EQG",
            roomId: "v4room"
        },
        localPlayerId: "p1"
    });

    assert.equal(
        shouldShowWaitingCreatorDeposit({
            paymentPhase: PAGE4_PAYMENT_PHASE.DEPOSIT_ACTIVATION,
            gameContract: { escrowMode: "v4", roomId: "v4room" },
            deposit,
            paymentSession: { roomId: "v4room" }
        }),
        true
    );
    assert.notEqual(phase, PAGE4_PAYMENT_PHASE.ENTRY_PAYMENT);

});
